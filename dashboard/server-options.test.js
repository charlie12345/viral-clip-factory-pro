const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildJobPreflight,
    buildFactoryArgs,
    mergeUploadOptions,
    normalizeUploadOptions,
    reconcileRunningJobHistory,
    sanitizeUploadFilename,
    uniqueUploadFilename,
} = require('./server-options');

const READY_CAPABILITIES = {
    compute: [
        { backend: 'rocm', available: true },
        { backend: 'cuda', available: false },
        { backend: 'cpu', available: true },
    ],
    videoEncoders: [
        { backend: 'nvenc', available: false, reason: 'No NVIDIA device' },
        { backend: 'vaapi', available: true },
        { backend: 'cpu', available: true },
    ],
    recommendedCompute: 'rocm',
    recommendedVideoEncoder: 'vaapi',
    transcriptionProviders: [
        { id: 'auto', available: true },
        { id: 'openai_whisper', available: true },
        { id: 'whisper_cpp', available: true, model: 'large-v3' },
        { id: 'deepgram', available: false, reason: 'API key is not configured' },
    ],
    viralProviders: [
        { id: 'heuristic', available: true },
        { id: 'local_semantic', available: false, reason: 'Local endpoint is not configured' },
        { id: 'gemini', available: false, reason: 'API key is not configured' },
    ],
};

test('normalizes unsupported hardware values to safe defaults', () => {
    const result = normalizeUploadOptions({
        computeDevice: 'metal',
        videoEncoder: 'unknown',
        transcriptionProvider: 'magic',
        transcriptionModel: 'huge',
        exportPreset: 'other',
        clipVolume: 'everything',
        targetClips: 'none',
    });
    assert.equal(result.computeDevice, 'auto');
    assert.equal(result.videoEncoder, 'auto');
    assert.equal(result.transcriptionProvider, 'auto');
    assert.equal(result.transcriptionModel, 'large-v3');
    assert.equal(result.exportPreset, 'generic');
    assert.equal(result.clipVolume, 'balanced');
    assert.equal(result.targetClips, '12');
});

test('builds complete cross-platform hardware arguments', () => {
    const args = buildFactoryArgs('/app/viral_factory.py', '/tmp/video.mp4', {
        computeDevice: 'rocm',
        videoEncoder: 'vaapi',
        transcriptionProvider: 'whisper_cpp',
        transcriptionModel: 'small',
        exportPreset: 'youtube_shorts',
        outputNameTemplate: '{source}_{index}',
    });
    assert.deepEqual(args.slice(0, 3), ['/app/viral_factory.py', '/tmp/video.mp4', '--mode']);
    assert.equal(args[args.indexOf('--compute-device') + 1], 'rocm');
    assert.equal(args[args.indexOf('--video-encoder') + 1], 'vaapi');
    assert.equal(args[args.indexOf('--transcription-provider') + 1], 'whisper_cpp');
    assert.equal(args[args.indexOf('--transcription-language') + 1], 'auto');
    assert.equal(args[args.indexOf('--export-preset') + 1], 'youtube_shorts');
    assert.equal(args[args.indexOf('--clip-volume') + 1], 'balanced');
    assert.equal(args.includes('--target-clips'), false);
});

test('review-first shorts jobs analyze without rendering and preserve language selection', () => {
    const args = buildFactoryArgs('/app/viral_factory.py', '/tmp/video.mp4', {
        mode: 'shorts',
        reviewBeforeRender: true,
        transcriptionPreset: 'final',
        transcriptionModel: 'large-v3',
        transcriptionLanguage: 'en-us',
    });
    assert.equal(args[args.indexOf('--mode') + 1], 'shorts-analyze');
    assert.equal(args[args.indexOf('--transcription-model') + 1], 'large-v3');
    assert.equal(args[args.indexOf('--transcription-language') + 1], 'en-us');

    const longformArgs = buildFactoryArgs('/app/viral_factory.py', '/tmp/video.mp4', {
        mode: 'longform',
        reviewBeforeRender: true,
    });
    assert.equal(longformArgs[longformArgs.indexOf('--mode') + 1], 'longform');
});

test('normalizes and wires an exact clip target below the hard cap', () => {
    const normalized = normalizeUploadOptions({
        clipVolume: 'exact',
        targetClips: 16,
        maxClips: 20,
    });
    assert.equal(normalized.clipVolume, 'exact');
    assert.equal(normalized.targetClips, '16');
    assert.equal(normalized.maxClips, '20');

    const args = buildFactoryArgs('/app/viral_factory.py', '/tmp/video.mp4', normalized);
    assert.equal(args[args.indexOf('--clip-volume') + 1], 'exact');
    assert.equal(args[args.indexOf('--target-clips') + 1], '16');
    assert.equal(args[args.indexOf('--max-clips') + 1], '20');
});

test('clamps an exact clip target to the hard cap', () => {
    const normalized = normalizeUploadOptions({
        clipVolume: 'exact',
        targetClips: 42,
        maxClips: 10,
    });
    assert.equal(normalized.targetClips, '10');
});

test('omits shorts-only limits from long-form jobs', () => {
    const args = buildFactoryArgs('/app/viral_factory.py', '/tmp/video.mp4', {
        mode: 'longform',
        maxDuration: 30,
        maxClips: 5,
    });
    assert.equal(args.includes('--max-duration'), false);
    assert.equal(args.includes('--max-clips'), false);
    assert.equal(args.includes('--subtitle-style'), false);
    assert.equal(args.includes('--clip-volume'), false);
    assert.equal(args.includes('--target-clips'), false);
    assert.equal(args.includes('--local-semantic'), false);
    assert.equal(args.includes('--gemini-analysis'), false);
});

test('keeps cloud analysis explicitly opt-in', () => {
    const defaults = normalizeUploadOptions({}, {
        GEMINI_API_KEY: 'configured-but-not-consent',
    });
    assert.equal(defaults.localSemantic, true);
    assert.equal(defaults.geminiAnalysis, false);

    const args = buildFactoryArgs('/app/viral_factory.py', '/tmp/video.mp4', {
        mode: 'shorts',
        transcriptionProvider: 'deepgram',
        transcriptionModel: 'turbo',
        localSemantic: 'false',
        geminiAnalysis: 'true',
    });
    assert.equal(args[args.indexOf('--transcription-provider') + 1], 'deepgram');
    assert.equal(args[args.indexOf('--transcription-model') + 1], 'turbo');
    assert.equal(args.includes('--local-semantic'), false);
    assert.equal(args.includes('--gemini-analysis'), true);
});

test('upload names are sanitized and collision resistant', () => {
    assert.equal(sanitizeUploadFilename('../unsafe name?.mp4'), 'unsafe_name_.mp4');
    const fixedRandom = () => Buffer.from('abcdef', 'hex');
    assert.equal(uniqueUploadFilename('clip.mp4', 1234, fixedRandom), 'clip-1234-abcdef.mp4');
});

test('merges saved server defaults into otherwise unspecified upload options', () => {
    const result = mergeUploadOptions({
        mode: 'shorts',
        maxClips: '10',
    }, {
        computeDevice: 'rocm',
        videoEncoder: 'vaapi',
        transcriptionProvider: 'whisper_cpp',
        transcriptionModel: 'large-v3',
        localSemantic: false,
        geminiAnalysis: true,
        exportPreset: 'youtube_shorts',
    });
    assert.equal(result.computeDevice, 'rocm');
    assert.equal(result.videoEncoder, 'vaapi');
    assert.equal(result.transcriptionProvider, 'whisper_cpp');
    assert.equal(result.transcriptionModel, 'large-v3');
    assert.equal(result.localSemantic, false);
    assert.equal(result.geminiAnalysis, true);
    assert.equal(result.exportPreset, 'youtube_shorts');
    assert.equal(result.maxClips, '10');
});

test('preflight resolves auto hardware and local transcription without exposing capability details', () => {
    const result = buildJobPreflight({
        computeDevice: 'auto',
        videoEncoder: 'auto',
        transcriptionProvider: 'auto',
        transcriptionModel: 'large-v3',
        localSemantic: false,
    }, READY_CAPABILITIES);
    assert.equal(result.ready, true);
    assert.deepEqual(result.effective, {
        computeDevice: 'rocm',
        videoEncoder: 'vaapi',
        transcriptionProvider: 'openai_whisper',
        transcriptionModel: 'large-v3',
        transcriptionPreset: 'final',
        transcriptionLanguage: 'auto',
        localSemantic: false,
        geminiAnalysis: false,
        reviewBeforeRender: false,
    });
    assert.deepEqual(result.warnings, []);
});

test('preflight clearly reports optional provider and encoder fallbacks', () => {
    const result = buildJobPreflight({
        computeDevice: 'rocm',
        videoEncoder: 'nvenc',
        transcriptionProvider: 'deepgram',
        transcriptionModel: 'medium',
        localSemantic: true,
        geminiAnalysis: true,
    }, READY_CAPABILITIES);
    assert.equal(result.ready, true);
    assert.equal(result.effective.videoEncoder, 'vaapi');
    assert.equal(result.effective.transcriptionProvider, 'openai_whisper');
    assert.equal(result.effective.localSemantic, false);
    assert.equal(result.effective.geminiAnalysis, false);
    assert.deepEqual(result.warnings.map((item) => item.code), [
        'video_encoder_fallback',
        'transcription_provider_fallback',
        'local_semantic_unavailable',
        'gemini_unavailable',
    ]);
});

test('preflight treats an explicitly unavailable compute backend as blocking', () => {
    const result = buildJobPreflight({ computeDevice: 'cuda' }, READY_CAPABILITIES);
    assert.equal(result.ready, false);
    assert.equal(result.errors[0].code, 'compute_unavailable');
    assert.equal(result.effective.computeDevice, 'cuda');
});

test('reconciles stale running history while preserving the active job', () => {
    const jobs = [
        { id: 'done', status: 'complete', finishedAt: 'earlier' },
        { id: 'active', status: 'running', pid: 123 },
        { id: 'stale-id', status: 'running', pid: null },
        { id: 'stale-pid', status: 'running', pid: 456 },
    ];
    const result = reconcileRunningJobHistory(
        jobs,
        { jobId: 'active', pid: 123 },
        '2026-07-10T17:00:00.000Z',
    );
    assert.equal(result.changed, true);
    assert.equal(result.interrupted, 2);
    assert.equal(result.jobs[1].status, 'running');
    assert.equal(result.jobs[2].status, 'interrupted');
    assert.equal(result.jobs[2].finishedAt, '2026-07-10T17:00:00.000Z');
    assert.match(result.jobs[2].error, /Dashboard restarted/);
    assert.equal(result.jobs[3].status, 'interrupted');
});
