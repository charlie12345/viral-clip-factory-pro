'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
    CompilationUploadError,
    createCompilationUploadManager,
    parseContentRange,
} = require('./compilation-upload-sessions');

function managerFixture(t, overrides = {}) {
    const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-large-upload-'));
    t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));
    const manager = createCompilationUploadManager({
        mediaRoot,
        maxFileBytes: 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
        chunkBytes: 4,
        ttlMs: 1000,
        reserveBytes: 1,
        statfsSync: () => ({ bavail: 1024n * 1024n, bsize: 4096n }),
        ...overrides,
    });
    return { manager, mediaRoot };
}

function request(files, patch = {}) {
    return {
        fingerprint: 'camera-files:v1',
        options: { format: 'horizontal_longform', name: 'Camera montage' },
        files: files.map(([name, size], index) => ({
            name,
            size,
            type: 'video/mp4',
            lastModified: 1000 + index,
        })),
        ...patch,
    };
}

async function upload(manager, sessionId, sourceId, start, total, bytes) {
    const body = Buffer.from(bytes);
    return manager.appendChunk(
        sessionId,
        sourceId,
        `bytes ${start}-${start + body.length - 1}/${total}`,
        body.length,
        Readable.from([body]),
    );
}

test('parses inclusive byte ranges and rejects malformed bounds', () => {
    assert.deepEqual(parseContentRange('bytes 32-63/100'), { start: 32, end: 63, total: 100, length: 32 });
    assert.throws(() => parseContentRange('32-63/100'), CompilationUploadError);
    assert.throws(() => parseContentRange('bytes 4-3/10'), /Invalid Content-Range/);
    assert.throws(() => parseContentRange('bytes 0-10/10'), /Invalid Content-Range/);
});

test('accepts multi-gigabyte camera metadata without allocating source bodies', (t) => {
    const fiveGiB = 5 * 1024 ** 3;
    const { manager } = managerFixture(t, {
        maxFileBytes: 20 * 1024 ** 3,
        maxTotalBytes: 100 * 1024 ** 3,
        statfsSync: () => ({ bavail: 1024n ** 3n, bsize: 4096n }),
    });
    const session = manager.initialize(request([
        ['camera-a.mp4', fiveGiB],
        ['camera-b.mov', fiveGiB],
    ]));
    assert.equal(session.totalBytes, 10 * 1024 ** 3);
    assert.equal(session.files.length, 2);
    assert.equal(session.receivedBytes, 0);
});

test('uploads, resumes, deduplicates a retry, and atomically finalizes a project', async (t) => {
    const { manager } = managerFixture(t);
    const session = manager.initialize(request([['camera.mp4', 8]]));
    const sourceId = session.files[0].sourceId;

    let state = await upload(manager, session.sessionId, sourceId, 0, 8, 'abcd');
    assert.equal(state.receivedBytes, 4);
    assert.equal(state.duplicate, false);

    state = await upload(manager, session.sessionId, sourceId, 0, 8, 'abcd');
    assert.equal(state.receivedBytes, 4);
    assert.equal(state.duplicate, true);

    await assert.rejects(
        upload(manager, session.sessionId, sourceId, 5, 8, 'fgh'),
        (error) => error.status === 409 && error.receivedBytes === 4,
    );

    state = await upload(manager, session.sessionId, sourceId, 4, 8, 'efgh');
    assert.equal(state.status, 'ready');
    assert.equal(state.files[0].complete, true);

    const project = manager.finalize(session.sessionId);
    assert.equal(fs.existsSync(path.join(project.jobDir, 'sources', 'source-001.mp4')), true);
    assert.equal(fs.existsSync(path.join(manager.paths.incomingRoot, session.sessionId)), false);
    const manifest = JSON.parse(fs.readFileSync(project.manifestPath, 'utf8'));
    assert.equal(manifest.sources[0].path, path.join(project.jobDir, 'sources', 'source-001.mp4'));
    assert.equal(manifest.settings.output_width, 1920);
    assert.equal(manager.status(session.sessionId).finalized, true);
    assert.equal(manager.status(session.sessionId).status, 'ready');

    const queued = {
        status: 'queued', jobId: 'job-1', projectId: session.sessionId,
        outputName: 'camera.mp4', sourceCount: 1, targetDurationSec: 300,
        format: 'horizontal_longform',
    };
    manager.recordQueued(session.sessionId, queued);
    assert.deepEqual(manager.readQueuedResult(session.sessionId), queued);
    assert.deepEqual(manager.status(session.sessionId).result, queued);
});

test('persists a short interrupted body and resumes from the actual disk offset', async (t) => {
    const { manager } = managerFixture(t);
    const session = manager.initialize(request([['camera.mp4', 4]]));
    const sourceId = session.files[0].sourceId;
    await assert.rejects(
        manager.appendChunk(
            session.sessionId,
            sourceId,
            'bytes 0-3/4',
            4,
            Readable.from([Buffer.from('ab')]),
        ),
        /ended before Content-Range/,
    );
    assert.equal(manager.status(session.sessionId).receivedBytes, 2);
    const completed = await upload(manager, session.sessionId, sourceId, 2, 4, 'cd');
    assert.equal(completed.status, 'ready');
});

test('serializes concurrent writes to the same source', async (t) => {
    const { manager } = managerFixture(t);
    const session = manager.initialize(request([['camera.mp4', 4]]));
    const sourceId = session.files[0].sourceId;
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    async function* delayedBody() {
        await waiting;
        yield Buffer.from('abcd');
    }
    const first = manager.appendChunk(
        session.sessionId, sourceId, 'bytes 0-3/4', 4, delayedBody(),
    );
    await assert.rejects(
        upload(manager, session.sessionId, sourceId, 0, 4, 'abcd'),
        (error) => error.status === 409,
    );
    release();
    await first;
});

test('rejects symlinked source files without following them', async (t) => {
    const { manager, mediaRoot } = managerFixture(t);
    const session = manager.initialize(request([['camera.mp4', 4]]));
    const sourceId = session.files[0].sourceId;
    const outside = path.join(mediaRoot, 'outside.bin');
    fs.writeFileSync(outside, 'safe');
    const sourceDir = path.join(manager.paths.incomingRoot, session.sessionId, 'sources');
    fs.symlinkSync(outside, path.join(sourceDir, 'source-001.mp4.part'));
    await assert.rejects(
        upload(manager, session.sessionId, sourceId, 0, 4, 'evil'),
        /regular file/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'safe');
});

test('enforces the free-space reserve before creating a session', (t) => {
    const { manager } = managerFixture(t, {
        maxFileBytes: 100,
        maxTotalBytes: 100,
        reserveBytes: 50,
        statfsSync: () => ({ bavail: 100n, bsize: 1n }),
    });
    assert.throws(
        () => manager.initialize(request([['camera.mp4', 51]])),
        (error) => error.status === 507 && error.availableBytes === 100 && error.reserveBytes === 50,
    );
    assert.equal(manager.initialize(request([['camera.mp4', 50]])).totalBytes, 50);
});

test('does not overcommit space already reserved by other incomplete sessions', (t) => {
    const { manager } = managerFixture(t, {
        maxFileBytes: 100,
        maxTotalBytes: 100,
        reserveBytes: 10,
        statfsSync: () => ({ bavail: 100n, bsize: 1n }),
    });
    manager.initialize(request([['first.mp4', 40]], { fingerprint: 'first' }));
    manager.initialize(request([['second.mp4', 40]], { fingerprint: 'second' }));
    assert.throws(
        () => manager.initialize(request([['third.mp4', 20]], { fingerprint: 'third' })),
        (error) => error.status === 507 && error.requiredBytes === 100,
    );
});

test('expires stale incomplete sessions but not fresh sessions', (t) => {
    let clock = Date.parse('2026-07-20T12:00:00Z');
    const { manager } = managerFixture(t, { now: () => clock, ttlMs: 100 });
    const oldSession = manager.initialize(request([['old.mp4', 4]], { fingerprint: 'old' }));
    clock += 101;
    const freshSession = manager.initialize(request([['fresh.mp4', 4]], { fingerprint: 'fresh' }));
    assert.equal(fs.existsSync(path.join(manager.paths.incomingRoot, oldSession.sessionId)), false);
    assert.equal(fs.existsSync(path.join(manager.paths.incomingRoot, freshSession.sessionId)), true);
});

test('capabilities removes expired reservations before reporting usable storage', (t) => {
    let clock = Date.parse('2026-07-20T12:00:00Z');
    const { manager } = managerFixture(t, {
        now: () => clock,
        ttlMs: 100,
        maxFileBytes: 100,
        maxTotalBytes: 100,
        reserveBytes: 50,
        statfsSync: () => ({ bavail: 100n, bsize: 1n }),
    });
    const stale = manager.initialize(request([['stale.mp4', 50]], { fingerprint: 'stale-capacity' }));
    let capabilities = manager.capabilities();
    assert.equal(capabilities.storage.pendingUploadBytes, 50);
    assert.equal(capabilities.storage.usableBytes, 0);
    assert.equal(capabilities.storage.ready, false);

    clock += 101;
    capabilities = manager.capabilities();
    assert.equal(capabilities.storage.pendingUploadBytes, 0);
    assert.equal(capabilities.storage.usableBytes, 50);
    assert.equal(capabilities.storage.ready, true);
    assert.equal(fs.existsSync(path.join(manager.paths.incomingRoot, stale.sessionId)), false);
    assert.equal(manager.hasSessions(), false);
});

test('requires resume metadata to match the original ordered source set', (t) => {
    const { manager } = managerFixture(t);
    const session = manager.initialize(request([['camera.mp4', 4]]));
    assert.throws(
        () => manager.initialize(request([['different.mp4', 4]], { sessionId: session.sessionId })),
        (error) => error.status === 409,
    );
});

test('fingerprint fallback only resumes an exactly comparable request', (t) => {
    const { manager } = managerFixture(t);
    const original = manager.initialize(request([['camera.mp4', 4]]));
    const resumed = manager.initialize(request([['camera.mp4', 4]]));
    assert.equal(resumed.sessionId, original.sessionId);

    const distinct = manager.initialize(request([['camera.mp4', 4]], {
        options: { format: 'horizontal_longform', name: 'Different montage', pacing: 'cinematic' },
    }));
    assert.notEqual(distinct.sessionId, original.sessionId);
});

test('MIME variation does not prevent the same source from resuming', (t) => {
    const { manager } = managerFixture(t);
    const originalRequest = request([['camera.mp4', 4]]);
    const original = manager.initialize(originalRequest);
    const resumeRequest = request([['camera.mp4', 4]], { sessionId: original.sessionId });
    resumeRequest.files[0].type = 'application/octet-stream';
    const resumed = manager.initialize(resumeRequest);
    assert.equal(resumed.sessionId, original.sessionId);
    assert.equal(resumed.files[0].type, 'video/mp4');
});

test('server registers raw chunk ingestion before multipart parsing', () => {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const rawRoute = server.indexOf("app.put('/api/action-compilation-upload-sessions/:id/sources/:sourceId'");
    const multipart = server.indexOf('app.use(fileUpload({');
    assert.ok(rawRoute >= 0 && multipart > rawRoute);
    assert.match(server.slice(rawRoute, multipart), /application\/octet-stream/);
    assert.match(server.slice(rawRoute, multipart), /parseContentRange/);
    assert.match(server.slice(multipart, multipart + 500), /tempFileDir: COMPILATION_TEMP_DIR/);
    assert.match(server, /ensureCapacity\(declaredLength, \{ includePending: true \}\)/);
});
