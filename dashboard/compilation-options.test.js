const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    MAX_COMPILATION_FILE_BYTES,
    compilationManifestSettings,
    normalizeCompilationOptions,
    sanitizeCompilationSlug,
    validateCompilationFiles,
} = require('./compilation-options');

function file(name, size = 1024) {
    return { name, size };
}

test('normalizes action compilation settings independently of speech jobs', () => {
    const options = normalizeCompilationOptions({
        name: '  Cosplay finals  ',
        goal: 'cosplay_showcase',
        targetDurationSec: '45',
        pacing: 'balanced',
        transitionMode: 'minimal',
        selectionMode: 'use_every_clip',
        orderMode: 'manual',
    });
    assert.deepEqual(options, {
        name: 'Cosplay finals',
        format: 'vertical_short',
        goal: 'cosplay_showcase',
        targetDurationSec: 45,
        pacing: 'balanced',
        transitionMode: 'minimal',
        selectionMode: 'use_every_clip',
        orderMode: 'manual',
    });
    assert.equal(compilationManifestSettings(options).output_height, 1920);
});

test('normalizes horizontal long-form duration and manifest dimensions', () => {
    const defaults = normalizeCompilationOptions({ format: 'horizontal_longform' });
    assert.equal(defaults.targetDurationSec, 300);
    assert.equal(defaults.pacing, 'balanced');

    const minimum = normalizeCompilationOptions({
        format: 'horizontal_longform',
        targetDurationSec: 10,
    });
    assert.equal(minimum.targetDurationSec, 180);

    const maximum = normalizeCompilationOptions({
        format: 'horizontal_longform',
        targetDurationSec: 9999,
    });
    assert.equal(maximum.targetDurationSec, 900);
    assert.deepEqual(compilationManifestSettings(maximum), {
        format: 'horizontal_longform',
        goal: 'fast_action',
        target_duration_sec: 900,
        pacing: 'balanced',
        transition_mode: 'auto',
        selection_mode: 'best_moments',
        order_mode: 'ai',
        output_width: 1920,
        output_height: 1080,
        fps: 30,
    });
});

test('clamps invalid compilation values to safe local defaults', () => {
    const defaults = normalizeCompilationOptions({});
    assert.equal(defaults.format, 'vertical_short');
    assert.equal(defaults.targetDurationSec, 30);

    const minimum = normalizeCompilationOptions({ targetDurationSec: 1 });
    assert.equal(minimum.targetDurationSec, 4);

    const options = normalizeCompilationOptions({
        targetDurationSec: '999', goal: 'words', pacing: 'chaos', transitionMode: 'glitch',
    });
    assert.equal(options.targetDurationSec, 180);
    assert.equal(options.goal, 'fast_action');
    assert.equal(options.pacing, 'fast');
    assert.equal(options.transitionMode, 'auto');
});

test('requires two to twenty supported source videos', () => {
    assert.match(validateCompilationFiles([file('one.mp4')]).error, /2 to 20/);
    assert.equal(validateCompilationFiles([file('one.mp4'), file('two.mov')]).error, null);
    assert.match(validateCompilationFiles([file('one.mp4'), file('notes.txt')]).error, /Unsupported/);
    assert.match(validateCompilationFiles(Array.from({ length: 21 }, (_, index) => file(`${index}.mp4`))).error, /2 to 20/);
    assert.match(validateCompilationFiles([
        file('huge.mp4', MAX_COMPILATION_FILE_BYTES + 1), file('two.mp4'),
    ]).error, /20GB/);
    assert.match(validateCompilationFiles([
        file('one.mp4', MAX_COMPILATION_FILE_BYTES),
        file('two.mp4', MAX_COMPILATION_FILE_BYTES),
        file('three.mp4', MAX_COMPILATION_FILE_BYTES),
        file('four.mp4', MAX_COMPILATION_FILE_BYTES),
        file('five.mp4', MAX_COMPILATION_FILE_BYTES),
        file('six.mp4', 1),
    ]).error, /100GB/);
    assert.equal(validateCompilationFiles([
        file('camera-a.mp4', 5 * 1024 ** 3), file('camera-b.mov', 5 * 1024 ** 3),
    ]).error, null);
});

test('horizontal long-form accepts one source while vertical short still requires two', () => {
    const source = [file('long-source.mp4')];
    assert.match(validateCompilationFiles(source, 'vertical_short').error, /2 to 20/);
    assert.equal(validateCompilationFiles(source, 'horizontal_longform').error, null);
});

test('sanitizes compilation names for output files', () => {
    assert.equal(sanitizeCompilationSlug('../Cosplay: Final!'), 'Cosplay-Final');
    assert.equal(sanitizeCompilationSlug('***'), 'action-compilation');
});

test('action compilation route captures the spawned process before returning its job id', () => {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const start = server.indexOf("app.post('/api/action-compilations'");
    const end = server.indexOf('// Serve the new Vite build', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const route = server.slice(start, end);
    assert.match(route, /const queued = startCompilationProject\(\{/);
    assert.match(route, /status\(202\)\.json\(queued\)/);

    const starterStart = server.indexOf('function startCompilationProject');
    const starterEnd = server.indexOf('// Wordless multi-source action montage', starterStart);
    const starter = server.slice(starterStart, starterEnd);
    assert.match(starter, /compilationProcess = spawnTrackedFactoryJob\(\{/);
    assert.match(starter, /const trackedJobId = compilationProcess\?\.jobId/);
    assert.match(starter, /status: 'queued',[\s\S]*jobId: trackedJobId/);
    assert.match(starter, /'--work-dir', workDir/);

    const trackerStart = server.indexOf('spawnTrackedFactoryJob = function trackedFactoryJob');
    const trackerEnd = server.indexOf('// Thumbnail', trackerStart);
    const tracker = server.slice(trackerStart, trackerEnd);
    assert.match(tracker, /const entry = recordJobStart\(\{/);
    assert.match(tracker, /const id = entry\.id;/);
    assert.match(tracker, /subprocess\.jobId = id;/);
    assert.match(server, /state\.jobId = typeof state\.jobId\.id === 'string' \? state\.jobId\.id : null;/);
});

test('action compilation route applies format before validation and returns it', () => {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const start = server.indexOf("app.post('/api/action-compilations'");
    const end = server.indexOf('// Serve the new Vite build', start);
    const route = server.slice(start, end);

    const normalizeAt = route.indexOf('const options = normalizeCompilationOptions(req.body || {});');
    const validateAt = route.indexOf('validateCompilationFiles(req.files?.clips, options.format)');
    assert.ok(normalizeAt >= 0 && validateAt > normalizeAt);
    assert.match(route, /startCompilationProject\(\{ projectId, jobDir, manifestPath, sources, options \}\)/);
    const starterStart = server.indexOf('function startCompilationProject');
    const starterEnd = server.indexOf('// Wordless multi-source action montage', starterStart);
    const starter = server.slice(starterStart, starterEnd);
    assert.match(starter, /options\.format === 'horizontal_longform'[\s\S]*youtube_1080p/);
    assert.match(starter, /format: options\.format/);
});
