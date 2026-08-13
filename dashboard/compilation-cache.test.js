'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    LATEST_COMPILATION_MARKER,
    LATEST_FAILED_COMPILATION_MARKER,
    discardCompilationUpload,
    promoteLatestCompilation,
    readLatestCompilation,
    retainFailedCompilation,
} = require('./compilation-cache');

function temporaryCache(t) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-compilation-cache-'));
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
    return rootDir;
}

function createProject(rootDir, projectId, contents = projectId) {
    const projectDir = path.join(rootDir, projectId);
    const sourcesDir = path.join(projectDir, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sourcesDir, 'source-001.mp4'), contents);
    fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({ id: projectId }));
    return projectDir;
}

test('retains the first successful compilation and publishes a recoverable marker', (t) => {
    const rootDir = temporaryCache(t);
    const projectId = '11111111-1111-4111-8111-111111111111';
    const projectDir = createProject(rootDir, projectId, 'first-source');

    const result = promoteLatestCompilation({
        rootDir,
        projectId,
        outputName: 'Cosplay-final-1.mp4',
        completedAt: '2026-07-13T12:00:00.000Z',
    });
    const latest = readLatestCompilation(rootDir);

    assert.equal(result.projectDir, projectDir);
    assert.deepEqual(result.cleanupErrors, []);
    assert.equal(latest.projectId, projectId);
    assert.equal(latest.outputName, 'Cosplay-final-1.mp4');
    assert.equal(latest.manifestPath, path.join(projectDir, 'manifest.json'));
    assert.equal(fs.readFileSync(path.join(projectDir, 'sources/source-001.mp4'), 'utf8'), 'first-source');
    // Windows exposes ACLs rather than POSIX mode bits; the production code
    // still requests owner-only access there, but Node cannot read it back.
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(rootDir, LATEST_COMPILATION_MARKER)).mode & 0o777, 0o600);
    }
});

test('a newer success replaces the old cache and prunes stale upload directories', (t) => {
    const rootDir = temporaryCache(t);
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    createProject(rootDir, firstId, 'first-source');
    promoteLatestCompilation({ rootDir, projectId: firstId, outputName: 'first.mp4' });
    createProject(rootDir, secondId, 'second-source');
    createProject(rootDir, 'stale-failed-upload', 'stale-source');

    const result = promoteLatestCompilation({ rootDir, projectId: secondId, outputName: 'second.mp4' });
    const latest = readLatestCompilation(rootDir);

    assert.equal(latest.projectId, secondId);
    assert.equal(latest.outputName, 'second.mp4');
    assert.deepEqual(new Set(result.removed), new Set([firstId, 'stale-failed-upload']));
    assert.equal(fs.existsSync(path.join(rootDir, firstId)), false);
    assert.equal(fs.existsSync(path.join(rootDir, 'stale-failed-upload')), false);
    assert.equal(fs.readFileSync(path.join(rootDir, secondId, 'sources/source-001.mp4'), 'utf8'), 'second-source');
});

test('discarding a failed upload leaves the previous successful cache untouched', (t) => {
    const rootDir = temporaryCache(t);
    const successfulId = '11111111-1111-4111-8111-111111111111';
    const failedId = '22222222-2222-4222-8222-222222222222';
    createProject(rootDir, successfulId);
    promoteLatestCompilation({ rootDir, projectId: successfulId, outputName: 'successful.mp4' });
    createProject(rootDir, failedId);

    assert.equal(discardCompilationUpload({ rootDir, projectId: failedId }), true);
    assert.equal(discardCompilationUpload({ rootDir, projectId: failedId }), false);
    assert.equal(readLatestCompilation(rootDir).projectId, successfulId);
    assert.equal(fs.existsSync(path.join(rootDir, successfulId)), true);
});

test('retains one failed retry set without deleting the latest success', (t) => {
    const rootDir = temporaryCache(t);
    const successfulId = '11111111-1111-4111-8111-111111111111';
    const firstFailedId = '22222222-2222-4222-8222-222222222222';
    const secondFailedId = '33333333-3333-4333-8333-333333333333';
    createProject(rootDir, successfulId, 'successful-source');
    promoteLatestCompilation({ rootDir, projectId: successfulId, outputName: 'successful.mp4' });
    createProject(rootDir, firstFailedId, 'first-failed-source');
    retainFailedCompilation({ rootDir, projectId: firstFailedId, outputName: 'first-failed.mp4' });
    createProject(rootDir, secondFailedId, 'second-failed-source');

    const retained = retainFailedCompilation({
        rootDir, projectId: secondFailedId, outputName: 'second-failed.mp4',
        failedAt: '2026-07-13T18:00:00.000Z',
    });
    const marker = JSON.parse(fs.readFileSync(path.join(rootDir, LATEST_FAILED_COMPILATION_MARKER), 'utf8'));

    assert.equal(marker.status, 'failed');
    assert.equal(marker.projectId, secondFailedId);
    assert.equal(retained.projectId, secondFailedId);
    assert.equal(fs.existsSync(path.join(rootDir, successfulId)), true);
    assert.equal(fs.existsSync(path.join(rootDir, firstFailedId)), false);
    assert.equal(fs.existsSync(path.join(rootDir, secondFailedId, 'sources/source-001.mp4')), true);
    assert.equal(readLatestCompilation(rootDir).projectId, successfulId);
});

test('the next success clears the failed retry slot and its uploads', (t) => {
    const rootDir = temporaryCache(t);
    const failedId = '11111111-1111-4111-8111-111111111111';
    const successfulId = '22222222-2222-4222-8222-222222222222';
    createProject(rootDir, failedId);
    retainFailedCompilation({ rootDir, projectId: failedId, outputName: 'failed.mp4' });
    createProject(rootDir, successfulId);

    promoteLatestCompilation({ rootDir, projectId: successfulId, outputName: 'successful.mp4' });

    assert.equal(fs.existsSync(path.join(rootDir, failedId)), false);
    assert.equal(fs.existsSync(path.join(rootDir, LATEST_FAILED_COMPILATION_MARKER)), false);
    assert.equal(readLatestCompilation(rootDir).projectId, successfulId);
});

test('rejects traversal and symbolic-link projects without deleting their targets', (t) => {
    const rootDir = temporaryCache(t);
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-compilation-external-'));
    t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(externalDir, 'sources'));
    fs.writeFileSync(path.join(externalDir, 'manifest.json'), '{}');
    fs.symlinkSync(externalDir, path.join(rootDir, 'linked-project'));

    assert.throws(
        () => promoteLatestCompilation({ rootDir, projectId: '../outside', outputName: 'bad.mp4' }),
        /Invalid compilation project id|direct child/,
    );
    assert.throws(
        () => discardCompilationUpload({ rootDir, projectId: 'linked-project' }),
        /real directory/,
    );
    assert.equal(fs.existsSync(path.join(externalDir, 'manifest.json')), true);
});

test('missing, corrupt, or unsafe latest markers are not treated as recoverable', (t) => {
    const rootDir = temporaryCache(t);
    const markerPath = path.join(rootDir, LATEST_COMPILATION_MARKER);
    assert.equal(readLatestCompilation(rootDir), null);

    fs.writeFileSync(markerPath, '{not-json');
    assert.equal(readLatestCompilation(rootDir), null);

    fs.writeFileSync(markerPath, JSON.stringify({
        version: 1,
        projectId: '../outside',
        manifest: '../outside/manifest.json',
        outputName: '../outside.mp4',
    }));
    assert.equal(readLatestCompilation(rootDir), null);
});

test('action compilation route retains both successful and failed recovery sources', () => {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const start = server.indexOf('function startCompilationProject');
    const end = server.indexOf('// Wordless multi-source action montage', start);
    const route = server.slice(start, end);

    assert.match(route, /if \(code === 0\) \{[\s\S]*promoteLatestCompilation/);
    assert.match(route, /retainFailedCompilation/);
    assert.match(route, /onError: \(\) => finalizeCompilation\(null\)/);
    assert.match(route, /onClose: finalizeCompilation/);
});
