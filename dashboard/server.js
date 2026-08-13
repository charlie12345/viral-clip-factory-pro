const express = require('express');
const fileUpload = require('express-fileupload');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const archiver = require('archiver');
const {
    buildJobPreflight,
    buildFactoryArgs,
    mergeUploadOptions,
    normalizeUploadOptions,
    reconcileRunningJobHistory,
    sanitizeUploadFilename,
    uniqueUploadFilename,
} = require('./server-options');
const {
    MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES,
    ProviderSettingsReadError,
    ProviderSettingsValidationError,
    applyProviderEnvironment,
    captureBootstrapProviderEnvironment,
    providerSettingsStatus,
    providerSettingsPayloadTooLarge,
    readProviderSettings,
    updateProviderSettings,
    writeProviderSettingsAtomic,
} = require('./provider-settings');
const {
    MAX_COMPILATION_FILE_BYTES,
    compilationManifestSettings,
    normalizeCompilationOptions,
    sanitizeCompilationSlug,
    validateCompilationFiles,
} = require('./compilation-options');
const {
    promoteLatestCompilation,
    retainFailedCompilation,
} = require('./compilation-cache');
const {
    CompilationUploadError,
    createCompilationUploadManager,
    parseContentRange,
} = require('./compilation-upload-sessions');
const {
    createStorageManager,
} = require('./storage-cleanup');
const {
    assertConfiguredMediaMount,
} = require('./media-storage');
const { legalInfo } = require('./legal-info');
const {
    buildLongformEdl,
    buildLongformFcpxml,
    buildLongformOtio,
    flattenSequenceForRender,
    interchangeDigest,
    normalizeEffectTemplate,
    normalizeGrade,
    normalizeLongformProfessional,
    sequenceTimelineItems,
    supplementQcReport,
} = require('./longform-professional');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const PROVIDER_BOOTSTRAP_ENV = captureBootstrapProviderEnvironment(process.env);
const TEMP_DIR = path.join(__dirname, '../temp_processing');

let server = null;
let fatalShutdownStarted = false;

function shutdownAfterFatal(label, error) {
    if (fatalShutdownStarted) return;
    fatalShutdownStarted = true;
    console.error(`[${label}]`, error?.message || error, error?.stack || '');
    const finish = () => process.exit(1);
    if (server?.listening) {
        server.close(finish);
        setTimeout(finish, 5000).unref();
    } else {
        finish();
    }
}

process.on('uncaughtException', (err) => {
    shutdownAfterFatal('UncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
    shutdownAfterFatal('UnhandledRejection', reason);
});

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const HOST = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const ACTIVE_JOB_LOG_TAIL_BYTES = 512 * 1024;
const LOG_HISTORY_LIMIT = 400;
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.VCF_MAX_UPLOAD_BYTES || '', 10) || 50 * 1024 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 24 * HOUR_MS;

function parseTimeoutMs(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown';
    if (ms === 0) return 'disabled';

    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];

    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function buildFactoryArgsForUpload(uploadPath, options = {}) {
    return buildFactoryArgs(SCRIPT_PATH, uploadPath, options);
}

function triggerFactoryForUploadedFile(uploadPath, safeName, options = {}) {
    const normalized = resolveServerJobOptions(options);
    const args = buildFactoryArgsForUpload(uploadPath, normalized);
    const runtimeMeta = buildTrackedJobMeta(normalized);
    console.log(`🎬 Triggering Factory: ${args.join(' ')}`);

    spawnTrackedFactoryJob({
        args,
        cwd: path.join(__dirname, '..'),
        initialLines: [
            `🚀 Job Started: ${safeName}`,
            ...runtimeMeta.preflightWarnings.map((item) => `⚠️ ${item.message}`),
        ],
        stateMeta: {
            label: safeName,
            source: uploadPath,
            ...runtimeMeta,
            exportPreset: normalized.exportPreset,
        },
        onError: (err) => {
            console.error(`[Factory Spawn Error]: ${err.message}`);
        }
    });
}

function defaultUploadSessionState(patch = {}) {
    return {
        id: null,
        fingerprint: null,
        originalName: null,
        safeName: null,
        mimeType: null,
        totalSize: 0,
        receivedBytes: 0,
        chunkSize: RESUMABLE_CHUNK_BYTES,
        lastModified: null,
        status: 'uploading',
        uploadPath: null,
        tempPath: null,
        error: null,
        createdAt: null,
        updatedAt: null,
        processingStartedAt: null,
        completedAt: null,
        options: normalizeUploadOptions({}),
        ...patch
    };
}

function uploadSessionJsonPath(sessionId) {
    return path.join(UPLOAD_SESSION_DIR, `${sessionId}.json`);
}

function uploadSessionTempPath(sessionId) {
    return path.join(UPLOAD_SESSION_PART_DIR, `${sessionId}.part`);
}

function readUploadSession(sessionId) {
    if (!sessionId) return null;
    const filePath = uploadSessionJsonPath(sessionId);
    if (!fs.existsSync(filePath)) return null;

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return defaultUploadSessionState(parsed || {});
    } catch (_) {
        return null;
    }
}

function writeUploadSession(session) {
    const normalized = defaultUploadSessionState({
        ...(session || {}),
        updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(uploadSessionJsonPath(normalized.id), JSON.stringify(normalized, null, 2));
    return normalized;
}

function listUploadSessions() {
    if (!fs.existsSync(UPLOAD_SESSION_DIR)) return [];

    return fs.readdirSync(UPLOAD_SESSION_DIR)
        .filter(name => name.endsWith('.json'))
        .map(name => readUploadSession(name.replace(/\.json$/, '')))
        .filter(Boolean);
}

function removeUploadSession(session) {
    if (!session || !session.id) return;

    for (const filePath of [uploadSessionJsonPath(session.id), session.tempPath || uploadSessionTempPath(session.id)]) {
        if (!filePath) continue;
        try {
            fs.unlinkSync(filePath);
        } catch (_) {}
    }
}

function cleanupExpiredUploadSessions() {
    const cutoff = Date.now() - UPLOAD_SESSION_TTL_MS;
    for (const session of listUploadSessions()) {
        const updatedAt = Date.parse(session.updatedAt || session.createdAt || 0);
        if (Number.isFinite(updatedAt) && updatedAt >= cutoff) continue;
        if (session.status === 'processing') continue;
        removeUploadSession(session);
    }
}

function findReusableUploadSession(fingerprint) {
    if (!fingerprint) return null;

    return listUploadSessions().find(session =>
        session.fingerprint === fingerprint &&
        ['uploading', 'uploaded', 'error'].includes(session.status)
    ) || null;
}

async function appendTempChunkToUpload(tempChunkPath, targetPath) {
    if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(tempChunkPath, targetPath);
        return;
    }

    fs.appendFileSync(targetPath, fs.readFileSync(tempChunkPath));
}

const HTTP_REQUEST_TIMEOUT_MS = parseTimeoutMs(process.env.VCF_REQUEST_TIMEOUT_MS, 0);
const UPLOAD_IDLE_TIMEOUT_MS = parseTimeoutMs(process.env.VCF_UPLOAD_IDLE_TIMEOUT_MS, 30 * MINUTE_MS);

// Logs Cache
const currentLogs = [];

// In-memory bake job store: jobId -> { progress, done, error, outputPath, clipName }
const bakeJobs = {};
let compilationAdmissionActive = false;

// Config
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PENDING_DIR = path.join(UPLOAD_DIR, 'pending');
const PROCESSING_DIR = path.join(UPLOAD_DIR, 'processing');
const CLIPS_DIR = path.join(__dirname, '../viral_clips');
const CANDIDATE_MANIFESTS_DIR = path.join(CLIPS_DIR, '_candidate_manifests');
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const LONGFORM_ASSETS_DIR = path.join(RUNTIME_DIR, 'longform-assets');
const LONGFORM_PROXY_DIR = path.join(RUNTIME_DIR, 'longform-proxies');
const LONGFORM_SNAPSHOT_DIR = path.join(RUNTIME_DIR, 'longform-snapshots');
const LONGFORM_SOURCE_DIR = path.join(RUNTIME_DIR, 'longform-sources');
const LONGFORM_RENDER_QUEUE_DIR = path.join(RUNTIME_DIR, 'longform-render-queue');
const LONGFORM_RENDER_QUEUE_PATH = path.join(RUNTIME_DIR, 'longform-render-queue.json');
const LONGFORM_PRESETS_PATH = path.join(RUNTIME_DIR, 'longform-presets.json');
const LONGFORM_LUT_LIBRARY_DIR = path.join(RUNTIME_DIR, 'longform-lut-library');
const LONGFORM_REVIEW_DIR = path.join(RUNTIME_DIR, 'longform-reviews');
const LONGFORM_DELIVERY_DIR = path.join(CLIPS_DIR, '_deliveries');
const LONGFORM_INTERCHANGE_DIR = path.join(RUNTIME_DIR, 'longform-interchange');
const LONGFORM_CONSOLIDATION_DIR = path.join(RUNTIME_DIR, 'longform-consolidations');
const LONGFORM_QC_DIR = path.join(RUNTIME_DIR, 'longform-qc');
const LONGFORM_TEMPLATES_PATH = path.join(RUNTIME_DIR, 'longform-effect-templates.json');
const MEDIA_ROOT = path.resolve(process.env.VCF_MEDIA_ROOT || path.join(RUNTIME_DIR, 'large-media'));
const MEDIA_MOUNT = String(process.env.VCF_MEDIA_MOUNT || '').trim();
const COMPILATION_UPLOAD_DIR = path.join(MEDIA_ROOT, 'action-compilations');
const COMPILATION_INCOMING_DIR = path.join(MEDIA_ROOT, 'action-compilation-incoming');
const COMPILATION_TEMP_DIR = path.join(MEDIA_ROOT, 'upload-temp');
const COMPILATION_WORK_DIR = path.join(MEDIA_ROOT, 'action-compilation-work');
const PROVIDER_SETTINGS_PATH = path.join(RUNTIME_DIR, 'provider-settings.json');
const UPLOAD_SESSION_DIR = path.join(RUNTIME_DIR, 'upload-sessions');
const UPLOAD_SESSION_PART_DIR = path.join(RUNTIME_DIR, 'upload-parts');
const ACTIVE_JOB_LOG_PATH = path.join(RUNTIME_DIR, 'active-job.log');
const ACTIVE_JOB_STATE_PATH = path.join(RUNTIME_DIR, 'active-job.json');
const PROFILES_PATH = path.join(RUNTIME_DIR, 'profiles.json');
const SETTINGS_PATH = path.join(RUNTIME_DIR, 'settings.json');
const JOBS_HISTORY_PATH = path.join(RUNTIME_DIR, 'jobs-history.json');
const THUMB_CACHE_DIR = path.join(RUNTIME_DIR, 'thumbnails');
const SCRIPT_PATH = path.join(__dirname, '../viral_factory.py');
const HARDWARE_SCRIPT_PATH = path.join(__dirname, '../hardware_accel.py');
const LONGFORM_SCRIPT_PATH = path.join(__dirname, '../longform_editor.py');
const LONGFORM_TOOLS_PATH = path.join(__dirname, '../longform_tools.py');
const LONGFORM_AAF_PATH = path.join(__dirname, '../longform_aaf.py');
const LONGFORM_CONSOLIDATE_PATH = path.join(__dirname, '../longform_consolidate.py');
const ACTION_COMPILER_PATH = path.join(__dirname, '../action_compilation.py');
const DEFAULT_VENV_PYTHON = process.platform === 'win32'
    ? path.join(__dirname, '../venv/Scripts/python.exe')
    : path.join(__dirname, '../venv/bin/python');
const PYTHON_BIN = process.env.VCF_PYTHON_PATH || (fs.existsSync(DEFAULT_VENV_PYTHON) ? DEFAULT_VENV_PYTHON : 'python3');
const FFMPEG_BIN = process.env.VCF_FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.VCF_FFPROBE_PATH || 'ffprobe';
const JOBS_HISTORY_LIMIT = 200;
const NOISY_LOG_PATTERNS = [
    'pkg_resources is deprecated',
    'UserWarning',
    'face_recognition_models',
    'setuptools',
    'frame=',
    'Reference ',
    'error while decoding MB',
    'frames/s]'
];

// Ensure Dirs
assertConfiguredMediaMount({ mediaRoot: MEDIA_ROOT, mountPath: MEDIA_MOUNT });
[UPLOAD_DIR, PENDING_DIR, PROCESSING_DIR, CLIPS_DIR, RUNTIME_DIR, LONGFORM_ASSETS_DIR, LONGFORM_PROXY_DIR, LONGFORM_SNAPSHOT_DIR, LONGFORM_SOURCE_DIR, LONGFORM_RENDER_QUEUE_DIR, LONGFORM_LUT_LIBRARY_DIR, LONGFORM_REVIEW_DIR, LONGFORM_DELIVERY_DIR, LONGFORM_INTERCHANGE_DIR, LONGFORM_CONSOLIDATION_DIR, LONGFORM_QC_DIR, MEDIA_ROOT, COMPILATION_UPLOAD_DIR, COMPILATION_INCOMING_DIR, COMPILATION_TEMP_DIR, COMPILATION_WORK_DIR, UPLOAD_SESSION_DIR, UPLOAD_SESSION_PART_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
});

const compilationUploadManager = createCompilationUploadManager({
    mediaRoot: MEDIA_ROOT,
    incomingRoot: COMPILATION_INCOMING_DIR,
    projectRoot: COMPILATION_UPLOAD_DIR,
    tempRoot: COMPILATION_TEMP_DIR,
    workRoot: COMPILATION_WORK_DIR,
    maxFileBytes: process.env.VCF_COMPILATION_MAX_FILE_BYTES,
    maxTotalBytes: process.env.VCF_COMPILATION_MAX_TOTAL_BYTES,
    chunkBytes: process.env.VCF_COMPILATION_CHUNK_BYTES,
    ttlMs: process.env.VCF_COMPILATION_SESSION_TTL_MS,
    reserveBytes: process.env.VCF_COMPILATION_MIN_FREE_BYTES,
});
compilationUploadManager.cleanupExpired();

const storageManager = createStorageManager([
    {
        id: 'temporary',
        label: 'Render scratch files',
        description: 'Sanitized inputs, temporary encodes, test frames, and other render scratch data.',
        warning: 'Regenerated automatically when needed.',
        roots: [TEMP_DIR, COMPILATION_WORK_DIR],
    },
    {
        id: 'previews',
        label: 'Preview cache',
        description: 'Clip thumbnails and long-form waveform images.',
        warning: 'The next visit may take longer while previews rebuild.',
        roots: [THUMB_CACHE_DIR],
    },
    {
        id: 'proxies',
        label: 'Long-form proxies',
        description: 'Low-resolution editing proxies and their metadata.',
        warning: 'Original source media is protected; proxies can be rebuilt from the editor.',
        roots: [LONGFORM_PROXY_DIR],
    },
    {
        id: 'compilation_cache',
        label: 'Compilation recovery cache',
        description: 'Uploaded source sets retained for action-compilation retries.',
        warning: 'Completed output clips remain, but cached retry sources will be removed.',
        roots: [COMPILATION_UPLOAD_DIR],
    },
    {
        id: 'generated_work',
        label: 'Generated reports and interchange',
        description: 'Regenerable QC reports plus cached EDL, XML, OTIO, and AAF files.',
        warning: 'Project edits, snapshots, and review comments are protected.',
        roots: [LONGFORM_QC_DIR, LONGFORM_INTERCHANGE_DIR],
    },
    {
        id: 'turnover_work',
        label: 'Consolidated turnover work',
        description: 'Generated consolidation packages and trimmed turnover media.',
        warning: 'Only delete these after downloading any turnover package you still need.',
        roots: [LONGFORM_CONSOLIDATION_DIR],
    },
]);

const longformProxyJobs = new Map();
let longformRenderQueueActive = false;

// Provider credentials saved in the dashboard override bootstrap environment
// values. Re-applying this same snapshot after each save also restores the
// original environment value when a saved override is explicitly cleared.
let savedProviderSettings = {};
try {
    savedProviderSettings = readProviderSettings(PROVIDER_SETTINGS_PATH);
} catch (error) {
    if (!(error instanceof ProviderSettingsReadError)) throw error;
    // Do not print the underlying parse/read error: it may contain filesystem
    // details, and the last known in-memory state is safer than treating a
    // corrupt credential file as an intentional empty configuration.
    console.error('Unable to load the saved provider settings file.');
}
applyProviderEnvironment(savedProviderSettings, PROVIDER_BOOTSTRAP_ENV, process.env);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/legal', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(legalInfo());
});
app.use('/clips', express.static(CLIPS_DIR, {
    maxAge: '1h',           // browser caches clip files for 1 hour
    immutable: false,
    setHeaders(res, filePath) {
        if (/\.mp4$/i.test(filePath)) {
            res.setHeader('Accept-Ranges', 'bytes');  // enable seek/range requests
        }
    }
}));
app.use('/api/upload', (req, res, next) => {
    if (req.method !== 'POST') return next();

    const startedAt = Date.now();
    const contentLength = Number.parseInt(req.headers['content-length'] || '', 10);
    const sizeLabel = formatBytes(contentLength);

    console.log(`⬆️ Upload request started from ${req.ip} (${sizeLabel})`);

    req.on('aborted', () => {
        console.error(`❌ Upload request aborted after ${formatDuration(Date.now() - startedAt)} (${sizeLabel})`);
    });

    res.on('finish', () => {
        if (res.statusCode < 400) {
            console.log(`✅ Upload request accepted in ${formatDuration(Date.now() - startedAt)} (${sizeLabel})`);
        }
    });

    next();
});

function sendCompilationUploadError(res, error) {
    const status = error instanceof CompilationUploadError
        ? error.status
        : 500;
    const payload = { error: error?.message || 'Compilation upload failed' };
    for (const key of ['receivedBytes', 'totalBytes', 'availableBytes', 'reserveBytes', 'requiredBytes']) {
        if (Number.isFinite(error?.[key])) payload[key] = error[key];
    }
    return res.status(status).json(payload);
}

function cleanupCompilationMultipartFiles(value) {
    const files = Array.isArray(value) ? value : (value ? [value] : []);
    const allowedRoot = `${path.resolve(COMPILATION_TEMP_DIR)}${path.sep}`;
    for (const uploaded of files) {
        const temporary = path.resolve(String(uploaded?.tempFilePath || ''));
        if (!temporary.startsWith(allowedRoot)) continue;
        try {
            const stats = fs.lstatSync(temporary);
            if (stats.isFile() && !stats.isSymbolicLink()) fs.unlinkSync(temporary);
        } catch (_) {}
    }
}

app.get('/api/action-compilation-upload-capabilities', (_req, res) => {
    res.json(compilationUploadManager.capabilities());
});

app.post(
    '/api/action-compilation-upload-sessions',
    express.json({ limit: '1mb' }),
    (req, res) => {
        try {
            return res.status(201).json(compilationUploadManager.initialize(req.body || {}));
        } catch (error) {
            return sendCompilationUploadError(res, error);
        }
    },
);

app.get('/api/action-compilation-upload-sessions/:id', (req, res) => {
    try {
        return res.json(compilationUploadManager.status(req.params.id));
    } catch (error) {
        return sendCompilationUploadError(res, error);
    }
});

app.put('/api/action-compilation-upload-sessions/:id/sources/:sourceId', async (req, res) => {
    try {
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) {
            throw new CompilationUploadError('Chunk Content-Type must be application/octet-stream', 415);
        }
        const contentLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
            throw new CompilationUploadError('Chunk Content-Length is required', 411);
        }
        const range = parseContentRange(req.headers['content-range']);
        const result = await compilationUploadManager.appendChunk(
            req.params.id,
            req.params.sourceId,
            range,
            contentLength,
            req,
        );
        if (!res.destroyed) return res.json(result);
        return undefined;
    } catch (error) {
        if (res.destroyed || res.headersSent) return undefined;
        return sendCompilationUploadError(res, error);
    }
});

app.post('/api/action-compilation-upload-sessions/:id/complete', (req, res) => {
    try {
        const existing = compilationUploadManager.readQueuedResult(req.params.id);
        if (existing) return res.status(202).json(existing);
    } catch (error) {
        return sendCompilationUploadError(res, error);
    }
    reconcileActiveJobState();
    if (readActiveJobState().active || compilationAdmissionActive) {
        return res.status(409).json({ error: 'Another render job is already running' });
    }
    compilationAdmissionActive = true;
    try {
        const project = compilationUploadManager.finalizedProject(req.params.id)
            || compilationUploadManager.finalize(req.params.id);
        const queued = startCompilationProject(project);
        compilationUploadManager.recordQueued(project.projectId, queued);
        return res.status(202).json(queued);
    } catch (error) {
        return sendCompilationUploadError(res, error);
    } finally {
        compilationAdmissionActive = false;
    }
});

app.delete('/api/action-compilation-upload-sessions/:id', (req, res) => {
    try {
        const discarded = compilationUploadManager.discard(req.params.id);
        return res.status(discarded ? 200 : 404).json({
            status: discarded ? 'discarded' : 'not_found',
            sessionId: req.params.id,
        });
    } catch (error) {
        return sendCompilationUploadError(res, error);
    }
});

app.use('/api/action-compilations', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
        return res.status(411).json({ error: 'Compilation uploads require a Content-Length header' });
    }
    // Reject before express-fileupload stages the multipart body. The small
    // allowance covers multipart field/header overhead beyond source bytes.
    const uploadCapabilities = compilationUploadManager.capabilities();
    if (declaredLength > uploadCapabilities.maxTotalBytes + 16 * 1024 * 1024) {
        return res.status(413).json({
            error: `Compilation uploads are limited to ${formatBytes(uploadCapabilities.maxTotalBytes)} total`,
        });
    }
    try {
        compilationUploadManager.ensureCapacity(declaredLength, { includePending: true });
    } catch (error) {
        return sendCompilationUploadError(res, error);
    }
    return next();
});
app.use(fileUpload({
    limits: { fileSize: Math.max(MAX_UPLOAD_BYTES, MAX_COMPILATION_FILE_BYTES) },
    abortOnLimit: true,
    useTempFiles: true,
    tempFileDir: COMPILATION_TEMP_DIR,
    uploadTimeout: UPLOAD_IDLE_TIMEOUT_MS, // wait this long for the next chunk; 0 disables idle timeout
    debug: false
}));
app.use('/api/provider-settings', (req, res, next) => {
    if (req.method !== 'PUT') return next();
    const declaredLength = Number.parseInt(String(req.headers['content-length'] || ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES) {
        return res.status(413).json({ error: 'Provider settings payload is too large' });
    }
    return next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

function defaultActiveJobState() {
    return {
        jobId: null,
        active: false,
        recovered: false,
        label: null,
        source: null,
        pid: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        exitCode: null,
        error: null,
        computeDevice: 'auto',
        videoEncoder: 'auto',
        transcriptionProvider: 'auto',
        transcriptionModel: null,
        transcriptionPreset: 'final',
        transcriptionLanguage: 'auto',
        localSemantic: true,
        geminiAnalysis: false,
        reviewBeforeRender: false,
        exportPreset: 'generic'
    };
}

function readActiveJobState() {
    const fallback = defaultActiveJobState();
    if (!fs.existsSync(ACTIVE_JOB_STATE_PATH)) return fallback;
    try {
        const parsed = JSON.parse(fs.readFileSync(ACTIVE_JOB_STATE_PATH, 'utf8'));
        const state = { ...fallback, ...(parsed || {}) };
        // Backward compatibility for states written by a short-lived tracker
        // regression that stored the complete history entry instead of its ID.
        if (state.jobId && typeof state.jobId === 'object') {
            state.jobId = typeof state.jobId.id === 'string' ? state.jobId.id : null;
        } else if (state.jobId !== null && typeof state.jobId !== 'string') {
            state.jobId = null;
        }
        return state;
    } catch (_) {
        return fallback;
    }
}

function writeActiveJobState(state) {
    fs.writeFileSync(
        ACTIVE_JOB_STATE_PATH,
        JSON.stringify({ ...defaultActiveJobState(), ...(state || {}) }, null, 2)
    );
}

function patchActiveJobState(patch) {
    const nextState = {
        ...readActiveJobState(),
        ...(patch || {}),
        updatedAt: new Date().toISOString()
    };
    writeActiveJobState(nextState);
    return nextState;
}

function isPidRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function trimLogHistory() {
    if (currentLogs.length > LOG_HISTORY_LIMIT) {
        currentLogs.splice(0, currentLogs.length - LOG_HISTORY_LIMIT);
    }
}

function normalizeLogLines(input) {
    const rawLines = Array.isArray(input) ? input : [input];
    const normalized = [];

    for (const rawLine of rawLines) {
        const text = String(rawLine ?? '');
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed) normalized.push(trimmed);
        }
    }

    return normalized;
}

function appendActiveJobLog(lines) {
    const normalized = normalizeLogLines(lines);
    if (!normalized.length) return;

    currentLogs.push(...normalized);
    trimLogHistory();
    fs.appendFileSync(ACTIVE_JOB_LOG_PATH, normalized.join('\n') + '\n');
}

function resetActiveJobTracking(meta, initialLines = []) {
    currentLogs.length = 0;
    fs.writeFileSync(ACTIVE_JOB_LOG_PATH, '');
    writeActiveJobState({
        ...defaultActiveJobState(),
        active: true,
        recovered: false,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(meta || {})
    });
    appendActiveJobLog(initialLines);
}

function readLogTail(filePath, maxBytes = ACTIVE_JOB_LOG_TAIL_BYTES) {
    if (!fs.existsSync(filePath)) return '';
    const stats = fs.statSync(filePath);
    if (!stats.size) return '';

    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');

    try {
        fs.readSync(fd, buffer, 0, length, start);
    } finally {
        fs.closeSync(fd);
    }

    return buffer.toString('utf8');
}

function getDisplayLogLines(limit = 50) {
    const rawTail = readLogTail(ACTIVE_JOB_LOG_PATH);
    const filteredLines = rawTail
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !NOISY_LOG_PATTERNS.some(pattern => line.includes(pattern)));

    if (filteredLines.length) return filteredLines.slice(-limit);

    const state = readActiveJobState();
    if (state.active) {
        const label = state.label || (state.source ? path.basename(String(state.source)) : 'current job');
        const recoveryNote = state.recovered
            ? '⚠️ Dashboard restarted during this run. Live logs are not attached, but processing is still active.'
            : '⏳ Processing is active. Waiting for worker output...';
        const lines = [`⏳ Active job: ${label}`, recoveryNote];
        if (state.pid) lines.push(`Worker PID: ${state.pid}`);
        return lines;
    }

    return currentLogs.slice(-limit);
}

function detectUntrackedFactoryJob() {
    const result = spawnSync('pgrep', ['-af', 'viral_factory.py'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return null;

    const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) continue;

        const pid = Number.parseInt(match[1], 10);
        const command = match[2];
        if (!Number.isInteger(pid) || pid <= 0) continue;
        if (!command.includes(path.basename(SCRIPT_PATH))) continue;

        const sourceMatch = command.match(/viral_factory\.py\s+(\S+)/);
        const source = sourceMatch ? sourceMatch[1] : null;
        const label = source ? path.basename(source) : 'Recovered active job';

        return {
            active: true,
            recovered: true,
            pid,
            source,
            label,
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            error: null
        };
    }

    return null;
}

function reconcileActiveJobState() {
    const state = readActiveJobState();
    const activePidIsRunning = state.active && isPidRunning(state.pid);
    const reconciledHistory = reconcileRunningJobHistory(
        readJobsHistory(),
        activePidIsRunning ? { jobId: state.jobId, pid: state.pid } : {},
    );
    if (reconciledHistory.changed) writeJobsHistory(reconciledHistory.jobs);
    if (activePidIsRunning) return;

    if (state.active) {
        writeActiveJobState({
            ...state,
            active: false,
            finishedAt: state.finishedAt || new Date().toISOString(),
            error: state.error || 'Dashboard restarted before the worker reported completion',
        });
    }

    const recoveredJob = detectUntrackedFactoryJob();
    if (recoveredJob) {
        writeActiveJobState({
            ...defaultActiveJobState(),
            ...recoveredJob,
            updatedAt: new Date().toISOString()
        });
    }
}

function spawnTrackedFactoryJob({ args, cwd, initialLines, stateMeta, onError, onClose }) {
    resetActiveJobTracking(stateMeta, initialLines);

    let logFd = null;
    try {
        logFd = fs.openSync(ACTIVE_JOB_LOG_PATH, 'a');
        const subprocess = spawn(PYTHON_BIN, ['-u', ...args], {
            cwd,
            stdio: ['ignore', logFd, logFd]
        });

        patchActiveJobState({ pid: subprocess.pid });

        subprocess.on('error', (err) => {
            appendActiveJobLog(`❌ Process error: ${err.message}`);
            patchActiveJobState({
                active: false,
                finishedAt: new Date().toISOString(),
                error: err.message
            });
            if (typeof onError === 'function') onError(err);
        });

        subprocess.on('close', (code) => {
            const exitCode = Number.isInteger(code) ? code : null;
            patchActiveJobState({
                active: false,
                finishedAt: new Date().toISOString(),
                exitCode,
                error: exitCode && exitCode !== 0 ? `Process exited with code ${exitCode}` : null
            });
            if (exitCode && exitCode !== 0) {
                appendActiveJobLog(`❌ Process exited with code ${exitCode}`);
            }
            if (typeof onClose === 'function') onClose(exitCode);
        });

        return subprocess;
    } finally {
        if (logFd !== null) fs.closeSync(logFd);
    }
}

reconcileActiveJobState();
cleanupExpiredUploadSessions();

// ── Clips list cache ─────────────────────────────────────────────────────────
// Re-reading 150+ files + existsSync on every request is slow.
// Cache the result and invalidate only when files actually change.
let _clipsCache = null;
const SCORE_FILENAME_RE = /score_([0-9]+(?:\.[0-9]+)?)/i;

function readClipMetaSync(fileName) {
    const jsonPath = path.join(CLIPS_DIR, fileName.replace(/\.mp4$/i, '.json'));
    if (!fs.existsSync(jsonPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
        return null;
    }
}

function resolveCandidateManifest(meta) {
    const requested = typeof meta?.candidate_manifest === 'string' ? meta.candidate_manifest : '';
    if (!requested) return null;
    const resolved = path.resolve(requested);
    const allowedRoot = path.resolve(CANDIDATE_MANIFESTS_DIR) + path.sep;
    if (!resolved.startsWith(allowedRoot) || !fs.existsSync(resolved)) return null;
    return resolved;
}

function candidateManifestAvailability(meta) {
    const manifestPath = resolveCandidateManifest(meta);
    if (!manifestPath) return { manifestPath: null, remaining: 0 };
    const manifest = readJsonFile(manifestPath, null);
    if (!manifest || manifest.kind !== 'shorts_candidate_manifest' || !Array.isArray(manifest.candidates)) {
        return { manifestPath: null, remaining: 0 };
    }
    const exported = new Set((manifest.exported_candidate_ids || []).map(String));
    const failed = new Set((manifest.failed_candidate_ids || []).map(String));
    const remaining = manifest.candidates.filter((candidate) => {
        const id = String(candidate?.yield_id || candidate?.id || '');
        return id && !exported.has(id) && !failed.has(id);
    }).length;
    return { manifestPath, remaining };
}

function buildClipsCache(cb) {
    fs.readdir(CLIPS_DIR, (err, files) => {
        if (err) { _clipsCache = []; return cb([]); }
        const clips = files
            .filter(f => /\.mp4$/i.test(f))
            .map(f => {
                const meta = readClipMetaSync(f);
                const manifestAvailability = candidateManifestAvailability(meta);
                const jsonPath = path.join(CLIPS_DIR, f.replace(/\.mp4$/i, '.json'));
                const scoreFromName = f.match(SCORE_FILENAME_RE)?.[1] || 'N/A';
                const kind = meta?.kind === 'longform' || /^longform[_-]|[_-]longform[_-]/i.test(f)
                    ? 'longform'
                    : 'shorts';
                return {
                    name: f,
                    url: `/clips/${encodeURIComponent(f)}`,
                    kind,
                    score: typeof meta?.score === 'number' ? meta.score : scoreFromName,
                    candidateScore: typeof meta?.candidate_score === 'number' ? meta.candidate_score : null,
                    reasons: Array.isArray(meta?.reasons) ? meta.reasons.slice(0, 4) : [],
                    topics: Array.isArray(meta?.topics) ? meta.topics.slice(0, 8) : [],
                    scoreBreakdown: meta?.score_breakdown || null,
                    rankingVersion: meta?.ranking_version || null,
                    confidenceTier: meta?.confidence_tier || null,
                    yieldRole: meta?.yield_role || null,
                    yieldPlan: meta?.yield_plan || null,
                    canGenerateMore: manifestAvailability.remaining > 0,
                    remainingCandidates: manifestAvailability.remaining,
                    transcriptionProvider: meta?.transcription_provider || null,
                    computeBackend: meta?.compute_backend || null,
                    videoEncoder: meta?.video_encoder || null,
                    exportPreset: meta?.export_preset || 'generic',
                    sourceKind: meta?.source_kind || 'single',
                    compilationName: meta?.compilation_name || null,
                    hasSubtitleData: fs.existsSync(jsonPath),
                    baked: meta?.baked === true
                };
            });
        _clipsCache = clips;
        cb(clips);
    });
}

// Watch clips dir so cache is invalidated the moment a file is added or removed
chokidar.watch(CLIPS_DIR, { persistent: true, ignoreInitial: true, depth: 0 })
    .on('add',    () => { _clipsCache = null; })
    .on('change', () => { _clipsCache = null; })
    .on('unlink', () => { _clipsCache = null; });

// ── Hot-folder Watcher ───────────────────────────────────────────────────────
const watcher = chokidar.watch(PENDING_DIR, {
    persistent: true,
    awaitWriteFinish: {
        stabilityThreshold: 5000,
        pollInterval: 1000
    }
});

// Only process real video files; ignore dotfiles, sidecar metadata, etc.
const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi|mpg|mpeg|ts|mts|m2ts|flv|wmv)$/i;

watcher.on('add', (filePath) => {
    const fileName = path.basename(filePath);
    if (fileName.startsWith('.')) return;            // .gitkeep, .DS_Store, …
    if (!VIDEO_EXT.test(fileName)) {
        console.log(`📂 Ignored (not a video): ${filePath}`);
        return;
    }
    console.log(`📂 New File Detected: ${filePath}`);
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const processingPath = path.join(PROCESSING_DIR, safeName);
    
    // Move to processing
    try {
        fs.renameSync(filePath, processingPath);
    } catch (renameErr) {
        console.error(`[Watcher] Failed to move file: ${renameErr.message}`);
        return;
    }
    
    const options = resolveServerJobOptions({ mode: 'shorts' });
    const runtimeMeta = buildTrackedJobMeta(options);
    const args = buildFactoryArgsForUpload(processingPath, options);

    spawnTrackedFactoryJob({
        args,
        cwd: path.join(__dirname, '..'),
        initialLines: [
            `🚀 Hot Folder Job Started: ${safeName}`,
            ...runtimeMeta.preflightWarnings.map((item) => `⚠️ ${item.message}`),
        ],
        stateMeta: {
            label: safeName,
            source: processingPath,
            ...runtimeMeta,
            exportPreset: options.exportPreset,
        },
        onError: (err) => {
            console.error(`[Factory Spawn Error]: ${err.message}`);
        }
    });
});

// Get Logs
app.get('/api/logs', (req, res) => {
    reconcileActiveJobState();
    res.json(getDisplayLogLines(50));
});

app.get('/api/job-status', (req, res) => {
    reconcileActiveJobState();
    res.json(readActiveJobState());
});

// Validate clip name to prevent path traversal
function isValidClipName(name) {
    return /^[a-zA-Z0-9._-]+\.mp4$/i.test(name) && !name.includes('..');
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function buildRerenderPayload(meta, overrides = {}) {
    const payload = { ...meta };

    if (hasOwn(overrides, 'words') && Array.isArray(overrides.words)) {
        payload.words = overrides.words;
    } else if (!Array.isArray(payload.words)) {
        payload.words = meta.words || [];
    }

    if (hasOwn(overrides, 'style')) {
        payload.style = overrides.style || meta.style || 'classic';
    } else if (!payload.style) {
        payload.style = meta.style || 'classic';
    }

    if (hasOwn(overrides, 'animation')) {
        payload.animation = overrides.animation || 'none';
    } else if (!hasOwn(payload, 'animation')) {
        payload.animation = meta.animation || 'none';
    }

    if (hasOwn(overrides, 'font')) {
        payload.font = overrides.font || null;
    } else if (!hasOwn(payload, 'font')) {
        payload.font = meta.font || null;
    }

    if (hasOwn(overrides, 'posX')) payload.subtitle_x = overrides.posX;
    else if (!hasOwn(payload, 'subtitle_x')) payload.subtitle_x = meta.subtitle_x ?? null;

    if (hasOwn(overrides, 'posY')) payload.subtitle_y = overrides.posY;
    else if (!hasOwn(payload, 'subtitle_y')) payload.subtitle_y = meta.subtitle_y ?? null;

    if (hasOwn(overrides, 'fontSize')) payload.subtitle_fontsize = overrides.fontSize;
    else if (!hasOwn(payload, 'subtitle_fontsize')) payload.subtitle_fontsize = meta.subtitle_fontsize ?? null;

    if (hasOwn(overrides, 'glow')) payload.subtitle_glow = overrides.glow === true;
    else if (!hasOwn(payload, 'subtitle_glow')) payload.subtitle_glow = meta.subtitle_glow === true;

    if (hasOwn(overrides, 'width')) payload.subtitle_width = overrides.width;
    else if (!hasOwn(payload, 'subtitle_width')) payload.subtitle_width = meta.subtitle_width ?? null;

    if (hasOwn(overrides, 'videoZoom')) {
        const zoomVal = parseFloat(overrides.videoZoom);
        if (!Number.isNaN(zoomVal) && zoomVal > 1.01) {
            payload.video_zoom = zoomVal;
            payload.video_pan_x = Number.parseFloat(overrides.videoPanX) || 0;
            payload.video_pan_y = Number.parseFloat(overrides.videoPanY) || 0;
        } else {
            payload.video_zoom = 1.0;
            payload.video_pan_x = 0.0;
            payload.video_pan_y = 0.0;
        }
    } else {
        payload.video_zoom = Number.parseFloat(meta.video_zoom) || 1.0;
        payload.video_pan_x = Number.parseFloat(meta.video_pan_x) || 0.0;
        payload.video_pan_y = Number.parseFloat(meta.video_pan_y) || 0.0;
    }

    return payload;
}

function resolveSourcePath(sourcePath) {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) return null;
    return path.isAbsolute(sourcePath)
        ? sourcePath
        : path.resolve(path.join(__dirname, '..'), sourcePath);
}

function chooseRerenderSource(meta, clipPath, jsonPath) {
    const resolvedSource = resolveSourcePath(meta?.source);
    if (!resolvedSource || !fs.existsSync(resolvedSource)) {
        return { sourcePath: clipPath, fallbackReason: 'missing-source' };
    }

    const normalizedTempDir = path.resolve(TEMP_DIR) + path.sep;
    const normalizedSource = path.resolve(resolvedSource);
    const isReusableTempSource =
        path.basename(normalizedSource) === 'input_sanitized.mp4' ||
        normalizedSource.startsWith(normalizedTempDir);

    if (isReusableTempSource) {
        try {
            const sourceStat = fs.statSync(normalizedSource);
            const jsonStat = fs.statSync(jsonPath);
            if (sourceStat.mtimeMs > jsonStat.mtimeMs + 5000) {
                return { sourcePath: clipPath, fallbackReason: 'stale-temp-source' };
            }
        } catch (_) {
            return { sourcePath: clipPath, fallbackReason: 'source-stat-failed' };
        }
    }

    return { sourcePath: normalizedSource, fallbackReason: null };
}

function rebaseWordsForClipSource(words, startOffset) {
    if (!Array.isArray(words) || !Number.isFinite(startOffset) || startOffset === 0) {
        return Array.isArray(words) ? words : [];
    }

    return words.map(word => {
        if (!word || typeof word !== 'object') return word;
        const rebased = { ...word };
        if (Number.isFinite(word.start)) rebased.start = Math.max(0, word.start - startOffset);
        if (Number.isFinite(word.end)) rebased.end = Math.max(0, word.end - startOffset);
        return rebased;
    });
}

function normalizePayloadForClipSource(payload, meta, usingClipFallback) {
    if (!usingClipFallback) return payload;

    const clipDuration = Number.parseFloat(meta.duration) || Math.max(0, (Number(meta.end) || 0) - (Number(meta.start) || 0));
    const startOffset = Number.parseFloat(meta.start) || 0;

    payload.start = 0;
    payload.end = clipDuration > 0 ? clipDuration : Math.max(0.1, Number.parseFloat(payload.end) || 0);
    payload.duration = payload.end;
    payload.words = rebaseWordsForClipSource(payload.words, startOffset);

    return payload;
}

function rerenderRuntimeArgs(meta = {}) {
    const normalized = normalizeUploadOptions({
        videoEncoder: meta.video_encoder || 'auto',
        exportPreset: meta.export_preset || 'generic',
        outputNameTemplate: meta.output_name_template,
    });
    return [
        '--video-encoder', normalized.videoEncoder,
        '--export-preset', normalized.exportPreset,
        '--output-name-template', normalized.outputNameTemplate,
    ];
}

// Get Clips — served from cache; rebuilds only after a file add/delete
app.get('/api/clips', (req, res) => {
    if (_clipsCache) return res.json(_clipsCache);
    buildClipsCache(clips => res.json(clips));
});

// Get subtitle data for a clip
app.get('/api/clips/:name/subtitles', (req, res) => {
    if (!isValidClipName(req.params.name)) return res.status(400).json({ error: 'Invalid clip name' });
    const jsonName = req.params.name.replace(/\.mp4$/i, '.json');
    const jsonPath = path.join(CLIPS_DIR, jsonName);
    if (fs.existsSync(jsonPath)) {
        try {
            const data = fs.readFileSync(jsonPath, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            res.send(data);
        } catch (e) {
            res.status(500).json({ error: 'Failed to read subtitle data' });
        }
    } else {
        res.status(404).json({ error: 'No subtitle data found for this clip' });
    }
});

// Re-render clip with edited subtitles
app.post('/api/clips/:name/subtitles', express.json({ limit: '10mb' }), (req, res) => {
    const clipName = req.params.name;
    if (!isValidClipName(clipName)) return res.status(400).json({ error: 'Invalid clip name' });
    const clipPath = path.join(CLIPS_DIR, clipName);
    const outputPath = clipPath;
    const jsonName = clipName.replace(/\.mp4$/i, '.json');
    const jsonPath = path.join(CLIPS_DIR, jsonName);

    if (!fs.existsSync(jsonPath)) {
        return res.status(404).json({ error: 'Clip metadata not found' });
    }

    let meta;
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch (e) { return res.status(500).json({ error: 'Corrupt metadata file' }); }
    const { sourcePath: rerenderSource, fallbackReason } = chooseRerenderSource(meta, clipPath, jsonPath);
    // Write updated metadata to temp file
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const tempJson = path.join(TEMP_DIR, `edited_${Date.now()}.json`);
    const payload = normalizePayloadForClipSource(
        buildRerenderPayload(meta, req.body || {}),
        meta,
        Boolean(fallbackReason),
    );
    payload.source = rerenderSource;
    fs.writeFileSync(tempJson, JSON.stringify(payload));

    if (fallbackReason) {
        const msg = `⚠️ Re-render source fallback for ${clipName}: ${fallbackReason}`;
        console.warn(msg);
    }

    const args = [SCRIPT_PATH, rerenderSource, '--mode', 'rerender',
                  '--rerender-json', tempJson, '--rerender-output', outputPath,
                  ...rerenderRuntimeArgs(meta)];

    spawnTrackedFactoryJob({
        args,
        cwd: path.join(__dirname, '..'),
        initialLines: fallbackReason
            ? [`🔄 Re-rendering: ${clipName}`, `⚠️ Re-render source fallback for ${clipName}: ${fallbackReason}`]
            : [`🔄 Re-rendering: ${clipName}`],
        stateMeta: {
            label: `Re-render: ${clipName}`,
            source: rerenderSource
        },
        onError: (err) => {
            console.error(`[Rerender Spawn Error]: ${err.message}`);
            try { fs.unlinkSync(tempJson); } catch (_) {}
            if (!res.headersSent) res.status(500).json({ error: err.message });
        },
        onClose: (code) => {
            try { fs.unlinkSync(tempJson); } catch (_) {}
            if (code === 0) {
                res.json({ status: 'ok', message: 'Clip re-rendered with edited subtitles' });
            } else {
                res.status(500).json({ error: 'Re-render failed', code });
            }
        }
    });
});

// Upload & Process
app.post('/api/upload-sessions', (req, res) => {
    try {
        cleanupExpiredUploadSessions();

        const body = req.body || {};
        const totalSize = Number.parseInt(body.fileSize, 10);
        const originalName = String(body.fileName || '').trim();
        const baseSafeName = sanitizeUploadFilename(originalName);
        const fingerprint = String(body.fingerprint || '').trim();

        if (!originalName || !Number.isFinite(totalSize) || totalSize <= 0) {
            return res.status(400).json({ error: 'Missing file metadata' });
        }
        if (totalSize > MAX_UPLOAD_BYTES) {
            return res.status(400).json({ error: 'File exceeds the 50GB upload limit' });
        }

        let session = readUploadSession(body.sessionId) || findReusableUploadSession(fingerprint);
        if (session && (session.totalSize !== totalSize || sanitizeUploadFilename(session.originalName) !== baseSafeName)) {
            session = null;
        }

        const options = resolveServerJobOptions(body);
        const now = new Date().toISOString();

        if (!session || ['processing', 'completed'].includes(session.status)) {
            const sessionId = crypto.randomUUID();
            const safeName = uniqueUploadFilename(originalName);
            session = writeUploadSession({
                id: sessionId,
                fingerprint: fingerprint || crypto.createHash('sha1').update(`${baseSafeName}:${totalSize}:${body.lastModified || ''}`).digest('hex'),
                originalName,
                safeName,
                mimeType: String(body.mimeType || ''),
                totalSize,
                receivedBytes: 0,
                chunkSize: RESUMABLE_CHUNK_BYTES,
                lastModified: body.lastModified ? String(body.lastModified) : null,
                status: 'uploading',
                tempPath: uploadSessionTempPath(sessionId),
                createdAt: now,
                updatedAt: now,
                options
            });
        } else {
            const tempPath = session.tempPath || uploadSessionTempPath(session.id);
            let receivedBytes = session.receivedBytes;
            try {
                if (fs.existsSync(tempPath)) {
                    receivedBytes = fs.statSync(tempPath).size;
                } else if (receivedBytes > 0) {
                    receivedBytes = 0;
                }
            } catch (_) {}

            session = writeUploadSession({
                ...session,
                originalName,
                mimeType: String(body.mimeType || session.mimeType || ''),
                lastModified: body.lastModified ? String(body.lastModified) : session.lastModified,
                tempPath,
                receivedBytes,
                status: receivedBytes >= totalSize ? 'uploaded' : 'uploading',
                error: null,
                options
            });
        }

        res.json({
            sessionId: session.id,
            safeName: session.safeName,
            totalSize: session.totalSize,
            receivedBytes: session.receivedBytes,
            chunkSize: session.chunkSize || RESUMABLE_CHUNK_BYTES,
            status: session.status
        });
    } catch (err) {
        console.error('[Upload Session Init Error]', err);
        res.status(500).json({ error: 'Could not initialize resumable upload session' });
    }
});

app.get('/api/upload-sessions/:id', (req, res) => {
    try {
        const session = readUploadSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Upload session not found' });

        let receivedBytes = session.receivedBytes;
        try {
            if (session.tempPath && fs.existsSync(session.tempPath)) {
                receivedBytes = fs.statSync(session.tempPath).size;
            } else if (session.status !== 'processing') {
                receivedBytes = 0;
            }
        } catch (_) {}

        const normalized = receivedBytes !== session.receivedBytes
            ? writeUploadSession({
                ...session,
                receivedBytes,
                status: receivedBytes >= session.totalSize ? 'uploaded' : session.status
            })
            : session;

        res.json({
            sessionId: normalized.id,
            safeName: normalized.safeName,
            totalSize: normalized.totalSize,
            receivedBytes: normalized.receivedBytes,
            chunkSize: normalized.chunkSize || RESUMABLE_CHUNK_BYTES,
            status: normalized.status
        });
    } catch (err) {
        console.error('[Upload Session Status Error]', err);
        res.status(500).json({ error: 'Could not load upload session status' });
    }
});

app.post('/api/upload-sessions/:id/chunk', async (req, res) => {
    let tempChunkPath = null;

    try {
        const session = readUploadSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Upload session not found' });
        if (session.status === 'processing') {
            return res.status(409).json({ error: 'Upload already finalized', receivedBytes: session.receivedBytes });
        }
        if (!req.files || !req.files.chunk) {
            return res.status(400).json({ error: 'Missing chunk payload' });
        }

        const chunk = req.files.chunk;
        tempChunkPath = chunk.tempFilePath;
        const offset = Number.parseInt(req.body.offset, 10);
        if (!Number.isFinite(offset) || offset < 0) {
            return res.status(400).json({ error: 'Missing chunk offset' });
        }

        const tempPath = session.tempPath || uploadSessionTempPath(session.id);
        let receivedBytes = 0;
        if (fs.existsSync(tempPath)) {
            receivedBytes = fs.statSync(tempPath).size;
        }

        if (receivedBytes !== session.receivedBytes) {
            session.receivedBytes = receivedBytes;
        }

        if (offset < receivedBytes) {
            const chunkEnd = offset + chunk.size;
            if (chunkEnd <= receivedBytes) {
                return res.json({
                    status: 'duplicate',
                    receivedBytes,
                    totalSize: session.totalSize,
                    complete: receivedBytes >= session.totalSize
                });
            }
            return res.status(409).json({
                error: 'Chunk offset mismatch',
                receivedBytes,
                totalSize: session.totalSize
            });
        }

        if (offset !== receivedBytes) {
            return res.status(409).json({
                error: 'Chunk offset mismatch',
                receivedBytes,
                totalSize: session.totalSize
            });
        }

        if (receivedBytes + chunk.size > session.totalSize) {
            return res.status(400).json({
                error: 'Chunk exceeds declared file size',
                receivedBytes,
                totalSize: session.totalSize
            });
        }

        await appendTempChunkToUpload(tempChunkPath, tempPath);
        const persistedBytes = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;
        if (persistedBytes <= receivedBytes) {
            throw new Error(`Chunk persistence failed for ${session.id}: expected > ${receivedBytes}, got ${persistedBytes}`);
        }

        writeUploadSession({
            ...session,
            tempPath,
            receivedBytes: persistedBytes,
            chunkSize: Number.parseInt(req.body.chunkSize, 10) || session.chunkSize || RESUMABLE_CHUNK_BYTES,
            status: persistedBytes >= session.totalSize ? 'uploaded' : 'uploading',
            error: null
        });

        res.json({
            status: 'ok',
            receivedBytes: persistedBytes,
            totalSize: session.totalSize,
            complete: persistedBytes >= session.totalSize
        });
    } catch (err) {
        console.error('[Upload Chunk Error]', err);
        res.status(500).json({ error: 'Could not append upload chunk' });
    } finally {
        if (tempChunkPath) {
            try { fs.unlinkSync(tempChunkPath); } catch (_) {}
        }
    }
});

app.post('/api/upload-sessions/:id/complete', (req, res) => {
    try {
        const session = readUploadSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Upload session not found' });

        if (session.status === 'processing') {
            return res.json({ status: 'queued', message: 'Upload already finalized. Processing is running.' });
        }

        const tempPath = session.tempPath || uploadSessionTempPath(session.id);
        const receivedBytes = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;
        if (receivedBytes < session.totalSize) {
            return res.status(409).json({
                error: 'Upload is incomplete',
                receivedBytes,
                totalSize: session.totalSize
            });
        }

        const uploadPath = path.join(UPLOAD_DIR, session.safeName);
        try {
            fs.renameSync(tempPath, uploadPath);
        } catch (err) {
            if (err.code !== 'EXDEV') throw err;
            fs.copyFileSync(tempPath, uploadPath);
            fs.unlinkSync(tempPath);
        }

        writeUploadSession({
            ...session,
            tempPath,
            uploadPath,
            receivedBytes: session.totalSize,
            status: 'processing',
            processingStartedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            error: null
        });

        triggerFactoryForUploadedFile(uploadPath, session.safeName, session.options);
        res.json({ status: 'queued', message: 'Upload received! Processing started.' });
    } catch (err) {
        console.error('[Upload Finalize Error]', err);
        res.status(500).json({ error: 'Could not finalize upload' });
    }
});

app.post('/api/upload', (req, res) => {
    if (!req.files || !req.files.video) return res.status(400).send('No video uploaded');
    
    const video = req.files.video;
    const safeName = uniqueUploadFilename(video.name);
    const uploadPath = path.join(UPLOAD_DIR, safeName);
    const options = resolveServerJobOptions(req.body || {});

    video.mv(uploadPath, (err) => {
        if (err) {
            console.error('Upload move failed:', err);
            return res.status(500).json({ error: 'Could not store uploaded file' });
        }
        triggerFactoryForUploadedFile(uploadPath, safeName, options);
        return res.json({ status: 'queued', message: 'Upload received! Processing started.' });
    });
});

// Process URL (YouTube)
app.post('/api/process-url', (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: "Missing URL" });

    const normalized = resolveServerJobOptions(req.body);
    const args = buildFactoryArgsForUpload(url, normalized);
    const runtimeMeta = buildTrackedJobMeta(normalized);

    console.log(`🎬 Triggering Factory (URL): ${args.join(' ')}`);

    spawnTrackedFactoryJob({
        args,
        cwd: path.join(__dirname, '..'),
        initialLines: [
            `🚀 Video Job Started: ${url}`,
            ...runtimeMeta.preflightWarnings.map((item) => `⚠️ ${item.message}`),
        ],
        stateMeta: {
            label: url,
            source: url,
            ...runtimeMeta,
            exportPreset: normalized.exportPreset,
        },
        onError: (err) => {
            console.error(`[Factory Spawn Error]: ${err.message}`);
        }
    });

    res.json({ status: 'processing', message: 'YouTube download started' });
});

// Bake & Download — start async render job, returns jobId immediately
app.post('/api/clips/:name/render-download', express.json({ limit: '10mb' }), (req, res) => {
    const clipName = req.params.name;
    if (!isValidClipName(clipName)) return res.status(400).json({ error: 'Invalid clip name' });
    const clipPath = path.join(CLIPS_DIR, clipName);
    const jsonName = clipName.replace(/\.mp4$/i, '.json');
    const jsonPath = path.join(CLIPS_DIR, jsonName);

    if (!fs.existsSync(jsonPath)) {
        return res.status(404).json({ error: 'Clip metadata not found' });
    }

    let meta;
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
    catch (e) { return res.status(500).json({ error: 'Corrupt metadata file' }); }
    const { sourcePath: rerenderSource, fallbackReason } = chooseRerenderSource(meta, clipPath, jsonPath);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const stamp = Date.now();
    const jobId      = stamp.toString();
    const tempJson   = path.join(TEMP_DIR, `bake_request_${stamp}.json`);
    const tempOutput = path.join(TEMP_DIR, `bake_${stamp}.mp4`);
    const tempOutputJson = tempOutput.replace(/\.mp4$/i, '.json');
    const clipDuration = (meta.end || 0) - (meta.start || 0);

    const draftPayload = buildRerenderPayload(meta, req.body || {});
    try {
        fs.writeFileSync(jsonPath, JSON.stringify(draftPayload, null, 2));
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save subtitle draft' });
    }

    const payload = normalizePayloadForClipSource(
        { ...draftPayload },
        meta,
        Boolean(fallbackReason),
    );
    payload.source = rerenderSource;
    fs.writeFileSync(tempJson, JSON.stringify(payload));

    bakeJobs[jobId] = {
        progress: 0,
        done: false,
        error: null,
        outputPath: tempOutput,
        outputJsonPath: tempOutputJson,
        clipName
    };

    if (fallbackReason) {
        console.warn(`[BakeRender] Source fallback for ${clipName}: ${fallbackReason}`);
    }

    const args = [SCRIPT_PATH, rerenderSource, '--mode', 'rerender',
                  '--rerender-json', tempJson, '--rerender-output', tempOutput,
                  ...rerenderRuntimeArgs(meta)];

    const subprocess = spawn(PYTHON_BIN, ['-u', ...args], { cwd: path.join(__dirname, '..') });

    // File-size based progress: poll tempOutput growth vs expected size (15Mbps bitrate)
    // This is reliable regardless of FFmpeg stderr buffering through the Python subprocess pipe
    const estBytes = clipDuration > 0 ? clipDuration * 1875000 : 0; // 15Mbps = 1.875MB/s
    let sizePollTimer = estBytes > 0 ? setInterval(() => {
        if (!bakeJobs[jobId] || bakeJobs[jobId].done) { clearInterval(sizePollTimer); sizePollTimer = null; return; }
        try {
            const { size } = fs.statSync(tempOutput);
            const pct = Math.min(95, Math.round(size / estBytes * 100));
            if (pct > bakeJobs[jobId].progress) bakeJobs[jobId].progress = pct;
        } catch (_) {}
    }, 500) : null;

    subprocess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log('[BakeRender stdout]', msg);
    });
    subprocess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.startsWith('out_') && !msg.startsWith('progress=') && !msg.startsWith('speed=') && !msg.startsWith('fps=') && !msg.startsWith('bitrate=') && !msg.startsWith('total_size=') && !msg.startsWith('dup_') && !msg.startsWith('drop_') && !msg.startsWith('stream_') && !msg.startsWith('frame=')) {
            console.log('[BakeRender]', msg);
        }
    });
    subprocess.on('error', (err) => {
        clearInterval(sizePollTimer); sizePollTimer = null;
        console.error(`[BakeRender Spawn Error]: ${err.message}`);
        try { fs.unlinkSync(tempJson); } catch (_) {}
        try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (_) {}
        try { if (fs.existsSync(tempOutputJson)) fs.unlinkSync(tempOutputJson); } catch (_) {}
        bakeJobs[jobId].done = true;
        bakeJobs[jobId].error = err.message;
    });
    subprocess.on('close', (code) => {
        clearInterval(sizePollTimer); sizePollTimer = null;
        try { fs.unlinkSync(tempJson); } catch (_) {}
        if (code === 0 && fs.existsSync(tempOutput)) {
            bakeJobs[jobId].progress = 100;
            bakeJobs[jobId].done = true;
        } else {
            bakeJobs[jobId].done = true;
            bakeJobs[jobId].error = `Render failed (exit ${code})`;
            try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (_) {}
            try { if (fs.existsSync(tempOutputJson)) fs.unlinkSync(tempOutputJson); } catch (_) {}
        }
        // Auto-cleanup job record and any unclaimed temp outputs after 10 minutes
        setTimeout(() => {
            const staleJob = bakeJobs[jobId];
            if (staleJob) {
                try { if (fs.existsSync(staleJob.outputPath)) fs.unlinkSync(staleJob.outputPath); } catch (_) {}
                try { if (staleJob.outputJsonPath && fs.existsSync(staleJob.outputJsonPath)) fs.unlinkSync(staleJob.outputJsonPath); } catch (_) {}
                delete bakeJobs[jobId];
            }
        }, 10 * 60 * 1000);
    });

    res.json({ jobId });
});

// Poll bake job progress
app.get('/api/bake-progress/:jobId', (req, res) => {
    const job = bakeJobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    res.json({ progress: job.progress, done: job.done, error: job.error });
});

// Download completed bake
app.get('/api/bake-download/:jobId', (req, res) => {
    const job = bakeJobs[req.params.jobId];
    if (!job || !job.done || job.error) return res.status(404).json({ error: 'Not ready or failed' });
    if (!fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'Output file missing' });
    const requestedName = typeof req.query.name === 'string' ? req.query.name : '';
    const name = isValidClipName(requestedName) ? requestedName : (job.clipName || 'clip.mp4');

    fs.stat(job.outputPath, (err, stats) => {
        if (err) return res.status(404).json({ error: 'Output file missing' });

        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            try { if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch (_) {}
            try { if (job.outputJsonPath && fs.existsSync(job.outputJsonPath)) fs.unlinkSync(job.outputJsonPath); } catch (_) {}
            delete bakeJobs[req.params.jobId];
        };

        res.setHeader('Content-Length', stats.size);
        res.setHeader('Cache-Control', 'no-store');
        res.attachment(path.basename(name));
        res.type('application/octet-stream');

        const stream = fs.createReadStream(job.outputPath);
        stream.on('error', (streamErr) => {
            console.error(`[BakeDownload Stream Error]: ${streamErr.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download failed' });
            } else {
                res.destroy(streamErr);
            }
        });

        res.on('finish', cleanup);
        res.on('close', () => {
            if (res.writableFinished) cleanup();
        });

        stream.pipe(res);
    });
});

// Delete Clip
app.delete('/api/clips/:name', (req, res) => {
    if (!isValidClipName(req.params.name)) return res.status(400).json({ error: 'Invalid clip name' });
    const filePath = path.join(CLIPS_DIR, req.params.name);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ status: 'deleted' });
    } else {
        res.status(404).send('Not found');
    }
});

// Global error handler — catch any Express route errors without crashing
app.use((err, req, res, next) => {
    console.error('[Express Error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
});

// ─────────────────────────────────────────────────────────────────────────────
//  V2 UI additions — thumbnails, batch ops, job cancel, jobs history, profiles,
//  settings, and dist/ SPA serving. Existing routes above are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

[THUMB_CACHE_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function readJsonFile(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}
function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const DEFAULT_SERVER_SETTINGS = {
    computeDevice: 'auto',
    videoEncoder: 'auto',
    transcriptionProvider: 'auto',
    transcriptionModel: 'large-v3',
    transcriptionPreset: 'final',
    transcriptionLanguage: 'auto',
    localSemantic: true,
    geminiAnalysis: false,
    reviewBeforeRender: true,
    exportPreset: 'generic',
    outputNameTemplate: '{source}_{platform}_{index}_{score}',
    vaapiDevice: process.env.VCF_VAAPI_DEVICE || '/dev/dri/renderD128',
};

function normalizeServerSettings(input = {}) {
    return normalizeUploadOptions({ ...DEFAULT_SERVER_SETTINGS, ...input });
}

function readServerSettings() {
    return normalizeServerSettings(readJsonFile(SETTINGS_PATH, DEFAULT_SERVER_SETTINGS));
}

function resolveServerJobOptions(input = {}) {
    return mergeUploadOptions(input, readServerSettings(), process.env);
}

function readJobsHistory() {
    const jobs = readJsonFile(JOBS_HISTORY_PATH, []);
    return Array.isArray(jobs) ? jobs : [];
}
function writeJobsHistory(jobs) { writeJsonFile(JOBS_HISTORY_PATH, jobs.slice(-JOBS_HISTORY_LIMIT)); }

function recordJobStart(meta) {
    const jobs = readJobsHistory();
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: meta.kind || 'render',
        label: meta.label || 'Job',
        source: meta.source || null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        status: 'running',
        error: null,
        pid: meta.pid || null,
        computeDevice: meta.computeDevice || 'auto',
        videoEncoder: meta.videoEncoder || 'auto',
        transcriptionProvider: meta.transcriptionProvider || 'auto',
        transcriptionModel: meta.transcriptionModel || null,
        transcriptionPreset: meta.transcriptionPreset || 'final',
        transcriptionLanguage: meta.transcriptionLanguage || 'auto',
        localSemantic: meta.localSemantic !== false,
        geminiAnalysis: meta.geminiAnalysis === true,
        reviewBeforeRender: meta.reviewBeforeRender === true,
        requestedComputeDevice: meta.requestedComputeDevice || meta.computeDevice || 'auto',
        requestedVideoEncoder: meta.requestedVideoEncoder || meta.videoEncoder || 'auto',
        requestedTranscriptionProvider: meta.requestedTranscriptionProvider || meta.transcriptionProvider || 'auto',
        requestedTranscriptionModel: meta.requestedTranscriptionModel || meta.transcriptionModel || null,
        requestedTranscriptionPreset: meta.requestedTranscriptionPreset || meta.transcriptionPreset || 'final',
        requestedTranscriptionLanguage: meta.requestedTranscriptionLanguage || meta.transcriptionLanguage || 'auto',
        requestedLocalSemantic: meta.requestedLocalSemantic !== false,
        requestedGeminiAnalysis: meta.requestedGeminiAnalysis === true,
        effectiveComputeDevice: meta.computeDevice || 'auto',
        effectiveVideoEncoder: meta.videoEncoder || 'auto',
        effectiveTranscriptionProvider: meta.transcriptionProvider || 'auto',
        effectiveTranscriptionModel: meta.transcriptionModel || null,
        effectiveTranscriptionPreset: meta.transcriptionPreset || 'final',
        effectiveTranscriptionLanguage: meta.transcriptionLanguage || 'auto',
        effectiveLocalSemantic: meta.localSemantic !== false,
        effectiveGeminiAnalysis: meta.geminiAnalysis === true,
        preflightWarnings: Array.isArray(meta.preflightWarnings) ? meta.preflightWarnings : [],
        preflightErrors: Array.isArray(meta.preflightErrors) ? meta.preflightErrors : [],
        exportPreset: meta.exportPreset || 'generic',
    };
    jobs.push(entry);
    writeJobsHistory(jobs);
    return entry;
}

function recordJobPatch(id, patch = {}) {
    const jobs = readJobsHistory();
    const idx = jobs.findIndex((job) => job.id === id);
    if (idx === -1) return;
    jobs[idx] = { ...jobs[idx], ...patch };
    writeJobsHistory(jobs);
}

function recordJobEnd(id, { exitCode, error, status }) {
    const jobs = readJobsHistory();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return;
    const job = jobs[idx];
    if (!job.finishedAt) job.finishedAt = new Date().toISOString();
    if (typeof exitCode !== 'undefined') job.exitCode = exitCode;
    if (typeof status !== 'undefined') job.status = status;
    if (typeof error !== 'undefined') job.error = error;
    jobs[idx] = job;
    writeJobsHistory(jobs);
}

// Track the most-recently started job so we can write its id back to active-job.json
// and close the loop when it ends.
let _activeJobTracker = null;

const _origSpawnTracked = spawnTrackedFactoryJob;
spawnTrackedFactoryJob = function trackedFactoryJob(args) {
    const entry = recordJobStart({
        kind: (args && args.args && args.args.includes('--mode') && args.args[args.args.indexOf('--mode') + 1]) || 'render',
        label: (args && args.stateMeta && args.stateMeta.label) || 'Job',
        source: (args && args.stateMeta && args.stateMeta.source) || null,
        pid: null,
        computeDevice: args?.stateMeta?.computeDevice,
        videoEncoder: args?.stateMeta?.videoEncoder,
        transcriptionProvider: args?.stateMeta?.transcriptionProvider,
        transcriptionModel: args?.stateMeta?.transcriptionModel,
        transcriptionPreset: args?.stateMeta?.transcriptionPreset,
        transcriptionLanguage: args?.stateMeta?.transcriptionLanguage,
        localSemantic: args?.stateMeta?.localSemantic,
        geminiAnalysis: args?.stateMeta?.geminiAnalysis,
        reviewBeforeRender: args?.stateMeta?.reviewBeforeRender,
        requestedComputeDevice: args?.stateMeta?.requestedComputeDevice,
        requestedVideoEncoder: args?.stateMeta?.requestedVideoEncoder,
        requestedTranscriptionProvider: args?.stateMeta?.requestedTranscriptionProvider,
        requestedTranscriptionModel: args?.stateMeta?.requestedTranscriptionModel,
        requestedTranscriptionPreset: args?.stateMeta?.requestedTranscriptionPreset,
        requestedTranscriptionLanguage: args?.stateMeta?.requestedTranscriptionLanguage,
        requestedLocalSemantic: args?.stateMeta?.requestedLocalSemantic,
        requestedGeminiAnalysis: args?.stateMeta?.requestedGeminiAnalysis,
        preflightWarnings: args?.stateMeta?.preflightWarnings,
        preflightErrors: args?.stateMeta?.preflightErrors,
        exportPreset: args?.stateMeta?.exportPreset,
    });
    const id = entry.id;
    _activeJobTracker = id;
    const wrappedOnClose = (code) => {
        const status = code === 0 ? 'complete' : 'failed';
        const error = code === 0 ? null : `Process exited with code ${code}`;
        recordJobEnd(id, { exitCode: code, status, error });
        _activeJobTracker = null;
        if (typeof args?.onClose === 'function') args.onClose(code);
    };
    const wrappedOnError = (err) => {
        recordJobEnd(id, { status: 'failed', error: err.message });
        _activeJobTracker = null;
        if (typeof args?.onError === 'function') args.onError(err);
    };
    const subprocess = _origSpawnTracked({
        ...args,
        stateMeta: { ...(args?.stateMeta || {}), jobId: id },
        onClose: wrappedOnClose,
        onError: wrappedOnError,
    });
    recordJobPatch(id, { pid: subprocess?.pid || null });
    if (subprocess && typeof subprocess === 'object') subprocess.jobId = id;
    return subprocess;
};

// Thumbnail — generate on demand, cache to disk
app.get('/api/clips/:name/thumbnail', (req, res) => {
    if (!isValidClipName(req.params.name)) return res.status(400).json({ error: 'Invalid clip name' });
    const clipPath = path.join(CLIPS_DIR, req.params.name);
    if (!fs.existsSync(clipPath)) return res.status(404).json({ error: 'Clip not found' });

    const jsonPath = clipPath.replace(/\.mp4$/i, '.json');
    const meta = readJsonFile(jsonPath, null);
    const isLongform = meta?.kind === 'longform' || /^longform[_-]|[_-]longform[_-]/i.test(req.params.name);
    const duration = meta?.duration || 2.0;
    const at = Math.max(0.2, Math.min(duration - 0.1, duration * 0.25));
    const safeName = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const cached = path.join(THUMB_CACHE_DIR, safeName.replace(/\.mp4$/i, '.jpg'));
    const cacheFresh = fs.existsSync(cached) && (Date.now() - fs.statSync(cached).mtimeMs) < 6 * 60 * 60 * 1000;

    if (cacheFresh) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return fs.createReadStream(cached).pipe(res);
    }

    const tmpOut = path.join(TEMP_DIR, `thumb_${Date.now()}_${process.pid}.jpg`);
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    const ff = spawn(FFMPEG_BIN, [
        '-y',
        '-ss', String(at),
        '-i', clipPath,
        '-vframes', '1',
        '-vf', isLongform
            ? 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black'
            : 'scale=480:-2:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2:black',
        '-q:v', '4',
        tmpOut,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    ff.on('error', (err) => {
        console.warn('[Thumb] ffmpeg spawn failed:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Thumbnail generation failed (ffmpeg unavailable?)' });
    });
    ff.on('close', (code) => {
        if (code === 0 && fs.existsSync(tmpOut)) {
            try { fs.copyFileSync(tmpOut, cached); } catch (_) {}
            try { fs.unlinkSync(tmpOut); } catch (_) {}
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            fs.createReadStream(cached).pipe(res);
        } else {
            try { fs.unlinkSync(tmpOut); } catch (_) {}
            if (!res.headersSent) res.status(500).json({ error: 'Thumbnail generation failed' });
        }
    });
});

// Batch operations
app.post('/api/clips/batch', express.json({ limit: '10mb' }), (req, res) => {
    const { action, clipNames } = req.body || {};
    if (!Array.isArray(clipNames) || clipNames.length === 0) {
        return res.status(400).json({ error: 'clipNames must be a non-empty array' });
    }
    if (clipNames.length > 200) {
        return res.status(400).json({ error: 'Too many clips in one batch (limit 200)' });
    }
    const valid = clipNames.every(isValidClipName);
    if (!valid) return res.status(400).json({ error: 'One or more invalid clip names' });

    if (action === 'delete') {
        let deleted = 0;
        for (const name of clipNames) {
            const mp4 = path.join(CLIPS_DIR, name);
            const json = mp4.replace(/\.mp4$/i, '.json');
            try { if (fs.existsSync(mp4)) { fs.unlinkSync(mp4); deleted += 1; } } catch (_) {}
            try { if (fs.existsSync(json)) fs.unlinkSync(json); } catch (_) {}
        }
        return res.json({ deleted });
    }

    if (action === 'rerender') {
        const style = req.body.style;
        const font = req.body.font;
        const animation = req.body.animation;
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

        const runNext = (index) => {
            if (index >= clipNames.length) {
                appendActiveJobLog(`Batch re-render complete: ${clipNames.length} clip(s)`);
                return;
            }
            const clipName = clipNames[index];
            const jsonPath = path.join(CLIPS_DIR, clipName.replace(/\.mp4$/i, '.json'));
            if (!fs.existsSync(jsonPath)) {
                appendActiveJobLog(`Batch re-render skipped ${clipName}: metadata missing`);
                return runNext(index + 1);
            }

            let meta;
            try {
                meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            } catch (_) {
                appendActiveJobLog(`Batch re-render skipped ${clipName}: metadata is corrupt`);
                return runNext(index + 1);
            }

            const rerenderSource = chooseRerenderSource(meta, path.join(CLIPS_DIR, clipName), jsonPath).sourcePath;
            const tempJson = path.join(TEMP_DIR, `batch_rerender_${Date.now()}_${index}.json`);
            const payload = { ...meta, source: rerenderSource };
            if (style) payload.style = style;
            if (typeof font !== 'undefined') payload.font = font || null;
            if (animation) payload.animation = animation;
            fs.writeFileSync(tempJson, JSON.stringify(payload));

            const args = [
                SCRIPT_PATH, rerenderSource, '--mode', 'rerender',
                '--rerender-json', tempJson,
                '--rerender-output', path.join(CLIPS_DIR, clipName),
                ...rerenderRuntimeArgs(meta),
            ];
            let advanced = false;
            const advance = () => {
                if (advanced) return;
                advanced = true;
                try { fs.unlinkSync(tempJson); } catch (_) {}
                runNext(index + 1);
            };
            spawnTrackedFactoryJob({
                args,
                cwd: path.join(__dirname, '..'),
                initialLines: [`Batch re-render ${index + 1}/${clipNames.length}: ${clipName}`],
                stateMeta: { label: `Batch re-render: ${clipName}`, source: rerenderSource },
                onError: advance,
                onClose: (code) => {
                    if (code !== 0) appendActiveJobLog(`Batch re-render failed at ${clipName}; continuing`);
                    advance();
                },
            });
        };

        runNext(0);
        return res.json({ status: 'queued', queued: clipNames.length });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
});

// Batch download as zip
app.get('/api/clips/batch-download', (req, res) => {
    const names = String(req.query.names || '').split(',').filter(Boolean);
    if (names.length === 0) return res.status(400).json({ error: 'Missing ?names=' });
    if (names.length > 200) return res.status(400).json({ error: 'Too many clips in one batch' });
    if (!names.every(isValidClipName)) return res.status(400).json({ error: 'Invalid clip name(s)' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="vcf-clips-${Date.now()}.zip"`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => { console.error('[BatchZip] error', err); try { res.destroy(err); } catch (_) {} });
    archive.on('warning', (err) => { if (err.code === 'ENOENT') console.warn('[BatchZip] missing', err); else throw err; });
    archive.pipe(res);

    for (const name of names) {
        const p = path.join(CLIPS_DIR, name);
        if (fs.existsSync(p)) archive.file(p, { name });
        const manifest = p.replace(/\.mp4$/i, '.json');
        if (fs.existsSync(manifest)) archive.file(manifest, { name: path.basename(manifest) });
    }
    archive.finalize().catch((err) => console.error('[BatchZip] finalize error', err));
});

// Cancel the active job
app.post('/api/job/cancel', (req, res) => {
    const state = readActiveJobState();
    if (!state.active) return res.status(409).json({ error: 'No active job' });
    if (!state.pid || !isPidRunning(state.pid)) {
        return res.status(409).json({ error: 'Active job has no running process' });
    }
    try {
        // SIGTERM first; viral_factory.py handles it for a clean exit
        process.kill(state.pid, 'SIGTERM');
        patchActiveJobState({ error: 'Cancelled by user', finishedAt: new Date().toISOString() });
        // Fall back to SIGKILL after 5s if process still alive
        setTimeout(() => {
            if (isPidRunning(state.pid)) {
                try { process.kill(state.pid, 'SIGKILL'); } catch (_) {}
            }
        }, 5000);
        res.json({ status: 'cancelling', pid: state.pid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Job history
app.get('/api/jobs', (req, res) => {
    const jobs = readJobsHistory().slice().reverse();
    res.json(jobs);
});

// Profiles CRUD
app.get('/api/profiles', (req, res) => {
    res.json(readJsonFile(PROFILES_PATH, []));
});
app.put('/api/profiles/:id', express.json({ limit: '1mb' }), (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) return res.status(400).json({ error: 'Invalid profile id' });
    const profile = { ...req.body, id, updatedAt: new Date().toISOString() };
    const list = readJsonFile(PROFILES_PATH, []);
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) list.push(profile);
    else list[idx] = { ...list[idx], ...profile };
    writeJsonFile(PROFILES_PATH, list);
    res.json(profile);
});
app.delete('/api/profiles/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    const list = readJsonFile(PROFILES_PATH, []);
    const next = list.filter((p) => p.id !== id);
    writeJsonFile(PROFILES_PATH, next);
    res.json({ status: 'deleted', id });
});

// Settings CRUD
app.get('/api/settings', (req, res) => {
    const saved = readServerSettings();
    res.json({
        ...saved,
        ffmpegPath: FFMPEG_BIN,
        pythonPath: PYTHON_BIN,
        host: HOST,
        port: PORT,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        resumableChunkBytes: RESUMABLE_CHUNK_BYTES,
    });
});
app.put('/api/settings', express.json({ limit: '1mb' }), (req, res) => {
    const current = readServerSettings();
    const next = {
        ...current,
        ...normalizeServerSettings({ ...current, ...(req.body || {}) }),
        updatedAt: new Date().toISOString(),
    };
    writeJsonFile(SETTINGS_PATH, next);
    res.json({ status: 'ok', settings: next });
});

function storageCleanupBusyReason() {
    reconcileActiveJobState();
    if (readActiveJobState().active) return 'A render or analysis job is currently running';
    if (longformRenderQueueActive) return 'A long-form render is currently running';
    if (compilationAdmissionActive) return 'An action compilation is currently being admitted';
    if (compilationUploadManager.hasSessions()) return 'A resumable montage upload is staged';
    if (longformProxyJobs.size > 0) return 'A long-form proxy is currently building';
    try {
        if (listLongformConsolidations().some((job) => ['queued', 'running'].includes(job.status))) {
            return 'A consolidation job is currently running';
        }
    } catch (_) {
        return 'Consolidation state could not be verified';
    }
    return null;
}

app.get('/api/admin/storage', (_req, res) => {
    try {
        return res.json({
            ...storageManager.summarize(),
            busyReason: storageCleanupBusyReason(),
            confirmation: 'DELETE_REGENERABLE_FILES',
        });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Unable to inspect storage' });
    }
});

app.post('/api/admin/storage/cleanup', (req, res) => {
    const confirmation = String(req.body?.confirm || req.headers['x-vcf-storage-confirm'] || '');
    if (confirmation !== 'DELETE_REGENERABLE_FILES') {
        return res.status(400).json({ error: 'Type DELETE_REGENERABLE_FILES to confirm cleanup' });
    }
    const busyReason = storageCleanupBusyReason();
    if (busyReason) return res.status(409).json({ error: `${busyReason}. Try cleanup again after it finishes.` });
    try {
        const cleanup = storageManager.cleanup(req.body?.categories);
        return res.json({
            status: 'cleaned',
            cleanup,
            storage: {
                ...storageManager.summarize(),
                busyReason: null,
                confirmation: 'DELETE_REGENERABLE_FILES',
            },
        });
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Unable to clean storage' });
    }
});

// Provider credentials are intentionally separate from general settings so
// no settings response, profile, job record, or capability payload can echo a
// secret. The only returned values are masked configuration state plus the
// non-secret local endpoint and model name.
app.get('/api/provider-settings', (req, res) => {
    try {
        const current = readProviderSettings(PROVIDER_SETTINGS_PATH);
        savedProviderSettings = current;
        applyProviderEnvironment(savedProviderSettings, PROVIDER_BOOTSTRAP_ENV, process.env);
        res.json(providerSettingsStatus(savedProviderSettings, PROVIDER_BOOTSTRAP_ENV));
    } catch (_) {
        return res.status(500).json({ error: 'Unable to load provider settings' });
    }
});

app.put('/api/provider-settings', (req, res) => {
    try {
        if (providerSettingsPayloadTooLarge(req.body, req.headers['content-length'])) {
            return res.status(413).json({ error: 'Provider settings payload is too large' });
        }
        const current = readProviderSettings(PROVIDER_SETTINGS_PATH);
        const next = updateProviderSettings(current, req.body, PROVIDER_BOOTSTRAP_ENV);
        savedProviderSettings = writeProviderSettingsAtomic(PROVIDER_SETTINGS_PATH, next);
        applyProviderEnvironment(savedProviderSettings, PROVIDER_BOOTSTRAP_ENV, process.env);
        res.json(providerSettingsStatus(savedProviderSettings, PROVIDER_BOOTSTRAP_ENV));
    } catch (error) {
        if (error instanceof ProviderSettingsValidationError) {
            return res.status(400).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Unable to save provider settings' });
    }
});

function executableAvailable(command) {
    const candidate = String(command || '').trim();
    if (!candidate) return false;
    if (path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) {
        return fs.existsSync(candidate);
    }
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookup, [candidate], { encoding: 'utf8', timeout: 3000 });
    return result.status === 0;
}

function pythonModuleAvailable(moduleName) {
    const result = spawnSync(PYTHON_BIN, ['-c', `import ${moduleName}`], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 15000,
    });
    return result.status === 0;
}

function whisperCppModelName(modelPath) {
    const filename = path.basename(String(modelPath || '')).replace(/\.(?:bin|gguf)$/i, '');
    return filename.replace(/^ggml-/i, '') || null;
}

function intelligenceCapabilities() {
    const whisperCppPath = process.env.VCF_WHISPER_CPP_PATH || 'whisper-cli';
    const whisperCppModel = String(process.env.VCF_WHISPER_CPP_MODEL || '').trim();
    const whisperCppExecutable = executableAvailable(whisperCppPath);
    const whisperCppReady = whisperCppExecutable && Boolean(whisperCppModel) && fs.existsSync(whisperCppModel);
    const openAiWhisperReady = pythonModuleAvailable('whisper');
    const localUrl = String(process.env.VCF_LOCAL_LLM_URL || '').trim();
    const localModel = String(process.env.VCF_LOCAL_LLM_MODEL || '').trim();

    return {
        transcriptionProviders: [
            { id: 'auto', label: 'Auto local', available: true, cloud: false, reason: null },
            {
                id: 'openai_whisper',
                label: 'PyTorch Whisper',
                available: openAiWhisperReady,
                cloud: false,
                reason: openAiWhisperReady ? null : 'The Python whisper module is unavailable',
            },
            {
                id: 'whisper_cpp',
                label: 'whisper.cpp',
                available: whisperCppReady,
                cloud: false,
                model: whisperCppReady ? whisperCppModelName(whisperCppModel) : null,
                reason: whisperCppReady
                    ? null
                    : (!whisperCppExecutable ? 'whisper.cpp executable not found' : 'VCF_WHISPER_CPP_MODEL is missing or unreadable'),
            },
            {
                id: 'deepgram',
                label: 'Deepgram Nova-3',
                available: Boolean(process.env.DEEPGRAM_API_KEY),
                cloud: true,
                model: 'nova-3',
                reason: process.env.DEEPGRAM_API_KEY ? null : 'DEEPGRAM_API_KEY is not configured',
            },
        ],
        viralProviders: [
            { id: 'heuristic', label: 'Local signals', available: true, cloud: false, reason: null },
            {
                id: 'local_semantic',
                label: 'Local semantic model',
                available: Boolean(localUrl && localModel),
                cloud: false,
                reason: localUrl && localModel ? null : 'VCF_LOCAL_LLM_URL and VCF_LOCAL_LLM_MODEL are not configured',
            },
            {
                id: 'gemini',
                label: 'Gemini video analysis',
                available: Boolean(process.env.GEMINI_API_KEY),
                cloud: true,
                reason: process.env.GEMINI_API_KEY ? null : 'GEMINI_API_KEY is not configured',
            },
        ],
    };
}

let systemCapabilitiesCache = null;
const SYSTEM_CAPABILITIES_CACHE_MS = 30 * 1000;

function probeSystemCapabilities({ force = false } = {}) {
    if (!force && systemCapabilitiesCache && Date.now() - systemCapabilitiesCache.checkedAt < SYSTEM_CAPABILITIES_CACHE_MS) {
        return systemCapabilitiesCache;
    }
    const result = spawnSync(PYTHON_BIN, [HARDWARE_SCRIPT_PATH, '--json'], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 45000,
        env: {
            ...process.env,
            VCF_FFMPEG_PATH: FFMPEG_BIN,
            VCF_VAAPI_DEVICE: process.env.VCF_VAAPI_DEVICE || '/dev/dri/renderD128',
        },
    });
    if (result.status !== 0) {
        systemCapabilitiesCache = {
            checkedAt: Date.now(),
            capabilities: null,
            error: 'Hardware capability probe failed',
            detail: String(result.stderr || result.error?.message || '').trim(),
        };
        return systemCapabilitiesCache;
    }
    try {
        systemCapabilitiesCache = {
            checkedAt: Date.now(),
            capabilities: { ...JSON.parse(result.stdout), ...intelligenceCapabilities() },
            error: null,
            detail: null,
        };
    } catch (_) {
        systemCapabilitiesCache = {
            checkedAt: Date.now(),
            capabilities: null,
            error: 'Hardware capability probe returned invalid data',
            detail: null,
        };
    }
    return systemCapabilitiesCache;
}

function fallbackCapabilities() {
    return {
        compute: [{ backend: 'cpu', available: true, label: 'CPU' }],
        videoEncoders: [{ backend: 'cpu', available: true, label: 'CPU' }],
        recommendedCompute: 'cpu',
        recommendedVideoEncoder: 'cpu',
        ...intelligenceCapabilities(),
    };
}

function preflightForOptions(options = {}) {
    const probe = probeSystemCapabilities();
    const preflight = buildJobPreflight(options, probe.capabilities || fallbackCapabilities());
    if (probe.error) {
        preflight.warnings.unshift({
            code: 'capability_probe_failed',
            message: `${probe.error}; CPU-safe assumptions were used`,
            requested: null,
            fallback: 'cpu',
        });
    }
    return preflight;
}

function buildTrackedJobMeta(options = {}, overrides = {}) {
    const preflight = preflightForOptions(options);
    const resolved = {
        computeDevice: preflight.effective.computeDevice,
        videoEncoder: preflight.effective.videoEncoder,
        transcriptionProvider: preflight.effective.transcriptionProvider,
        transcriptionModel: preflight.effective.transcriptionModel,
        transcriptionPreset: preflight.effective.transcriptionPreset,
        transcriptionLanguage: preflight.effective.transcriptionLanguage,
        localSemantic: preflight.effective.localSemantic,
        geminiAnalysis: preflight.effective.geminiAnalysis,
        reviewBeforeRender: preflight.effective.reviewBeforeRender,
        requestedComputeDevice: preflight.requested.computeDevice,
        requestedVideoEncoder: preflight.requested.videoEncoder,
        requestedTranscriptionProvider: preflight.requested.transcriptionProvider,
        requestedTranscriptionModel: preflight.requested.transcriptionModel,
        requestedTranscriptionPreset: preflight.requested.transcriptionPreset,
        requestedTranscriptionLanguage: preflight.requested.transcriptionLanguage,
        requestedLocalSemantic: preflight.requested.localSemantic,
        requestedGeminiAnalysis: preflight.requested.geminiAnalysis,
        preflightWarnings: preflight.warnings,
        preflightErrors: preflight.errors,
        ...overrides,
    };
    return {
        ...resolved,
        effectiveComputeDevice: resolved.computeDevice,
        effectiveVideoEncoder: resolved.videoEncoder,
        effectiveTranscriptionProvider: resolved.transcriptionProvider,
        effectiveTranscriptionModel: resolved.transcriptionModel,
        effectiveTranscriptionPreset: resolved.transcriptionPreset,
        effectiveTranscriptionLanguage: resolved.transcriptionLanguage,
        effectiveLocalSemantic: resolved.localSemantic,
        effectiveGeminiAnalysis: resolved.geminiAnalysis,
    };
}

app.get('/api/system/capabilities', (req, res) => {
    const probe = probeSystemCapabilities({ force: req.query.refresh === '1' });
    if (!probe.capabilities) {
        return res.status(503).json({ error: probe.error, detail: probe.detail });
    }
    return res.json(probe.capabilities);
});

app.post('/api/jobs/preflight', express.json({ limit: '1mb' }), (req, res) => {
    const options = resolveServerJobOptions(req.body || {});
    return res.json({
        ...preflightForOptions(options),
        options,
    });
});

function clampNumber(value, fallback, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function probeDurationSync(filePath) {
    const result = spawnSync(FFPROBE_BIN, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
    ], { encoding: 'utf8', timeout: 30000 });
    const duration = Number.parseFloat(result.stdout || '');
    return result.status === 0 && Number.isFinite(duration) && duration > 0 ? duration : null;
}

function isLongformProjectName(name, meta) {
    return meta?.kind === 'longform' || /^longform[_-]|[_-]longform[_-]/i.test(name);
}

function normalizeLongformOptions(input, sourceDuration, fallback = {}) {
    const raw = input || {};
    const duration = Math.max(0.01, Number(sourceDuration) || 0.01);
    const fallbackNumber = (value, defaultValue) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : defaultValue;
    };
    const fallbackStart = Number(fallback.startSec ?? fallback.selected_start_sec ?? 0) || 0;
    const fallbackEnd = Number(fallback.endSec ?? fallback.selected_end_sec ?? duration) || duration;
    const booleanValue = (value, defaultValue) => {
        if (value === undefined || value === null || value === '') return defaultValue;
        if (typeof value === 'boolean') return value;
        const normalized = String(value).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        return defaultValue;
    };
    const startSec = clampNumber(raw.startSec ?? raw.selected_start_sec, fallbackStart, 0, duration);
    const endSec = clampNumber(raw.endSec ?? raw.selected_end_sec, fallbackEnd, 0, duration);
    if (endSec <= startSec) throw new Error('The selected range must end after it starts');
    return {
        enabled: raw.enabled !== false,
        thresholdDb: clampNumber(raw.thresholdDb ?? raw.threshold_db, fallbackNumber(fallback.thresholdDb ?? fallback.threshold_db, -35), -60, -20),
        minSilenceSec: clampNumber(raw.minSilenceSec ?? raw.min_silence_sec, fallbackNumber(fallback.minSilenceSec ?? fallback.min_silence_sec, 0.5), 0.2, 3),
        paddingSec: clampNumber(raw.paddingSec ?? raw.edge_padding_sec, fallbackNumber(fallback.paddingSec ?? fallback.edge_padding_sec, 0.08), 0, 0.3),
        audioFadeSec: clampNumber(raw.audioFadeSec ?? raw.audio_fade_sec, fallbackNumber(fallback.audioFadeSec ?? fallback.audio_fade_sec, 0.03), 0, 0.15),
        videoFadeSec: clampNumber(raw.videoFadeSec ?? raw.video_fade_sec, fallbackNumber(fallback.videoFadeSec ?? fallback.video_fade_sec, 0), 0, 0.15),
        normalizeAudio: booleanValue(
            raw.normalizeAudio ?? raw.normalize_audio,
            booleanValue(fallback.normalizeAudio ?? fallback.normalize_audio, false),
        ),
        targetLufs: clampNumber(
            raw.targetLufs ?? raw.target_lufs,
            fallbackNumber(fallback.targetLufs ?? fallback.target_lufs, -14),
            -24,
            -9,
        ),
        limiterDb: clampNumber(
            raw.limiterDb ?? raw.limiter_db,
            fallbackNumber(fallback.limiterDb ?? fallback.limiter_db, -1.5),
            -6,
            -0.1,
        ),
        denoise: booleanValue(
            raw.denoise,
            booleanValue(fallback.denoise, false),
        ),
        startSec,
        endSec,
    };
}

function normalizeLongformCuts(input, options, limit = 10000) {
    if (!Array.isArray(input)) return [];
    if (input.length > limit) throw new Error(`Too many silence cuts (limit ${limit})`);
    const cuts = input.map((cut, index) => {
        const start = Number.parseFloat(cut?.start);
        const end = Number.parseFloat(cut?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            throw new Error(`Silence cut ${index + 1} has an invalid time range`);
        }
        if (start < options.startSec - 0.001 || end > options.endSec + 0.001) {
            throw new Error(`Silence cut ${index + 1} is outside the selected range`);
        }
        return {
            id: String(cut?.id || `silence-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80),
            start,
            end,
            duration: end - start,
            // Keep each cut's own decision even when global removal is off so
            // re-enabling silence removal restores the reviewed edit list.
            enabled: cut?.enabled !== false,
        };
    }).sort((a, b) => a.start - b.start || a.end - b.end);

    for (let index = 1; index < cuts.length; index += 1) {
        if (cuts[index].start < cuts[index - 1].end - 0.001) {
            throw new Error('Silence cuts must not overlap');
        }
    }
    return cuts;
}

function normalizeLongformChapters(input, options, fallback = []) {
    const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
    return source.slice(0, 500).map((chapter, index) => ({
        id: String(chapter?.id || `chapter-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80),
        time: clampNumber(chapter?.time, options.startSec, options.startSec, options.endSec),
        title: String(chapter?.title || `Chapter ${index + 1}`).trim().slice(0, 160),
    })).filter((chapter) => chapter.title).sort((a, b) => a.time - b.time);
}

function keepSegmentsForClient(segments) {
    if (!Array.isArray(segments)) return [];
    return segments.map((segment) => {
        if (Array.isArray(segment)) return [Number(segment[0]), Number(segment[1])];
        return [Number(segment?.start), Number(segment?.end)];
    }).filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
}

function keepSegmentsFromCuts(cuts, options) {
    if (!options.enabled) return [[options.startSec, options.endSec]];
    const enabled = (Array.isArray(cuts) ? cuts : [])
        .filter((cut) => cut.enabled !== false)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const segments = [];
    let cursor = options.startSec;
    for (const cut of enabled) {
        if (cut.start > cursor + 0.001) segments.push([cursor, cut.start]);
        cursor = Math.max(cursor, cut.end);
    }
    if (cursor < options.endSec - 0.001) segments.push([cursor, options.endSec]);
    return segments;
}

function analysisForClient(result, options) {
    const cuts = (result.cuts || []).map((cut, index) => ({
        id: String(cut.id || `silence-${index + 1}`),
        start: Number(cut.start),
        end: Number(cut.end),
        duration: Number(cut.duration ?? (Number(cut.end) - Number(cut.start))),
        enabled: cut.enabled !== false,
    }));
    const numeric = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
        cuts,
        keepSegments: keepSegmentsForClient(result.keep_segments || result.keepSegments),
        originalDurationSec: numeric(result.original_duration_sec ?? result.originalDurationSec, options.endSec),
        selectedDurationSec: numeric(result.selected_duration_sec ?? result.selectedDurationSec, options.endSec - options.startSec),
        removedDurationSec: numeric(result.removed_duration_sec ?? result.removedDurationSec, 0),
        estimatedDurationSec: numeric(result.estimated_duration_sec ?? result.estimatedDurationSec, options.endSec - options.startSec),
        joinCount: numeric(result.join_count ?? result.joinCount, 0),
        options,
    };
}

function longformAssetOwner(name, meta = {}) {
    const requested = String(meta.asset_project || name || '').trim();
    return isValidClipName(requested) ? requested : String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function longformAssetDirectory(owner) {
    const digest = crypto.createHash('sha256').update(String(owner)).digest('hex').slice(0, 20);
    return path.join(LONGFORM_ASSETS_DIR, digest);
}

const longformAssetProbeCache = new Map();

function longformAssetMetadata(filePath, kind) {
    if (kind === 'lut') return { mediaType: 'lut', durationSec: null };
    const extension = path.extname(filePath).toLowerCase();
    const audioExtensions = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg']);
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const mediaType = ['music', 'voiceover'].includes(kind) || audioExtensions.has(extension)
        ? 'audio'
        : imageExtensions.has(extension)
            ? 'image'
            : 'video';
    if (mediaType === 'image') return { mediaType, durationSec: null };
    try {
        const stat = fs.statSync(filePath);
        const fingerprint = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
        const cached = longformAssetProbeCache.get(filePath);
        if (cached?.fingerprint === fingerprint) return cached.metadata;
        const metadata = { mediaType, durationSec: probeDurationSync(filePath) };
        longformAssetProbeCache.set(filePath, { fingerprint, metadata });
        return metadata;
    } catch (_) {
        return { mediaType, durationSec: null };
    }
}

function listLongformAssets(owner) {
    const directory = longformAssetDirectory(owner);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).flatMap((filename) => {
        const match = filename.match(/^(broll|music|angle|lut|media|voiceover)--(.+)$/);
        if (!match) return [];
        const assetPath = path.join(directory, filename);
        return [{
            id: filename,
            name: match[2].replace(/-\d{13}-[a-f0-9]{6}(?=\.[^.]+$)/, ''),
            kind: match[1],
            path: assetPath,
            url: `/api/longform-assets/${encodeURIComponent(owner)}/${encodeURIComponent(filename)}`,
            ...longformAssetMetadata(assetPath, match[1]),
        }];
    });
}

function listLongformLuts() {
    if (!fs.existsSync(LONGFORM_LUT_LIBRARY_DIR)) return [];
    return fs.readdirSync(LONGFORM_LUT_LIBRARY_DIR).flatMap((filename) => {
        if (!/^library--[a-zA-Z0-9._-]{1,220}$/.test(filename)) return [];
        return [{
            id: filename,
            name: filename
                .replace(/^library--/, '')
                .replace(/-\d{13}-[a-f0-9]{6}(?=\.[^.]+$)/, ''),
            kind: 'lut',
            path: path.join(LONGFORM_LUT_LIBRARY_DIR, filename),
            url: `/api/longform-luts/${encodeURIComponent(filename)}`,
            library: true,
            mediaType: 'lut',
            durationSec: null,
        }];
    }).sort((left, right) => left.name.localeCompare(right.name));
}

function publicLongformAsset(asset) {
    if (!asset) return asset;
    const { path: _assetPath, ...safe } = asset;
    return safe;
}

function resolveLongformAsset(owner, assetId, kind = null) {
    const id = String(assetId || '').trim();
    if (/^library--[a-zA-Z0-9._-]{1,220}$/.test(id)) {
        if (kind && kind !== 'lut') return null;
        const directory = path.resolve(LONGFORM_LUT_LIBRARY_DIR);
        const resolved = path.resolve(directory, id);
        if (!resolved.startsWith(`${directory}${path.sep}`) || !fs.existsSync(resolved)) return null;
        return resolved;
    }
    if (!/^(broll|music|angle|lut|media|voiceover)--[a-zA-Z0-9._-]{1,220}$/.test(id)) return null;
    if (kind && !id.startsWith(`${kind}--`)) return null;
    const directory = path.resolve(longformAssetDirectory(owner));
    const resolved = path.resolve(directory, id);
    if (!resolved.startsWith(`${directory}${path.sep}`) || !fs.existsSync(resolved)) return null;
    return resolved;
}

function normalizeHexColor(value, fallback) {
    const normalized = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(normalized)) {
        return `#${normalized.slice(1).split('').map((part) => part + part).join('')}`.toUpperCase();
    }
    return fallback;
}

function sanitizeLongformId(value, fallback) {
    return String(value || fallback || '')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 80);
}

function normalizeLongformKeyframes(input, start, end, fallback = []) {
    const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
    const seen = new Set();
    return source.slice(0, 500).flatMap((item, index) => {
        const time = clampNumber(item?.time, start, start, end);
        const id = sanitizeLongformId(item?.id, `keyframe-${index + 1}`);
        if (seen.has(id)) return [];
        seen.add(id);
        return [{
            id,
            time,
            x: clampNumber(item?.x, 0, -1, 1),
            y: clampNumber(item?.y, 0, -1, 1),
            scale: clampNumber(item?.scale, 1, 0.1, 4),
            rotation: clampNumber(item?.rotation, 0, -360, 360),
            opacity: clampNumber(item?.opacity, 1, 0, 1),
        }];
    }).sort((a, b) => a.time - b.time);
}

function splitLongformSegments(cuts, options, editPoints = []) {
    const baseSegments = keepSegmentsFromCuts(cuts, options);
    const activeCuts = options.enabled
        ? (Array.isArray(cuts) ? cuts : []).filter((cut) => cut.enabled !== false)
        : [];
    const points = (Array.isArray(editPoints) ? editPoints : [])
        .filter((point) => Number.isFinite(Number(point?.time)))
        .sort((a, b) => Number(a.time) - Number(b.time));
    const entries = [];

    baseSegments.forEach((segment, baseIndex) => {
        const [start, end] = segment;
        const localPoints = points.filter((point) => (
            Number(point.time) > start + 0.02
            && Number(point.time) < end - 0.02
        ));
        const boundaries = [start, ...localPoints.map((point) => Number(point.time)), end];
        const gapCut = baseIndex > 0
            ? activeCuts.find((cut) => (
                cut.start <= baseSegments[baseIndex - 1][1] + 0.001
                && cut.end >= start - 0.001
            ))
            : null;
        for (let index = 0; index < boundaries.length - 1; index += 1) {
            entries.push({
                segment: [boundaries[index], boundaries[index + 1]],
                joinIdBefore: entries.length === 0
                    ? null
                    : index === 0
                        ? (gapCut ? String(gapCut.id) : null)
                        : String(localPoints[index - 1].id),
            });
        }
    });

    const joins = new Map();
    entries.forEach((entry, index) => {
        if (index > 0 && entry.joinIdBefore) joins.set(entry.joinIdBefore, index - 1);
    });
    return {
        segments: entries.map((entry) => entry.segment),
        joins,
    };
}

function normalizeLongformCreative(input, project, fallback = {}) {
    const provided = input && typeof input === 'object' ? input : {};
    const source = {
        ...(fallback && typeof fallback === 'object' ? fallback : {}),
        ...provided,
    };
    const exportPreset = ['source', 'youtube_1080p', 'youtube_4k', 'podcast'].includes(source.exportPreset)
        ? source.exportPreset
        : 'source';
    const editPointsSource = Array.isArray(source.editPoints) ? source.editPoints : [];
    const baseSegments = keepSegmentsFromCuts(project.cuts || project.analysis?.cuts || [], project.options);
    const editPoints = editPointsSource.slice(0, 1000).flatMap((item, index) => {
        const time = clampNumber(item?.time, project.options.startSec, project.options.startSec, project.options.endSec);
        const insideKeptProgram = baseSegments.some(([start, end]) => time > start + 0.02 && time < end - 0.02);
        if (!insideKeptProgram) return [];
        return [{
            id: sanitizeLongformId(item?.id, `blade-${index + 1}`),
            time,
            label: String(item?.label || `Edit ${index + 1}`).trim().slice(0, 80),
        }];
    }).sort((a, b) => a.time - b.time);
    const validJoinIds = new Set(
        (project.cuts || project.analysis?.cuts || [])
            .map((cut) => String(cut?.id || ''))
            .filter(Boolean)
            .concat(editPoints.map((point) => point.id)),
    );
    const transitionTypes = new Set(['cut', 'dissolve', 'fade_black', 'fade_white', 'wipe_left', 'slide_left']);
    const transitions = (Array.isArray(source.transitions) ? source.transitions : []).slice(0, 500).flatMap((item, index) => {
        const cutId = sanitizeLongformId(item?.cutId, '');
        if (!cutId || (validJoinIds.size && !validJoinIds.has(cutId))) return [];
        const type = transitionTypes.has(item?.type) ? item.type : 'cut';
        return [{
            id: sanitizeLongformId(item?.id, `transition-${index + 1}`),
            cutId,
            type,
            duration: type === 'cut' ? 0 : clampNumber(item?.duration, 0.35, 0.08, 2),
            audioOffsetSec: clampNumber(item?.audioOffsetSec, 0, -2, 2),
        }];
    });
    const titles = (Array.isArray(source.titles) ? source.titles : []).slice(0, 100).flatMap((title, index) => {
        const start = clampNumber(title?.start, project.options.startSec, project.options.startSec, project.options.endSec);
        const end = clampNumber(title?.end, Math.min(project.options.endSec, start + 4), start + 0.2, project.options.endSec);
        const text = String(title?.text || '').trim().slice(0, 160);
        if (!text || end <= start) return [];
        const style = title?.style === 'center_card' ? 'center_card' : 'lower_third';
        const template = ['minimal', 'broadcast', 'glass'].includes(title?.template) ? title.template : 'broadcast';
        const alignment = ['left', 'center', 'right'].includes(title?.alignment) ? title.alignment : 'left';
        const transformDefaults = style === 'center_card'
            ? { x: 0.1, y: 0.32, width: 0.8 }
            : template === 'glass'
                ? { x: 0.045, y: 0.7, width: 0.91 }
                : template === 'minimal'
                    ? {
                        x: alignment === 'right' ? 0.54 : alignment === 'center' ? 0.28 : 0.08,
                        y: 0.73,
                        width: 0.38,
                    }
                    : {
                        x: alignment === 'right' ? 0.385 : alignment === 'center' ? 0.22 : 0.055,
                        y: 0.69,
                        width: 0.56,
                    };
        return [{
            id: sanitizeLongformId(title?.id, `title-${index + 1}`),
            text,
            subtitle: String(title?.subtitle || '').trim().slice(0, 180),
            start,
            end,
            style,
            template,
            alignment,
            animation: ['none', 'fade', 'slide'].includes(title?.animation) ? title.animation : 'slide',
            accentColor: normalizeHexColor(title?.accentColor, '#8B5CF6'),
            backgroundColor: normalizeHexColor(title?.backgroundColor, '#09090B'),
            textColor: normalizeHexColor(title?.textColor, '#FFFFFF'),
            x: clampNumber(title?.x, transformDefaults.x, 0, 0.95),
            y: clampNumber(title?.y, transformDefaults.y, 0, 0.95),
            width: clampNumber(title?.width, transformDefaults.width, 0.12, 1),
            scale: clampNumber(title?.scale, 1, 0.4, 2.5),
        }];
    });
    const broll = (Array.isArray(source.broll) ? source.broll : []).slice(0, 100).flatMap((item, index) => {
        const assetId = String(item?.assetId || '').trim();
        if (!resolveLongformAsset(project.assetOwner, assetId, 'broll')) return [];
        const start = clampNumber(item?.start, project.options.startSec, project.options.startSec, project.options.endSec);
        const end = clampNumber(item?.end, Math.min(project.options.endSec, start + 5), start + 0.2, project.options.endSec);
        if (end <= start) return [];
        return [{
            id: sanitizeLongformId(item?.id, `broll-${index + 1}`),
            assetId,
            start,
            end,
            sourceOffset: clampNumber(item?.sourceOffset, 0, 0, 86400),
            layout: ['cover', 'contain', 'pip'].includes(item?.layout) ? item.layout : 'cover',
            x: clampNumber(item?.x, 0, -1, 1),
            y: clampNumber(item?.y, 0, -1, 1),
            scale: clampNumber(item?.scale, 1, 0.1, 4),
            rotation: clampNumber(item?.rotation, 0, -360, 360),
            opacity: clampNumber(item?.opacity, 1, 0, 1),
            cropLeft: clampNumber(item?.cropLeft, 0, 0, 0.45),
            cropTop: clampNumber(item?.cropTop, 0, 0, 0.45),
            cropRight: clampNumber(item?.cropRight, 0, 0, 0.45),
            cropBottom: clampNumber(item?.cropBottom, 0, 0, 0.45),
            keyframes: normalizeLongformKeyframes(item?.keyframes, start, end),
        }];
    });
    const musicAssetId = resolveLongformAsset(project.assetOwner, source.musicAssetId, 'music')
        ? String(source.musicAssetId)
        : null;
    const fallbackColor = fallback?.color && typeof fallback.color === 'object' ? fallback.color : {};
    const color = {
        ...fallbackColor,
        ...(source.color && typeof source.color === 'object' ? source.color : {}),
    };
    const normalizedGrade = normalizeGrade(color, fallbackColor);
    const lutAssetId = resolveLongformAsset(project.assetOwner, color.lutAssetId, 'lut')
        ? String(color.lutAssetId)
        : null;
    const fallbackAudio = fallback?.audio && typeof fallback.audio === 'object' ? fallback.audio : {};
    const audio = {
        ...fallbackAudio,
        ...(source.audio && typeof source.audio === 'object' ? source.audio : {}),
    };
    const audioKeyframes = (Array.isArray(audio.keyframes) ? audio.keyframes : []).slice(0, 500).flatMap((item, index) => {
        const time = clampNumber(item?.time, project.options.startSec, project.options.startSec, project.options.endSec);
        return [{
            id: sanitizeLongformId(item?.id, `audio-keyframe-${index + 1}`),
            time,
            gainDb: clampNumber(item?.gainDb, 0, -60, 18),
        }];
    }).sort((a, b) => a.time - b.time);
    const fallbackCaptions = fallback?.captions && typeof fallback.captions === 'object' ? fallback.captions : {};
    const captionsSource = {
        ...fallbackCaptions,
        ...(source.captions && typeof source.captions === 'object' ? source.captions : {}),
    };
    const captionCues = (Array.isArray(captionsSource.cues) ? captionsSource.cues : []).slice(0, 5000).flatMap((cue, index) => {
        const start = clampNumber(cue?.start, project.options.startSec, project.options.startSec, project.options.endSec);
        const end = clampNumber(cue?.end, Math.min(project.options.endSec, start + 3), start + 0.05, project.options.endSec);
        const text = String(cue?.text || '').trim().slice(0, 500);
        if (!text || end <= start) return [];
        return [{
            id: sanitizeLongformId(cue?.id, `caption-${index + 1}`),
            start,
            end,
            text,
            speaker: String(cue?.speaker || '').trim().slice(0, 80),
            lowConfidence: cue?.lowConfidence === true,
        }];
    }).sort((a, b) => a.start - b.start);
    const adjustmentLayers = (Array.isArray(source.adjustmentLayers) ? source.adjustmentLayers : []).slice(0, 200).flatMap((layer, index) => {
        const start = clampNumber(layer?.start, project.options.startSec, project.options.startSec, project.options.endSec);
        const end = clampNumber(layer?.end, Math.min(project.options.endSec, start + 5), start + 0.05, project.options.endSec);
        if (end <= start) return [];
        return [{
            id: sanitizeLongformId(layer?.id, `adjustment-${index + 1}`),
            name: String(layer?.name || `Adjustment ${index + 1}`).trim().slice(0, 80),
            start,
            end,
            exposure: clampNumber(layer?.exposure, 0, -0.3, 0.3),
            contrast: clampNumber(layer?.contrast, 1, 0.5, 1.5),
            saturation: clampNumber(layer?.saturation, 1, 0, 2),
            temperature: clampNumber(layer?.temperature, 0, -1, 1),
            tint: clampNumber(layer?.tint, 0, -1, 1),
            sharpen: clampNumber(layer?.sharpen, 0, 0, 1.5),
            blur: clampNumber(layer?.blur, 0, 0, 20),
            vignette: clampNumber(layer?.vignette, 0, 0, 1),
            grain: clampNumber(layer?.grain, 0, 0, 50),
        }];
    });
    const multicamSource = source.multicam && typeof source.multicam === 'object' ? source.multicam : {};
    const multicamAngles = (Array.isArray(multicamSource.angles) ? multicamSource.angles : []).slice(0, 16).flatMap((angle, index) => {
        const assetId = String(angle?.assetId || '').trim();
        if (!resolveLongformAsset(project.assetOwner, assetId, 'angle')) return [];
        return [{
            id: sanitizeLongformId(angle?.id, `angle-${index + 1}`),
            assetId,
            name: String(angle?.name || `Angle ${index + 2}`).trim().slice(0, 80),
            offsetSec: clampNumber(angle?.offsetSec, 0, -86400, 86400),
            speaker: String(angle?.speaker || '').trim().slice(0, 80),
        }];
    });
    const validAngleIds = new Set(multicamAngles.map((angle) => angle.id));
    const multicamCuts = (Array.isArray(multicamSource.cuts) ? multicamSource.cuts : []).slice(0, 2000).flatMap((cut, index) => {
        const angleId = sanitizeLongformId(cut?.angleId, '');
        if (!validAngleIds.has(angleId)) return [];
        const start = clampNumber(cut?.start, project.options.startSec, project.options.startSec, project.options.endSec);
        const end = clampNumber(cut?.end, Math.min(project.options.endSec, start + 5), start + 0.05, project.options.endSec);
        if (end <= start) return [];
        return [{
            id: sanitizeLongformId(cut?.id, `multicam-cut-${index + 1}`),
            angleId,
            start,
            end,
            useAudio: cut?.useAudio === true,
        }];
    }).sort((a, b) => a.start - b.start);
    const professional = normalizeLongformProfessional(source, fallback, {
        start: project.options.startSec,
        end: project.options.endSec,
        duration: project.sourceDuration,
    });
    return {
        exportPreset,
        editPoints,
        transitions,
        titles,
        broll,
        color: {
            ...normalizedGrade,
            lutAssetId,
        },
        audio: {
            dialogueGainDb: clampNumber(audio.dialogueGainDb, 0, -60, 18),
            masterGainDb: clampNumber(audio.masterGainDb, 0, -60, 18),
            pan: clampNumber(audio.pan, 0, -1, 1),
            eqLowDb: clampNumber(audio.eqLowDb, 0, -18, 18),
            eqMidDb: clampNumber(audio.eqMidDb, 0, -18, 18),
            eqHighDb: clampNumber(audio.eqHighDb, 0, -18, 18),
            compressor: audio.compressor === true,
            deEsser: audio.deEsser === true,
            noiseGate: audio.noiseGate === true,
            dialogueMuted: audio.dialogueMuted === true,
            musicMuted: audio.musicMuted === true,
            keyframes: audioKeyframes,
        },
        captions: {
            enabled: captionsSource.enabled === true,
            burnIn: captionsSource.burnIn === true,
            cues: captionCues,
            fontSize: clampNumber(captionsSource.fontSize, 44, 18, 96),
            position: ['bottom', 'center', 'top'].includes(captionsSource.position)
                ? captionsSource.position
                : 'bottom',
            textColor: normalizeHexColor(captionsSource.textColor, '#FFFFFF'),
            backgroundColor: normalizeHexColor(captionsSource.backgroundColor, '#09090B'),
            highlightColor: normalizeHexColor(captionsSource.highlightColor, '#FACC15'),
        },
        adjustmentLayers,
        multicam: { angles: multicamAngles, cuts: multicamCuts },
        musicAssetId,
        musicVolume: clampNumber(source.musicVolume, 0.14, 0.02, 0.5),
        musicDucking: source.musicDucking !== false,
        sequence: professional.sequence,
        colorWorkflow: professional.colorWorkflow,
        adr: professional.adr,
        publish: professional.publish,
        delivery: {
            aspect: ['source', '16:9', '1:1', '9:16'].includes(source.delivery?.aspect)
                ? source.delivery.aspect
                : 'source',
            reframe: ['contain', 'smart_crop', 'stretch'].includes(source.delivery?.reframe)
                ? source.delivery.reframe
                : 'contain',
            safeArea: source.delivery?.safeArea !== false,
        },
    };
}

function longformTransitionJoinMap(cuts, options, editPoints = []) {
    return splitLongformSegments(cuts, options, editPoints).joins;
}

function longformCreativeForRender(creative, project, cuts = project.analysis?.cuts || [], options = project.options) {
    const transitionJoins = longformTransitionJoinMap(cuts, options, creative.editPoints);
    return {
        ...creative,
        transitions: creative.transitions.flatMap((item) => {
            const joinIndex = transitionJoins.get(String(item.cutId));
            return Number.isInteger(joinIndex) ? [{ ...item, joinIndex }] : [];
        }),
        broll: creative.broll.map((item) => ({
            ...item,
            path: resolveLongformAsset(project.assetOwner, item.assetId, 'broll'),
        })).filter((item) => item.path),
        color: {
            ...creative.color,
            lutPath: creative.color.lutAssetId
                ? resolveLongformAsset(project.assetOwner, creative.color.lutAssetId, 'lut')
                : null,
        },
        colorWorkflow: {
            ...creative.colorWorkflow,
            groups: (creative.colorWorkflow?.groups || []).map((group) => ({
                ...group,
                grade: {
                    ...group.grade,
                    lutPath: group.grade?.lutAssetId
                        ? resolveLongformAsset(project.assetOwner, group.grade.lutAssetId, 'lut')
                        : null,
                },
            })),
        },
        renderSequence: flattenSequenceForRender(creative.sequence, {
            sourcePath: project.sourcePath,
            resolveAsset: (assetId) => resolveLongformAsset(project.assetOwner, assetId),
        }),
        multicam: {
            ...creative.multicam,
            angles: creative.multicam.angles.map((angle) => ({
                ...angle,
                path: resolveLongformAsset(project.assetOwner, angle.assetId, 'angle'),
            })).filter((angle) => angle.path),
        },
        musicPath: creative.musicAssetId
            ? resolveLongformAsset(project.assetOwner, creative.musicAssetId, 'music')
            : null,
    };
}

function loadLongformProject(name) {
    if (!isValidClipName(name)) throw new Error('Invalid clip name');
    const outputPath = path.join(CLIPS_DIR, name);
    if (!fs.existsSync(outputPath)) throw new Error('Long-form output not found');
    const jsonPath = outputPath.replace(/\.mp4$/i, '.json');
    const meta = readJsonFile(jsonPath, {});
    if (!isLongformProjectName(name, meta)) throw new Error('This export is not a long-form project');

    const requestedSource = resolveSourcePath(meta.source);
    const sourcePath = requestedSource && fs.existsSync(requestedSource) ? requestedSource : outputPath;
    const sourceDuration = Number(
        meta.source_duration_sec ?? meta.source_duration ?? meta.original_duration_sec ?? meta.duration
    ) || probeDurationSync(sourcePath);
    if (!sourceDuration) throw new Error('Could not read the long-form source duration');
    const storedOptions = meta.silence || meta.options || {};
    const selectedRange = meta.selected_range || {};
    const options = normalizeLongformOptions({
        ...storedOptions,
        startSec: storedOptions.startSec ?? storedOptions.selected_start_sec ?? selectedRange.start ?? 0,
        endSec: storedOptions.endSec ?? storedOptions.selected_end_sec ?? selectedRange.end ?? sourceDuration,
    }, sourceDuration, storedOptions);
    const analysis = analysisForClient({
        ...meta,
        cuts: meta.cuts || [],
        keep_segments: meta.keep_segments || [],
        original_duration_sec: meta.original_duration_sec ?? sourceDuration,
        selected_duration_sec: meta.selected_duration_sec ?? (options.endSec - options.startSec),
        removed_duration_sec: meta.removed_duration_sec ?? 0,
        estimated_duration_sec: meta.estimated_duration_sec ?? meta.output_duration ?? (options.endSec - options.startSec),
        join_count: meta.join_count ?? 0,
    }, options);
    const project = { outputPath, sourcePath, sourceDuration, meta, options, analysis, cuts: analysis.cuts };
    project.assetOwner = longformAssetOwner(name, meta);
    project.assets = [
        ...listLongformAssets(project.assetOwner),
        ...listLongformLuts(),
    ];
    project.creative = normalizeLongformCreative(meta.creative, project, {});
    project.renderSegments = splitLongformSegments(
        project.cuts,
        project.options,
        project.creative.editPoints,
    ).segments;
    project.analysis.joinCount = Math.max(0, project.renderSegments.length - 1);
    return project;
}

function longformOwnerDigest(owner) {
    return crypto.createHash('sha256').update(String(owner)).digest('hex').slice(0, 20);
}

function longformSourceFingerprint(sourcePath) {
    const stat = fs.statSync(sourcePath);
    return `${path.resolve(sourcePath)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

function longformProxyPaths(project) {
    const stem = longformOwnerDigest(project.assetOwner);
    return {
        outputPath: path.join(LONGFORM_PROXY_DIR, `${stem}.mp4`),
        metadataPath: path.join(LONGFORM_PROXY_DIR, `${stem}.json`),
        temporaryPath: path.join(LONGFORM_PROXY_DIR, `${stem}.building.mp4`),
    };
}

function getLongformProxyState(name, project) {
    const active = longformProxyJobs.get(project.assetOwner);
    if (active) {
        return {
            status: active.status,
            url: null,
            updatedAt: active.updatedAt,
            error: active.error || null,
        };
    }
    const paths = longformProxyPaths(project);
    const metadata = readJsonFile(paths.metadataPath, null);
    const fingerprint = longformSourceFingerprint(project.sourcePath);
    if (
        metadata?.fingerprint === fingerprint
        && fs.existsSync(paths.outputPath)
        && fs.statSync(paths.outputPath).size > 0
    ) {
        return {
            status: 'ready',
            url: `/api/longform/${encodeURIComponent(name)}/proxy`,
            updatedAt: metadata.updatedAt || null,
            error: null,
        };
    }
    return {
        status: metadata?.error ? 'error' : 'missing',
        url: null,
        updatedAt: metadata?.updatedAt || null,
        error: metadata?.error || null,
    };
}

function startLongformProxyBuild(name, project) {
    const current = getLongformProxyState(name, project);
    if (current.status === 'ready' || current.status === 'building') return current;
    const paths = longformProxyPaths(project);
    try { if (fs.existsSync(paths.temporaryPath)) fs.unlinkSync(paths.temporaryPath); } catch (_) {}
    const state = {
        status: 'building',
        updatedAt: new Date().toISOString(),
        error: null,
        child: null,
    };
    longformProxyJobs.set(project.assetOwner, state);
    const child = spawn(FFMPEG_BIN, [
        '-y', '-nostdin', '-v', 'error',
        '-i', project.sourcePath,
        '-map', '0:v:0', '-map', '0:a?',
        '-vf', "scale='min(1280,iw)':-2:flags=lanczos",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        paths.temporaryPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    state.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        if (stderr.length < 128 * 1024) stderr += chunk.toString();
    });
    child.on('error', (error) => {
        const updatedAt = new Date().toISOString();
        longformProxyJobs.delete(project.assetOwner);
        if (state.cancelled) return;
        writeJsonFile(paths.metadataPath, {
            fingerprint: longformSourceFingerprint(project.sourcePath),
            updatedAt,
            error: error.message,
        });
    });
    child.on('close', (code) => {
        const updatedAt = new Date().toISOString();
        longformProxyJobs.delete(project.assetOwner);
        if (state.cancelled) {
            try { if (fs.existsSync(paths.temporaryPath)) fs.unlinkSync(paths.temporaryPath); } catch (_) {}
            return;
        }
        if (code === 0 && fs.existsSync(paths.temporaryPath)) {
            fs.renameSync(paths.temporaryPath, paths.outputPath);
            writeJsonFile(paths.metadataPath, {
                fingerprint: longformSourceFingerprint(project.sourcePath),
                updatedAt,
                error: null,
            });
            return;
        }
        try { if (fs.existsSync(paths.temporaryPath)) fs.unlinkSync(paths.temporaryPath); } catch (_) {}
        writeJsonFile(paths.metadataPath, {
            fingerprint: longformSourceFingerprint(project.sourcePath),
            updatedAt,
            error: stderr.trim() || `Proxy build exited with code ${code}`,
        });
    });
    return getLongformProxyState(name, project);
}

function longformSnapshotDirectory(owner) {
    return path.join(LONGFORM_SNAPSHOT_DIR, longformOwnerDigest(owner));
}

function listLongformSnapshots(project) {
    const directory = longformSnapshotDirectory(project.assetOwner);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter((filename) => filename.endsWith('.json'))
        .flatMap((filename) => {
            const snapshot = readJsonFile(path.join(directory, filename), null);
            if (!snapshot?.id || !snapshot?.projectMeta) return [];
            return [{
                id: String(snapshot.id),
                name: String(snapshot.name || 'Snapshot'),
                createdAt: String(snapshot.createdAt || ''),
                revision: Math.max(0, Number.parseInt(snapshot.revision, 10) || 0),
                automatic: snapshot.automatic === true,
            }];
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function createLongformSnapshot(project, requestedName, automatic = false) {
    const createdAt = new Date().toISOString();
    const revision = Math.max(0, Number.parseInt(project.meta.draft_revision, 10) || 0);
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const name = String(requestedName || (automatic ? `Autosave r${revision}` : `Snapshot r${revision}`))
        .trim()
        .slice(0, 100) || `Snapshot r${revision}`;
    const directory = longformSnapshotDirectory(project.assetOwner);
    fs.mkdirSync(directory, { recursive: true });
    const snapshot = {
        id,
        name,
        createdAt,
        revision,
        automatic,
        projectMeta: project.meta,
    };
    writeJsonFile(path.join(directory, `${id}.json`), snapshot);
    if (automatic) {
        const automaticSnapshots = listLongformSnapshots(project).filter((item) => item.automatic);
        for (const stale of automaticSnapshots.slice(20)) {
            try { fs.unlinkSync(path.join(directory, `${stale.id}.json`)); } catch (_) {}
        }
    }
    return { id, name, createdAt, revision };
}

function readLongformPresets() {
    const presets = readJsonFile(LONGFORM_PRESETS_PATH, []);
    return Array.isArray(presets) ? presets.slice(0, 100) : [];
}

function writeLongformPresets(presets) {
    writeJsonFile(LONGFORM_PRESETS_PATH, presets.slice(0, 100));
}

function readLongformRenderQueue() {
    const jobs = readJsonFile(LONGFORM_RENDER_QUEUE_PATH, []);
    if (!Array.isArray(jobs)) return [];
    return jobs.slice(-100).map((job) => ({ ...job }));
}

function writeLongformRenderQueue(jobs) {
    writeJsonFile(LONGFORM_RENDER_QUEUE_PATH, jobs.slice(-100));
}

function patchLongformRenderQueueJob(id, patch) {
    const jobs = readLongformRenderQueue();
    const index = jobs.findIndex((job) => job.id === id);
    if (index === -1) return null;
    jobs[index] = { ...jobs[index], ...patch };
    writeLongformRenderQueue(jobs);
    return jobs[index];
}

function enqueueLongformRenderJob({
    projectName,
    outputName,
    sourcePath,
    payload,
    serverSettings,
    runtimeMeta,
    metadata = {},
}) {
    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const payloadPath = path.join(LONGFORM_RENDER_QUEUE_DIR, `${id}.json`);
    writeJsonFile(payloadPath, payload);
    const job = {
        id,
        projectName,
        outputName,
        sourcePath,
        payloadPath,
        serverSettings,
        runtimeMeta,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        error: null,
        ...metadata,
    };
    const jobs = readLongformRenderQueue();
    jobs.push(job);
    writeLongformRenderQueue(jobs);
    setImmediate(processLongformRenderQueue);
    return job;
}

function processLongformRenderQueue() {
    if (longformRenderQueueActive) return;
    reconcileActiveJobState();
    if (readActiveJobState().active) return;
    let jobs = readLongformRenderQueue();
    let recovered = false;
    for (const job of jobs) {
        if (job.status !== 'rendering') continue;
        const completedOutput = path.join(CLIPS_DIR, job.outputName);
        if (fs.existsSync(completedOutput) && fs.statSync(completedOutput).size > 0) {
            job.status = 'complete';
            job.finishedAt = job.finishedAt || new Date().toISOString();
            job.error = null;
            try { if (fs.existsSync(job.payloadPath)) fs.unlinkSync(job.payloadPath); } catch (_) {}
        } else {
            job.status = 'queued';
            job.startedAt = null;
            job.error = 'Recovered after the dashboard lost contact with the render worker';
        }
        recovered = true;
    }
    if (recovered) {
        writeLongformRenderQueue(jobs);
        jobs = readLongformRenderQueue();
    }
    const next = jobs.find((job) => job.status === 'queued');
    if (!next) return;
    if (!fs.existsSync(next.payloadPath) || !fs.existsSync(next.sourcePath)) {
        patchLongformRenderQueueJob(next.id, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: 'The queued source or project payload is missing',
        });
        setImmediate(processLongformRenderQueue);
        return;
    }
    const outputPath = path.join(CLIPS_DIR, next.outputName);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const settings = next.serverSettings || readServerSettings();
    const args = [
        SCRIPT_PATH, next.sourcePath,
        '--mode', 'longform-edit',
        '--longform-json', next.payloadPath,
        '--longform-output', outputPath,
        '--video-encoder', settings.videoEncoder,
        '--compute-device', settings.computeDevice,
        '--vaapi-device', settings.vaapiDevice,
    ];
    longformRenderQueueActive = true;
    patchLongformRenderQueueJob(next.id, {
        status: 'rendering',
        startedAt: new Date().toISOString(),
        error: null,
    });
    let finalized = false;
    const finish = (status, error = null) => {
        if (finalized) return;
        finalized = true;
        longformRenderQueueActive = false;
        patchLongformRenderQueueJob(next.id, {
            status,
            finishedAt: new Date().toISOString(),
            error,
        });
        try { if (fs.existsSync(next.payloadPath)) fs.unlinkSync(next.payloadPath); } catch (_) {}
        if (status === 'complete' && next.deliveryId && fs.existsSync(outputPath)) {
            try {
                const thumbnailPath = outputPath.replace(/\.mp4$/i, '.jpg');
                spawnSync(FFMPEG_BIN, [
                    '-y', '-nostdin', '-v', 'error',
                    '-ss', '1', '-i', outputPath,
                    '-frames:v', '1', '-vf', 'scale=1280:-2:flags=lanczos',
                    thumbnailPath,
                ], { timeout: 2 * MINUTE_MS, stdio: 'ignore' });
                patchLongformDeliveryVariant(next.deliveryId, next.deliveryVariant, {
                    status: 'complete',
                    outputName: next.outputName,
                    outputUrl: `/clips/${next.outputName.split('/').map(encodeURIComponent).join('/')}`,
                    thumbnailUrl: fs.existsSync(thumbnailPath)
                        ? `/clips/${next.outputName.replace(/\.mp4$/i, '.jpg').split('/').map(encodeURIComponent).join('/')}`
                        : null,
                    finishedAt: new Date().toISOString(),
                    error: null,
                });
            } catch (deliveryError) {
                console.error(`Delivery thumbnail update failed: ${deliveryError.message}`);
            }
        } else if (next.deliveryId) {
            patchLongformDeliveryVariant(next.deliveryId, next.deliveryVariant, {
                status: 'failed',
                finishedAt: new Date().toISOString(),
                error,
            });
        }
        _clipsCache = null;
        setTimeout(processLongformRenderQueue, 100).unref();
    };
    try {
        spawnTrackedFactoryJob({
            args,
            cwd: path.join(__dirname, '..'),
            initialLines: [`Long-form render dequeued: ${next.outputName}`],
            stateMeta: {
                label: `Long-form edit: ${next.projectName}`,
                source: next.sourcePath,
                ...(next.runtimeMeta || {}),
            },
            onError: (error) => finish('failed', error.message),
            onClose: (code) => finish(code === 0 ? 'complete' : 'failed', code === 0 ? null : `Process exited with code ${code}`),
        });
    } catch (error) {
        finish('failed', error.message);
    }
}

function buildLongformAssistantSuggestions(project, options, cuts, creative) {
    const words = (Array.isArray(project.meta.words) ? project.meta.words : [])
        .flatMap((word) => {
            const start = Number(word?.start);
            const end = Number(word?.end);
            const text = String(word?.word || '').trim();
            if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
            return [{
                text,
                start,
                end,
                confidence: Number.isFinite(Number(word?.confidence)) ? Number(word.confidence) : null,
                speaker: word?.speaker === undefined || word?.speaker === null ? '' : String(word.speaker),
            }];
        })
        .filter((word) => word.start >= options.startSec && word.end <= options.endSec);
    const suggestions = [];
    const push = (kind, title, detail, confidence, payload) => suggestions.push({
        id: `${kind}-${suggestions.length + 1}-${Math.round(Number(payload?.time ?? payload?.start ?? 0) * 1000)}`,
        kind,
        title,
        detail,
        confidence,
        payload,
    });

    const activeCuts = cuts.filter((cut) => cut.enabled !== false);
    const fillers = new Set(['um', 'uh', 'erm', 'hmm']);
    for (const word of words) {
        const token = word.text.toLowerCase().replace(/[^a-z']/g, '');
        if (!fillers.has(token)) continue;
        if (activeCuts.some((cut) => word.start < cut.end && word.end > cut.start)) continue;
        push('cut', `Remove “${word.text}”`, 'A short filler-word removal is ready to review.', 0.86, {
            start: word.start,
            end: word.end,
        });
        if (suggestions.filter((item) => item.kind === 'cut').length >= 8) break;
    }

    const chapterSpacing = 180;
    for (let time = options.startSec + chapterSpacing; time < options.endSec - 30; time += chapterSpacing) {
        const nearby = words.findIndex((word) => word.start >= time);
        if (nearby < 0) break;
        const title = words.slice(nearby, nearby + 7).map((word) => word.text).join(' ')
            .replace(/[.!?].*$/, '')
            .trim()
            .slice(0, 80);
        push('chapter', title || `Chapter at ${Math.round(time / 60)} minutes`, 'Suggested from the transcript near a natural long-form interval.', 0.66, {
            time: words[nearby].start,
            title: title || `Chapter ${Math.round(time / chapterSpacing) + 1}`,
        });
        if (suggestions.filter((item) => item.kind === 'chapter').length >= 6) break;
    }

    const lowConfidence = words.filter((word) => word.confidence !== null && word.confidence < 0.62);
    if (lowConfidence.length) {
        push('caption', 'Review uncertain transcript words', `${lowConfidence.length} low-confidence word${lowConfidence.length === 1 ? '' : 's'} should be checked before publishing captions.`, 0.94, {
            start: lowConfidence[0].start,
            count: lowConfidence.length,
        });
    }
    if (!options.normalizeAudio && !creative.audio.compressor) {
        push('audio', 'Apply dialogue polish', 'Enable loudness normalization, gentle compression, de-essing, and a safety limiter.', 0.88, {
            normalizeAudio: true,
            targetLufs: -14,
            limiterDb: -1.5,
            compressor: true,
            deEsser: true,
        });
    }
    const speakers = [...new Set(words.map((word) => word.speaker).filter(Boolean))];
    if (speakers.length > 1 && creative.multicam.angles.length) {
        push('multicam', 'Build a speaker-based multicam pass', `Detected ${speakers.length} speakers and ${creative.multicam.angles.length} alternate angle${creative.multicam.angles.length === 1 ? '' : 's'}.`, 0.72, {
            speakers,
        });
    }
    const topic = (Array.isArray(project.meta.topics) ? project.meta.topics : []).find(Boolean);
    if (topic && words.length) {
        push('broll', `Add B-roll for “${String(topic).slice(0, 50)}”`, 'The topic is established in the transcript; review the suggested insertion point.', 0.61, {
            time: words[Math.min(words.length - 1, Math.floor(words.length * 0.25))].start,
            query: String(topic),
        });
    }
    return suggestions.slice(0, 30);
}

function runJsonProcess(executable, args, { timeoutMs = 4 * HOUR_MS } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                VCF_FFMPEG_PATH: FFMPEG_BIN,
                VCF_FFPROBE_PATH: FFPROBE_BIN,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const maxCapture = 8 * 1024 * 1024;
        child.stdout.on('data', (chunk) => { if (stdout.length < maxCapture) stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { if (stderr.length < maxCapture) stderr += chunk.toString(); });
        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) {}
            reject(new Error('Long-form analysis timed out'));
        }, timeoutMs);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(stderr.trim() || `Analysis exited with code ${code}`));
            try { resolve(JSON.parse(stdout)); }
            catch (_) { reject(new Error('Long-form analysis returned invalid data')); }
        });
    });
}

function buildLongformRenderPayload(project, options, cuts, chapters, creative, segments) {
    return {
        manifest_version: 6,
        kind: 'longform',
        source: project.sourcePath,
        source_duration_sec: project.sourceDuration,
        selected_range: { start: options.startSec, end: options.endSec },
        silence: {
            enabled: options.enabled,
            threshold_db: options.thresholdDb,
            min_silence_sec: options.minSilenceSec,
            edge_padding_sec: options.paddingSec,
            audio_fade_sec: options.audioFadeSec,
            video_fade_sec: options.videoFadeSec,
            normalize_audio: options.normalizeAudio,
            target_lufs: options.targetLufs,
            limiter_db: options.limiterDb,
            denoise: options.denoise,
        },
        cuts,
        render_segments: segments.map(([start, end]) => ({ start, end })),
        chapters,
        creative: longformCreativeForRender(creative, project, cuts, options),
        asset_project: project.assetOwner,
        words: Array.isArray(project.meta.words) ? project.meta.words : [],
        topics: Array.isArray(project.meta.topics) ? project.meta.topics : [],
        transcription_provider: project.meta.transcription_provider || null,
        transcription_model: project.meta.transcription_model || null,
        upscale: project.meta.upscale === true,
    };
}

function sourceForProfessionalTool(project, input = {}) {
    const assetId = String(input.assetId || '').trim();
    if (!assetId) return project.sourcePath;
    const assetPath = resolveLongformAsset(project.assetOwner, assetId);
    if (!assetPath) throw new Error('The selected media asset is offline');
    return assetPath;
}

function longformReviewPath(token) {
    const normalized = String(token || '').trim();
    if (!/^[a-f0-9]{40}$/.test(normalized)) return null;
    return path.join(LONGFORM_REVIEW_DIR, `${normalized}.json`);
}

function hashReviewPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const normalized = String(password || '');
    if (!normalized) return { salt: null, hash: null };
    return {
        salt,
        hash: crypto.scryptSync(normalized, salt, 32).toString('hex'),
    };
}

function reviewPasswordMatches(review, password) {
    if (!review.passwordHash || !review.passwordSalt) return true;
    const candidate = hashReviewPassword(password, review.passwordSalt).hash;
    const left = Buffer.from(review.passwordHash, 'hex');
    const right = Buffer.from(candidate || '', 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readLongformReview(token) {
    const reviewPath = longformReviewPath(token);
    if (!reviewPath || !fs.existsSync(reviewPath)) return null;
    return readJsonFile(reviewPath, null);
}

function writeLongformReview(review) {
    const reviewPath = longformReviewPath(review.token);
    if (!reviewPath) throw new Error('Invalid review token');
    writeJsonAtomic(reviewPath, review);
    return review;
}

function creativeReviewTitle(project) {
    return String(
        project.creative?.publish?.title
        || project.meta.title
        || path.basename(project.outputPath, '.mp4'),
    ).trim().slice(0, 180);
}

function longformReviewVersions(projectName, project) {
    const versions = [{
        id: 'project-master',
        label: 'Project master',
        createdAt: project.meta.created_at || project.meta.draft_saved_at || null,
        url: `/clips/${encodeURIComponent(projectName)}`,
    }];
    for (const job of readLongformRenderQueue()) {
        if (job.projectName !== projectName || job.status !== 'complete') continue;
        const outputPath = path.join(CLIPS_DIR, job.outputName);
        if (!fs.existsSync(outputPath)) continue;
        versions.push({
            id: job.id,
            label: job.deliveryVariant
                ? `${String(job.deliveryVariant).replace(/_/g, ' ')} delivery`
                : job.outputName,
            createdAt: job.finishedAt || job.createdAt,
            url: `/clips/${job.outputName.split('/').map(encodeURIComponent).join('/')}`,
        });
    }
    return versions.slice(-30).reverse();
}

function publicLongformReview(review, project) {
    return {
        token: review.token,
        projectName: review.projectName,
        title: review.title,
        createdAt: review.createdAt,
        expiresAt: review.expiresAt,
        status: review.status,
        comments: review.comments || [],
        versions: longformReviewVersions(review.projectName, project),
        passwordRequired: Boolean(review.passwordHash),
        drawingEnabled: true,
    };
}

function defaultLongformEffectTemplates() {
    const createdAt = new Date(0).toISOString();
    return [
        normalizeEffectTemplate({
            id: 'clean-lower-third',
            name: 'Clean lower third',
            category: 'title',
            description: 'A restrained broadcast lower third with editable accent and typography.',
            createdAt,
            controls: [
                { id: 'accent', label: 'Accent', type: 'color', value: '#8B5CF6' },
                { id: 'animation', label: 'Animation', type: 'select', value: 'slide', options: ['none', 'fade', 'slide'] },
            ],
            payload: { title: { style: 'lower_third', template: 'broadcast', animation: 'slide' } },
        }, 'clean-lower-third'),
        normalizeEffectTemplate({
            id: 'cinematic-dissolve',
            name: 'Cinematic dissolve',
            category: 'transition',
            description: 'A short picture and audio dissolve tuned for dialogue edits.',
            createdAt,
            controls: [{ id: 'duration', label: 'Duration', type: 'number', value: 0.35, min: 0.08, max: 2, step: 0.01 }],
            payload: { transition: { type: 'dissolve', duration: 0.35 } },
        }, 'cinematic-dissolve'),
        normalizeEffectTemplate({
            id: 'privacy-face-blur',
            name: 'Tracked face blur',
            category: 'mask',
            description: 'A feathered privacy blur ready for face detection and tracking.',
            createdAt,
            controls: [{ id: 'strength', label: 'Blur', type: 'number', value: 22, min: 1, max: 60, step: 1 }],
            payload: { mask: { type: 'ellipse', effect: 'blur', strength: 22, feather: 0.16 } },
        }, 'privacy-face-blur'),
        normalizeEffectTemplate({
            id: 'documentary-punch-in',
            name: 'Documentary punch-in',
            category: 'effect',
            description: 'A subtle 112% punch-in for jump-cut coverage.',
            createdAt,
            controls: [{ id: 'scale', label: 'Scale', type: 'number', value: 1.12, min: 1, max: 1.5, step: 0.01 }],
            payload: { clip: { scale: 1.12 } },
        }, 'documentary-punch-in'),
        normalizeEffectTemplate({
            id: 'dialogue-polish',
            name: 'Dialogue polish',
            category: 'audio',
            description: 'Compressor, de-esser, noise gate, and delivery-safe loudness.',
            createdAt,
            controls: [],
            payload: { audio: { compressor: true, deEsser: true, noiseGate: true }, normalizeAudio: true },
        }, 'dialogue-polish'),
    ];
}

function readLongformEffectTemplates() {
    const custom = readJsonFile(LONGFORM_TEMPLATES_PATH, []);
    const normalized = (Array.isArray(custom) ? custom : []).slice(0, 500).map((item, index) => (
        normalizeEffectTemplate(item, `template-${index + 1}`)
    ));
    const byId = new Map(defaultLongformEffectTemplates().map((item) => [item.id, item]));
    normalized.forEach((item) => byId.set(item.id, item));
    return [...byId.values()];
}

function writeLongformEffectTemplates(templates) {
    const builtins = new Set(defaultLongformEffectTemplates().map((item) => item.id));
    writeJsonAtomic(
        LONGFORM_TEMPLATES_PATH,
        templates.filter((item) => !builtins.has(item.id)).slice(0, 500),
    );
}

function longformDeliveryManifestPath(deliveryId) {
    const normalized = String(deliveryId || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(normalized)) return null;
    return path.join(LONGFORM_DELIVERY_DIR, normalized, 'package.json');
}

function readLongformDelivery(deliveryId) {
    const manifestPath = longformDeliveryManifestPath(deliveryId);
    if (!manifestPath || !fs.existsSync(manifestPath)) return null;
    return readJsonFile(manifestPath, null);
}

function writeLongformDelivery(delivery) {
    const manifestPath = longformDeliveryManifestPath(delivery.id);
    if (!manifestPath) throw new Error('Invalid delivery id');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeJsonAtomic(manifestPath, delivery);
    return delivery;
}

function patchLongformDeliveryVariant(deliveryId, variantId, patch) {
    const delivery = readLongformDelivery(deliveryId);
    if (!delivery) return null;
    delivery.variants = (delivery.variants || []).map((variant) => (
        variant.id === variantId ? { ...variant, ...patch } : variant
    ));
    delivery.updatedAt = new Date().toISOString();
    writeLongformDelivery(delivery);
    return delivery;
}

function listLongformDeliveries(projectName = null) {
    if (!fs.existsSync(LONGFORM_DELIVERY_DIR)) return [];
    return fs.readdirSync(LONGFORM_DELIVERY_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            const delivery = readLongformDelivery(entry.name);
            if (!delivery || (projectName && delivery.projectName !== projectName)) return [];
            return [delivery];
        })
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, 100);
}

function deliveryVariantCreative(creative, aspect, preset = 'youtube_1080p') {
    return {
        ...creative,
        exportPreset: preset,
        delivery: {
            aspect,
            reframe: aspect === '16:9' ? 'contain' : 'smart_crop',
            safeArea: true,
        },
    };
}

function longformShortCandidates(project, options, chapters, publish) {
    const maximum = Math.max(0, Math.min(12, Number(publish.shortsCount) || 0));
    if (!maximum) return [];
    const duration = clampNumber(publish.shortDurationSec, 45, 10, 180);
    const chapterStarts = chapters
        .map((chapter) => Number(chapter.time))
        .filter((time) => Number.isFinite(time) && time >= options.startSec && time < options.endSec);
    const topicWords = (project.meta.words || [])
        .filter((word) => Number.isFinite(Number(word?.start)))
        .map((word) => Number(word.start));
    const candidates = [...new Set([
        ...chapterStarts,
        ...topicWords.filter((_time, index) => index % Math.max(1, Math.floor(topicWords.length / Math.max(1, maximum))) === 0),
        options.startSec,
    ])].sort((left, right) => left - right);
    return candidates.slice(0, maximum).map((start, index) => ({
        id: `short-${index + 1}`,
        start,
        end: Math.min(options.endSec, start + duration),
        title: chapters.find((chapter) => Math.abs(Number(chapter.time) - start) < 0.05)?.title
            || `Short ${index + 1}`,
    })).filter((item) => item.end - item.start >= 5);
}

function intersectLongformSegments(segments, start, end) {
    return segments.flatMap(([segmentStart, segmentEnd]) => {
        const boundedStart = Math.max(segmentStart, start);
        const boundedEnd = Math.min(segmentEnd, end);
        return boundedEnd - boundedStart >= 0.02 ? [[boundedStart, boundedEnd]] : [];
    });
}

function longformInterchangeContext(project, creative) {
    const segments = splitLongformSegments(project.cuts, project.options, creative.editPoints).segments;
    const items = sequenceTimelineItems(creative.sequence, {
        projectName: path.basename(project.outputPath, '.mp4'),
        sourcePath: project.sourcePath,
        resolveAsset: (assetId) => resolveLongformAsset(project.assetOwner, assetId),
        segments,
    });
    const active = creative.sequence?.sequences?.find((sequence) => sequence.id === creative.sequence.activeSequenceId);
    const frameRate = active?.frameRate || 30;
    return { items, frameRate, segments };
}

function longformConsolidationDirectory(jobId) {
    const normalized = sanitizeLongformId(jobId, '');
    if (!normalized || normalized !== String(jobId || '')) return null;
    const directory = path.resolve(LONGFORM_CONSOLIDATION_DIR, normalized);
    const root = `${path.resolve(LONGFORM_CONSOLIDATION_DIR)}${path.sep}`;
    return directory.startsWith(root) ? directory : null;
}

function readLongformConsolidation(jobId) {
    const directory = longformConsolidationDirectory(jobId);
    if (!directory) return null;
    return readJsonFile(path.join(directory, 'job.json'), null);
}

function writeLongformConsolidation(job) {
    const directory = longformConsolidationDirectory(job?.id);
    if (!directory) throw new Error('Invalid consolidation job');
    fs.mkdirSync(directory, { recursive: true });
    const updated = { ...job, updatedAt: new Date().toISOString() };
    writeJsonAtomic(path.join(directory, 'job.json'), updated);
    return updated;
}

function publicLongformConsolidation(job) {
    if (!job) return null;
    const progress = job.progressPath ? readJsonFile(job.progressPath, null) : null;
    const { requestPath, packagePath, progressPath, ...safe } = job;
    return {
        ...safe,
        progress: progress || {
            status: job.status,
            completed: job.summary?.complete || 0,
            total: job.summary?.total || 0,
            percent: ['complete', 'partial', 'failed'].includes(job.status) ? 100 : 0,
            current: null,
        },
        downloadUrl: ['complete', 'partial'].includes(job.status)
            ? `/api/longform-consolidations/${encodeURIComponent(job.id)}/archive`
            : null,
    };
}

function listLongformConsolidations(projectName) {
    if (!fs.existsSync(LONGFORM_CONSOLIDATION_DIR)) return [];
    return fs.readdirSync(LONGFORM_CONSOLIDATION_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            const job = readLongformConsolidation(entry.name);
            return job && (!projectName || job.projectName === projectName)
                ? [publicLongformConsolidation(job)]
                : [];
        })
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, 100);
}

function longformConsolidationItems(project, creative) {
    const flattened = flattenSequenceForRender(creative.sequence, {
        sourcePath: project.sourcePath,
        resolveAsset: (assetId) => resolveLongformAsset(project.assetOwner, assetId),
    });
    const sequenceItems = flattened.tracks.flatMap((track) => (
        (track.clips || []).flatMap((clip) => (
            clip.enabled === false || clip.sourceType === 'generator'
                ? []
                : [{
                    ...clip,
                    path: clip.path || null,
                    trackName: track.name,
                    trackKind: track.kind,
                    trackOrder: track.order,
                }]
        ))
    ));
    if (sequenceItems.length) return sequenceItems;
    return longformInterchangeContext(project, creative).items.map((item) => ({
        ...item,
        trackKind: 'video',
    }));
}

function writeConsolidatedInterchange(job, result) {
    const completed = (result.items || []).filter((item) => item.status === 'complete' && item.consolidatedPath);
    if (!completed.length) return [];
    const items = completed.map((item) => {
        const usedDuration = Math.max(0.02, Number(item.sourceEnd) - Number(item.sourceStart));
        const headHandle = Math.max(0, Number(item.headHandleSec) || 0);
        return {
            ...item,
            path: item.consolidatedPath,
            sourceStart: headHandle,
            sourceEnd: headHandle + usedDuration,
        };
    });
    const title = job.title || path.basename(job.projectName, '.mp4');
    const frameRate = Number(job.frameRate) || 30;
    const directory = path.join(job.packagePath, 'interchange');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'sequence.edl'), buildLongformEdl(items, { title, frameRate }));
    fs.writeFileSync(path.join(directory, 'sequence.otio'), buildLongformOtio(items, { title, frameRate }));
    fs.writeFileSync(path.join(directory, 'sequence.fcpxml'), buildLongformFcpxml(items, { title, frameRate }));
    return items;
}

function spawnLongformConsolidation(job) {
    const running = writeLongformConsolidation({
        ...job,
        status: 'running',
        startedAt: new Date().toISOString(),
        error: null,
    });
    const child = spawn(PYTHON_BIN, [
        LONGFORM_CONSOLIDATE_PATH,
        running.requestPath,
        running.packagePath,
        '--ffmpeg', FFMPEG_BIN,
        '--ffprobe', FFPROBE_BIN,
        '--progress', running.progressPath,
    ], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            VCF_FFMPEG_PATH: FFMPEG_BIN,
            VCF_FFPROBE_PATH: FFPROBE_BIN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maxCapture = 16 * 1024 * 1024;
    child.stdout.on('data', (chunk) => {
        if (stdout.length < maxCapture) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        if (stderr.length < maxCapture) stderr += chunk.toString();
    });
    child.on('error', (error) => {
        writeLongformConsolidation({
            ...running,
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: error.message,
        });
    });
    child.on('close', async (code) => {
        const current = readLongformConsolidation(running.id) || running;
        let result = null;
        try {
            result = JSON.parse(stdout || '{}');
        } catch (_) {}
        if (!result?.items) {
            writeLongformConsolidation({
                ...current,
                status: 'failed',
                completedAt: new Date().toISOString(),
                error: (stderr || `Consolidation exited with code ${code}`).trim().splitlines().slice(-1)[0],
            });
            return;
        }
        const warnings = [];
        const interchangeItems = writeConsolidatedInterchange(current, result);
        if (interchangeItems.length) {
            try {
                const manifestPath = path.join(current.packagePath, 'interchange', 'sequence.aaf.json');
                const outputPath = path.join(current.packagePath, 'interchange', 'sequence.aaf');
                writeJsonAtomic(manifestPath, {
                    title: current.title,
                    frameRate: current.frameRate,
                    items: interchangeItems,
                });
                await runJsonProcess(PYTHON_BIN, [
                    LONGFORM_AAF_PATH,
                    manifestPath,
                    outputPath,
                    '--ffprobe', FFPROBE_BIN,
                ], { timeoutMs: 30 * MINUTE_MS });
            } catch (error) {
                warnings.push(`AAF generation failed: ${error.message}`);
            }
        }
        fs.writeFileSync(
            path.join(current.packagePath, 'README.txt'),
            [
                `${current.title || current.projectName} consolidated turnover`,
                '',
                `Codec: ${current.codec}`,
                `Requested handles: ${current.handlesSec}s`,
                `Status: ${result.status}`,
                '',
                'The media directory contains one trimmed file per timeline clip.',
                'Interchange source timecodes include the retained head handles.',
                'Original source paths and actual retained handles are recorded in manifest.json.',
                ...(warnings.length ? ['', ...warnings] : []),
                '',
            ].join('\n'),
        );
        writeLongformConsolidation({
            ...current,
            status: result.status,
            completedAt: new Date().toISOString(),
            summary: result.summary,
            warnings,
            error: result.status === 'failed'
                ? (result.items || []).find((item) => item.error)?.error || `Consolidation exited with code ${code}`
                : null,
        });
    });
}

function shortsProjectPath(projectId) {
    const id = String(projectId || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,220}$/.test(id)) return null;
    const filename = id.endsWith('.json') ? id : `${id}.json`;
    const resolved = path.resolve(CANDIDATE_MANIFESTS_DIR, filename);
    const allowedRoot = path.resolve(CANDIDATE_MANIFESTS_DIR) + path.sep;
    return resolved.startsWith(allowedRoot) ? resolved : null;
}

function writeJsonAtomic(filePath, payload) {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
}

function deriveLegacyStoryMetadata(candidates) {
    const normalized = candidates.flatMap((candidate, index) => {
        const start = Number(candidate?.start);
        const end = Number(candidate?.end);
        const id = String(candidate?.yield_id || candidate?.id || `candidate-${index + 1}`);
        return Number.isFinite(start) && Number.isFinite(end) && end > start
            ? [{ id, start, end, score: Number(candidate?.score) || 0 }]
            : [];
    }).sort((left, right) => right.score - left.score || left.start - right.start);
    const clusters = [];
    for (const candidate of normalized) {
        const match = clusters.find((cluster) => {
            const anchor = cluster[0];
            const intersection = Math.max(0, Math.min(candidate.end, anchor.end) - Math.max(candidate.start, anchor.start));
            const union = Math.max(candidate.end, anchor.end) - Math.min(candidate.start, anchor.start);
            const shorter = Math.min(candidate.end - candidate.start, anchor.end - anchor.start);
            return (union > 0 && intersection / union >= 0.2) || (shorter > 0 && intersection / shorter >= 0.35);
        });
        if (match) match.push(candidate);
        else clusters.push([candidate]);
    }
    clusters.sort((left, right) => Math.min(...left.map((item) => item.start)) - Math.min(...right.map((item) => item.start)));
    const output = new Map();
    clusters.forEach((cluster, clusterIndex) => {
        cluster.sort((left, right) => right.score - left.score || left.start - right.start);
        cluster.forEach((candidate, variantIndex) => output.set(candidate.id, {
            clusterId: `legacy-story-${String(clusterIndex + 1).padStart(4, '0')}`,
            variantRank: variantIndex + 1,
            duplicateOf: variantIndex ? cluster[0].id : null,
        }));
    });
    return output;
}

function loadShortsProject(projectId) {
    const manifestPath = shortsProjectPath(projectId);
    if (!manifestPath || !fs.existsSync(manifestPath)) return null;
    const manifest = readJsonFile(manifestPath, null);
    if (!manifest || manifest.kind !== 'shorts_candidate_manifest' || !Array.isArray(manifest.candidates)) return null;
    const sourcePath = resolveSourcePath(manifest.source);
    const exported = new Set((manifest.exported_candidate_ids || []).map(String));
    const failed = new Set((manifest.failed_candidate_ids || []).map(String));
    const selected = new Set((manifest.selected_candidate_ids || []).map(String));
    const feedback = manifest.feedback && typeof manifest.feedback === 'object' ? manifest.feedback : {};
    const legacyMetadata = deriveLegacyStoryMetadata(manifest.candidates);
    const id = path.basename(manifestPath, '.json');
    const candidates = manifest.candidates.flatMap((candidate, index) => {
        if (!candidate || typeof candidate !== 'object') return [];
        const candidateId = String(candidate.yield_id || candidate.id || `candidate-${index + 1}`);
        const start = Number(candidate.start);
        const end = Number(candidate.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
        const derived = legacyMetadata.get(candidateId) || {};
        const clusterId = String(candidate.cluster_id || candidate.story_cluster_id || derived.clusterId || candidateId);
        return [{
            id: String(candidate.id || candidateId),
            yieldId: candidateId,
            start,
            end,
            duration: end - start,
            text: String(candidate.text || ''),
            contextBefore: String(candidate.context_before || ''),
            contextAfter: String(candidate.context_after || ''),
            score: Number(candidate.score) || 0,
            confidenceTier: candidate.confidence_tier || candidate.yield_tier || null,
            reasons: Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 8).map(String) : [],
            topics: Array.isArray(candidate.topics) ? candidate.topics.slice(0, 12).map(String) : [],
            clusterId,
            variantRank: Math.max(1, Number.parseInt(candidate.variant_rank, 10) || derived.variantRank || 1),
            duplicateOf: candidate.duplicate_of ? String(candidate.duplicate_of) : (derived.duplicateOf || null),
            boundaryQuality: candidate.boundary_quality && typeof candidate.boundary_quality === 'object'
                ? candidate.boundary_quality
                : null,
            exported: exported.has(candidateId),
            failed: failed.has(candidateId),
            selected: selected.has(candidateId),
            feedback: feedback[candidateId] || null,
        }];
    });
    const clusters = new Set(candidates.map((candidate) => candidate.clusterId));
    let stat = null;
    try { stat = fs.statSync(manifestPath); } catch (_) {}
    return {
        id,
        manifestPath,
        manifest,
        sourcePath,
        createdAt: String(manifest.created_at || stat?.mtime?.toISOString() || new Date(0).toISOString()),
        status: ['awaiting_review', 'rendering', 'rendered', 'rendered_with_errors'].includes(manifest.status)
            ? manifest.status
            : (exported.size ? 'rendered' : 'awaiting_review'),
        sourceName: sourcePath ? path.basename(sourcePath) : path.basename(String(manifest.source || 'source')),
        candidateCount: candidates.length,
        clusterCount: clusters.size,
        selectedCount: selected.size,
        exportedCount: exported.size,
        candidates,
    };
}

function shortsProjectForClient(project, includeCandidates = false) {
    const payload = {
        id: project.id,
        createdAt: project.createdAt,
        status: project.status,
        sourceName: project.sourceName,
        candidateCount: project.candidateCount,
        clusterCount: project.clusterCount,
        selectedCount: project.selectedCount,
        exportedCount: project.exportedCount,
    };
    if (includeCandidates) {
        payload.sourceUrl = `/api/shorts-projects/${encodeURIComponent(project.id)}/source`;
        payload.settings = project.manifest.settings || {};
        payload.yield = project.manifest.yield || {};
        payload.candidates = project.candidates;
    }
    return payload;
}

function listShortsProjects() {
    if (!fs.existsSync(CANDIDATE_MANIFESTS_DIR)) return [];
    return fs.readdirSync(CANDIDATE_MANIFESTS_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => loadShortsProject(name))
        .filter(Boolean)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function normalizeCandidateFeedback(input, project) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const candidates = new Map(project.manifest.candidates.map((candidate) => [
        String(candidate?.yield_id || candidate?.id || ''),
        candidate,
    ]));
    const normalized = {};
    for (const [candidateId, value] of Object.entries(input).slice(0, 500)) {
        if (!candidates.has(candidateId) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const candidate = candidates.get(candidateId);
        const originalStart = Number(candidate.start);
        const originalEnd = Number(candidate.end);
        const decision = ['approved', 'rejected', 'unreviewed'].includes(value.decision)
            ? value.decision
            : 'unreviewed';
        const item = {
            decision,
            rating: [-1, 0, 1].includes(Number(value.rating)) ? Number(value.rating) : 0,
            reason: String(value.reason || '').trim().slice(0, 240),
            updatedAt: new Date().toISOString(),
        };
        const hasEditedStart = Object.prototype.hasOwnProperty.call(value, 'editedStart');
        const hasEditedEnd = Object.prototype.hasOwnProperty.call(value, 'editedEnd');
        const editedStart = hasEditedStart ? Number(value.editedStart) : originalStart;
        const editedEnd = hasEditedEnd ? Number(value.editedEnd) : originalEnd;
        if ((hasEditedStart || hasEditedEnd) && Number.isFinite(editedStart) && Number.isFinite(editedEnd)) {
            const minimum = Math.max(0, originalStart - 30);
            const maximum = originalEnd + 30;
            if (editedStart >= minimum && editedEnd <= maximum && editedEnd - editedStart >= 0.5 && editedEnd - editedStart <= 180) {
                item.editedStart = editedStart;
                item.editedEnd = editedEnd;
            }
        }
        normalized[candidateId] = item;
    }
    return normalized;
}

function normalizeCandidateSelection(input, project) {
    if (input === undefined) return { ids: null, error: null };
    if (!Array.isArray(input)) return { ids: null, error: 'candidateIds must be an array' };
    const available = new Set(project.candidates
        .filter((candidate) => !candidate.exported && !candidate.failed)
        .map((candidate) => candidate.yieldId));
    const ids = [...new Set(input.map((value) => String(value).trim()))];
    if (ids.length > 50 || ids.some((id) => !/^[a-zA-Z0-9._#:-]{1,160}$/.test(id) || !available.has(id))) {
        return { ids: null, error: 'Choose up to 50 available candidates' };
    }
    return { ids, error: null };
}

app.get('/api/shorts-projects', (req, res) => {
    res.json(listShortsProjects().map((project) => shortsProjectForClient(project, false)));
});

app.get('/api/shorts-projects/:id', (req, res) => {
    const project = loadShortsProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Shorts review project not found' });
    return res.json(shortsProjectForClient(project, true));
});

app.get('/api/shorts-projects/:id/source', (req, res) => {
    const project = loadShortsProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Shorts review project not found' });
    if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
        return res.status(404).json({ error: 'The source video is no longer available' });
    }
    res.setHeader('Accept-Ranges', 'bytes');
    return res.sendFile(project.sourcePath);
});

app.patch('/api/shorts-projects/:id/feedback', express.json({ limit: '2mb' }), (req, res) => {
    const project = loadShortsProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Shorts review project not found' });
    const selection = normalizeCandidateSelection(req.body?.candidateIds, project);
    if (selection.error) return res.status(400).json({ error: selection.error });
    const feedback = normalizeCandidateFeedback(req.body?.feedback, project);
    project.manifest.feedback = { ...(project.manifest.feedback || {}), ...feedback };
    if (selection.ids !== null) project.manifest.selected_candidate_ids = selection.ids;
    project.manifest.review_saved_at = new Date().toISOString();
    writeJsonAtomic(project.manifestPath, project.manifest);
    return res.json(shortsProjectForClient(loadShortsProject(project.id), true));
});

app.post('/api/shorts-projects/:id/render', express.json({ limit: '2mb' }), (req, res) => {
    try {
        reconcileActiveJobState();
        if (readActiveJobState().active) {
            return res.status(409).json({ error: 'Another render job is already running' });
        }
        const project = loadShortsProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Shorts review project not found' });
        if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
            return res.status(404).json({ error: 'The source video is no longer available' });
        }
        const requestedIds = Array.isArray(req.body?.candidateIds)
            ? [...new Set(req.body.candidateIds.map((value) => String(value).trim()))]
            : [];
        if (!requestedIds.length || requestedIds.length > 50 || requestedIds.some((id) => !/^[a-zA-Z0-9._#:-]{1,160}$/.test(id))) {
            return res.status(400).json({ error: 'Choose between 1 and 50 valid candidates' });
        }
        const candidatesById = new Map(project.manifest.candidates.map((candidate) => [
            String(candidate?.yield_id || candidate?.id || ''),
            candidate,
        ]));
        const exported = new Set((project.manifest.exported_candidate_ids || []).map(String));
        const failed = new Set((project.manifest.failed_candidate_ids || []).map(String));
        if (requestedIds.some((id) => !candidatesById.has(id) || exported.has(id) || failed.has(id))) {
            return res.status(409).json({ error: 'One or more candidates are unavailable or already rendered' });
        }
        const normalizedFeedback = normalizeCandidateFeedback(req.body?.feedback, project);
        project.manifest.feedback = { ...(project.manifest.feedback || {}), ...normalizedFeedback };
        for (const candidateId of requestedIds) {
            const candidate = candidatesById.get(candidateId);
            const itemFeedback = project.manifest.feedback[candidateId];
            if (Number.isFinite(itemFeedback?.editedStart) && Number.isFinite(itemFeedback?.editedEnd)) {
                candidate.start = itemFeedback.editedStart;
                candidate.end = itemFeedback.editedEnd;
                candidate.duration = itemFeedback.editedEnd - itemFeedback.editedStart;
                if (Array.isArray(candidate.words)) {
                    candidate.words = candidate.words.filter((word) => Number(word.end) > candidate.start && Number(word.start) < candidate.end);
                }
            }
        }
        project.manifest.selected_candidate_ids = requestedIds;
        project.manifest.status = 'rendering';
        writeJsonAtomic(project.manifestPath, project.manifest);

        const saved = readServerSettings();
        const manifestSettings = project.manifest.settings || {};
        const runtimeMeta = buildTrackedJobMeta({
            ...saved,
            localSemantic: false,
            geminiAnalysis: false,
        }, {
            transcriptionProvider: manifestSettings.transcription_provider || 'reused',
            transcriptionModel: manifestSettings.transcription_model || null,
            localSemantic: false,
            geminiAnalysis: false,
            reviewBeforeRender: false,
        });
        const args = [
            SCRIPT_PATH,
            project.sourcePath,
            '--mode', 'shorts-more',
            '--candidate-manifest', project.manifestPath,
            '--candidate-ids', requestedIds.join(','),
            '--generate-more-count', String(requestedIds.length),
            '--video-encoder', saved.videoEncoder,
            '--compute-device', saved.computeDevice,
            '--vaapi-device', saved.vaapiDevice,
            '--export-preset', String(manifestSettings.export_preset || saved.exportPreset),
            '--output-name-template', String(manifestSettings.output_name_template || saved.outputNameTemplate),
        ];
        const finishManifest = (error = null) => {
            const latest = readJsonFile(project.manifestPath, null);
            if (!latest || latest.kind !== 'shorts_candidate_manifest' || latest.status !== 'rendering') return;
            const exportedCount = Array.isArray(latest.exported_candidate_ids) ? latest.exported_candidate_ids.length : 0;
            const failedCount = Array.isArray(latest.failed_candidate_ids) ? latest.failed_candidate_ids.length : 0;
            latest.status = error
                ? (exportedCount ? 'rendered_with_errors' : 'awaiting_review')
                : (failedCount ? 'rendered_with_errors' : (exportedCount ? 'rendered' : 'awaiting_review'));
            if (error) latest.last_render_error = String(error).slice(0, 500);
            else delete latest.last_render_error;
            writeJsonAtomic(project.manifestPath, latest);
        };
        spawnTrackedFactoryJob({
            args,
            cwd: path.join(__dirname, '..'),
            initialLines: [`Reviewed Shorts render queued: ${requestedIds.length} candidate(s)`],
            stateMeta: {
                label: `Reviewed Shorts: ${project.sourceName}`,
                source: project.sourcePath,
                ...runtimeMeta,
                exportPreset: String(manifestSettings.export_preset || saved.exportPreset),
            },
            onError: (error) => finishManifest(error?.message || 'Unable to start reviewed render'),
            onClose: (code) => finishManifest(code === 0 ? null : `Reviewed render exited with code ${code}`),
        });
        return res.status(202).json({ status: 'queued', requested: requestedIds.length });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Unable to queue reviewed candidates' });
    }
});

app.post('/api/clips/:name/generate-more', (req, res) => {
    try {
        if (!isValidClipName(req.params.name)) return res.status(400).json({ error: 'Invalid clip name' });
        reconcileActiveJobState();
        if (readActiveJobState().active) {
            return res.status(409).json({ error: 'Another render job is already running' });
        }
        const clipPath = path.join(CLIPS_DIR, req.params.name);
        const meta = readClipMetaSync(req.params.name);
        if (!fs.existsSync(clipPath) || !meta) return res.status(404).json({ error: 'Clip metadata not found' });
        const availability = candidateManifestAvailability(meta);
        if (!availability.manifestPath || availability.remaining <= 0) {
            return res.status(409).json({ error: 'No unused candidates remain for this source analysis' });
        }
        const manifest = readJsonFile(availability.manifestPath, null);
        const sourcePath = resolveSourcePath(manifest?.source);
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            return res.status(404).json({ error: 'The original source for this candidate manifest is unavailable' });
        }
        const count = Math.max(1, Math.min(20, Number.parseInt(req.body?.count, 10) || 5));
        const settings = readServerSettings();
        const reusedProvider = manifest?.transcription_provider || meta.transcription_provider || 'reused';
        const reusedModel = manifest?.transcription_model || meta.transcription_model || null;
        const runtimeMeta = buildTrackedJobMeta({
            ...settings,
            localSemantic: false,
            geminiAnalysis: false,
        }, {
            transcriptionProvider: reusedProvider,
            transcriptionModel: reusedModel,
            localSemantic: false,
            geminiAnalysis: false,
        });
        const args = [
            SCRIPT_PATH, sourcePath,
            '--mode', 'shorts-more',
            '--candidate-manifest', availability.manifestPath,
            '--generate-more-count', String(Math.min(count, availability.remaining)),
            '--video-encoder', settings.videoEncoder,
            '--compute-device', settings.computeDevice,
            '--vaapi-device', settings.vaapiDevice,
            '--export-preset', settings.exportPreset,
            '--output-name-template', settings.outputNameTemplate,
        ];
        spawnTrackedFactoryJob({
            args,
            cwd: path.join(__dirname, '..'),
            initialLines: [`Generate More queued from ${req.params.name}`],
            stateMeta: {
                label: `Generate More: ${req.params.name}`,
                source: sourcePath,
                ...runtimeMeta,
                exportPreset: settings.exportPreset,
            },
        });
        return res.status(202).json({
            status: 'queued',
            requested: Math.min(count, availability.remaining),
            remainingBeforeRender: availability.remaining,
        });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.post('/api/longform/:name/assets', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const kind = String(req.body?.kind || '').trim();
        if (!['broll', 'music', 'angle', 'lut', 'media', 'voiceover'].includes(kind)) {
            return res.status(400).json({ error: 'Asset kind must be broll, music, angle, media, voiceover, or lut' });
        }
        const uploaded = req.files?.asset;
        if (!uploaded || Array.isArray(uploaded)) return res.status(400).json({ error: 'Choose one media asset' });
        if (Number(uploaded.size) > 5 * 1024 * 1024 * 1024) return res.status(413).json({ error: 'Long-form assets are limited to 5GB each' });
        const extension = path.extname(String(uploaded.name || '')).toLowerCase();
        const allowed = ['music', 'voiceover'].includes(kind)
            ? new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.webm'])
            : kind === 'lut'
                ? new Set(['.cube', '.3dl', '.dat', '.m3d'])
                : kind === 'media'
                    ? new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.png', '.jpg', '.jpeg', '.webp'])
                    : new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);
        if (!allowed.has(extension)) return res.status(400).json({ error: `Unsupported ${kind} file type` });
        const directory = kind === 'lut'
            ? LONGFORM_LUT_LIBRARY_DIR
            : longformAssetDirectory(project.assetOwner);
        fs.mkdirSync(directory, { recursive: true });
        const filename = `${kind === 'lut' ? 'library' : kind}--${uniqueUploadFilename(uploaded.name)}`;
        const destination = path.join(directory, filename);
        await uploaded.mv(destination);
        const asset = kind === 'lut'
            ? listLongformLuts().find((item) => item.id === filename)
            : listLongformAssets(project.assetOwner).find((item) => item.id === filename);
        return res.status(201).json(publicLongformAsset(asset));
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.get('/api/longform-luts', (_req, res) => {
    return res.json(listLongformLuts().map(publicLongformAsset));
});

app.post('/api/longform-luts', async (req, res) => {
    try {
        const uploaded = req.files?.asset;
        if (!uploaded || Array.isArray(uploaded)) return res.status(400).json({ error: 'Choose one LUT file' });
        if (Number(uploaded.size) > 64 * 1024 * 1024) return res.status(413).json({ error: 'LUT files are limited to 64MB' });
        const extension = path.extname(String(uploaded.name || '')).toLowerCase();
        if (!new Set(['.cube', '.3dl', '.dat', '.m3d']).has(extension)) {
            return res.status(400).json({ error: 'Supported LUT types are .cube, .3dl, .dat, and .m3d' });
        }
        const filename = `library--${uniqueUploadFilename(uploaded.name)}`;
        await uploaded.mv(path.join(LONGFORM_LUT_LIBRARY_DIR, filename));
        const asset = listLongformLuts().find((item) => item.id === filename);
        return res.status(201).json(publicLongformAsset(asset));
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.delete('/api/longform-luts/:assetId', (req, res) => {
    const id = String(req.params.assetId || '');
    if (!/^library--[a-zA-Z0-9._-]{1,220}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid LUT id' });
    }
    const lutPath = resolveLongformAsset('', id, 'lut');
    if (!lutPath) return res.status(404).json({ error: 'LUT not found' });
    fs.unlinkSync(lutPath);
    return res.json({ status: 'deleted' });
});

app.get('/api/longform-luts/:assetId', (req, res) => {
    const lutPath = resolveLongformAsset('', req.params.assetId, 'lut');
    if (!lutPath) return res.status(404).json({ error: 'LUT not found' });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(lutPath);
});

app.get('/api/longform-assets/:owner/:assetId', (req, res) => {
    if (!isValidClipName(req.params.owner)) return res.status(400).json({ error: 'Invalid long-form project' });
    const assetPath = resolveLongformAsset(req.params.owner, req.params.assetId);
    if (!assetPath) return res.status(404).json({ error: 'Asset not found' });
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(assetPath);
});

app.get('/api/longform/:name/project', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        res.json({
            manifestVersion: Number(project.meta.manifest_version) || 2,
            kind: 'longform',
            name: req.params.name,
            sourceUrl: `/api/longform/${encodeURIComponent(req.params.name)}/source`,
            outputUrl: `/clips/${encodeURIComponent(req.params.name)}`,
            waveformUrl: `/api/longform/${encodeURIComponent(req.params.name)}/waveform`,
            sourceDurationSec: project.sourceDuration,
            words: Array.isArray(project.meta.words) ? project.meta.words : [],
            topics: Array.isArray(project.meta.topics) ? project.meta.topics : [],
            chapters: Array.isArray(project.meta.chapters) ? project.meta.chapters : [],
            transcriptionProvider: project.meta.transcription_provider || null,
            transcriptionModel: project.meta.transcription_model || null,
            draftRevision: Math.max(0, Number.parseInt(project.meta.draft_revision, 10) || 0),
            creative: project.creative,
            assets: project.assets.map(publicLongformAsset),
            proxy: getLongformProxyState(req.params.name, project),
            ...project.analysis,
        });
    } catch (error) {
        res.status(error.message === 'Invalid clip name' ? 400 : 404).json({ error: error.message });
    }
});

app.get('/api/longform/:name/proxy', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const state = getLongformProxyState(req.params.name, project);
        if (state.status !== 'ready') return res.status(404).json({ error: 'Proxy is not ready' });
        const { outputPath } = longformProxyPaths(project);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(outputPath);
    } catch (error) {
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.post('/api/longform/:name/proxy', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const state = startLongformProxyBuild(req.params.name, project);
        return res.status(state.status === 'building' ? 202 : 200).json(state);
    } catch (error) {
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.delete('/api/longform/:name/proxy', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const active = longformProxyJobs.get(project.assetOwner);
        if (active?.child) {
            active.cancelled = true;
            try { active.child.kill('SIGTERM'); } catch (_) {}
        }
        longformProxyJobs.delete(project.assetOwner);
        const paths = longformProxyPaths(project);
        for (const filePath of Object.values(paths)) {
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
        }
        return res.json({ status: 'missing', url: null, updatedAt: new Date().toISOString(), error: null });
    } catch (error) {
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.get('/api/longform/:name/snapshots', (req, res) => {
    try {
        return res.json(listLongformSnapshots(loadLongformProject(req.params.name)).map(({ automatic: _automatic, ...item }) => item));
    } catch (error) {
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.post('/api/longform/:name/snapshots', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        return res.status(201).json(createLongformSnapshot(project, req.body?.name));
    } catch (error) {
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.post('/api/longform/:name/snapshots/:snapshotId/restore', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const snapshotId = String(req.params.snapshotId || '');
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(snapshotId)) return res.status(400).json({ error: 'Invalid snapshot' });
        const snapshotPath = path.join(longformSnapshotDirectory(project.assetOwner), `${snapshotId}.json`);
        const snapshot = readJsonFile(snapshotPath, null);
        if (!snapshot?.projectMeta) return res.status(404).json({ error: 'Snapshot not found' });
        createLongformSnapshot(project, `Before restoring ${snapshot.name || snapshotId}`);
        const jsonPath = project.outputPath.replace(/\.mp4$/i, '.json');
        writeJsonFile(jsonPath, {
            ...snapshot.projectMeta,
            draft_revision: Math.max(
                Number.parseInt(project.meta.draft_revision, 10) || 0,
                Number.parseInt(snapshot.projectMeta.draft_revision, 10) || 0,
            ) + 1,
            draft_saved_at: new Date().toISOString(),
        });
        _clipsCache = null;
        return res.json({ status: 'restored' });
    } catch (error) {
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.post('/api/longform/:name/duplicate', (req, res) => {
    let targetOutput = null;
    let targetJson = null;
    try {
        const project = loadLongformProject(req.params.name);
        const requested = String(req.body?.name || '').trim();
        const fallbackStem = `${path.basename(req.params.name, '.mp4')}_copy_${Date.now()}`;
        const safeStem = (requested ? requested.replace(/\.mp4$/i, '') : fallbackStem)
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .replace(/^\.+/, '')
            .slice(0, 150) || fallbackStem;
        const targetName = `${safeStem}.mp4`;
        targetOutput = path.join(CLIPS_DIR, targetName);
        targetJson = targetOutput.replace(/\.mp4$/i, '.json');
        if (fs.existsSync(targetOutput) || fs.existsSync(targetJson)) {
            return res.status(409).json({ error: 'A project with that name already exists' });
        }
        try {
            fs.linkSync(project.outputPath, targetOutput);
        } catch (_) {
            fs.copyFileSync(project.outputPath, targetOutput);
        }
        writeJsonFile(targetJson, {
            ...project.meta,
            duplicated_from: req.params.name,
            duplicated_at: new Date().toISOString(),
            draft_revision: 0,
        });
        _clipsCache = null;
        return res.status(201).json({ name: targetName });
    } catch (error) {
        try { if (targetOutput && fs.existsSync(targetOutput)) fs.unlinkSync(targetOutput); } catch (_) {}
        try { if (targetJson && fs.existsSync(targetJson)) fs.unlinkSync(targetJson); } catch (_) {}
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.post('/api/longform/:name/relink', async (req, res) => {
    let destination = null;
    try {
        const project = loadLongformProject(req.params.name);
        const uploaded = req.files?.source;
        if (!uploaded || Array.isArray(uploaded)) return res.status(400).json({ error: 'Choose one replacement source' });
        const extension = path.extname(String(uploaded.name || '')).toLowerCase();
        if (!new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']).has(extension)) {
            return res.status(400).json({ error: 'Unsupported source video type' });
        }
        destination = path.join(LONGFORM_SOURCE_DIR, uniqueUploadFilename(uploaded.name));
        await uploaded.mv(destination);
        const duration = probeDurationSync(destination);
        if (!duration) throw new Error('Could not read the replacement source');
        const selectedRange = project.meta.selected_range || {};
        const selectedStart = Math.max(0, Math.min(duration - 0.01, Number(selectedRange.start) || 0));
        const selectedEnd = Math.max(selectedStart + 0.01, Math.min(duration, Number(selectedRange.end) || duration));
        writeJsonFile(project.outputPath.replace(/\.mp4$/i, '.json'), {
            ...project.meta,
            source: destination,
            source_duration_sec: duration,
            selected_range: { start: selectedStart, end: selectedEnd },
            cuts: (project.meta.cuts || []).filter((cut) => Number(cut.end) <= selectedEnd),
            relinked_at: new Date().toISOString(),
            draft_revision: Math.max(0, Number.parseInt(project.meta.draft_revision, 10) || 0) + 1,
        });
        _clipsCache = null;
        return res.json({ status: 'relinked', sourceDurationSec: duration });
    } catch (error) {
        try { if (destination && fs.existsSync(destination)) fs.unlinkSync(destination); } catch (_) {}
        return res.status(/not found|not a long-form/i.test(error.message) ? 404 : 400).json({ error: error.message });
    }
});

app.get('/api/longform-presets', (_req, res) => {
    res.json(readLongformPresets());
});

app.post('/api/longform-presets', (req, res) => {
    try {
        const name = String(req.body?.name || '').trim().slice(0, 100);
        const creative = req.body?.creative;
        if (!name) return res.status(400).json({ error: 'Preset name is required' });
        if (!creative || typeof creative !== 'object') return res.status(400).json({ error: 'Preset creative settings are required' });
        const presets = readLongformPresets();
        const preset = {
            id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            name,
            createdAt: new Date().toISOString(),
            creative: JSON.parse(JSON.stringify(creative)),
        };
        presets.unshift(preset);
        writeLongformPresets(presets);
        return res.status(201).json(preset);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.delete('/api/longform-presets/:id', (req, res) => {
    const id = String(req.params.id || '');
    const presets = readLongformPresets();
    const next = presets.filter((preset) => String(preset.id) !== id);
    if (next.length === presets.length) return res.status(404).json({ error: 'Preset not found' });
    writeLongformPresets(next);
    return res.json({ status: 'deleted' });
});

app.get('/api/longform-render-queue', (_req, res) => {
    return res.json(readLongformRenderQueue().map((job) => ({
        id: job.id,
        projectName: job.projectName,
        outputName: job.outputName,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt || null,
        finishedAt: job.finishedAt || null,
        error: job.error || null,
    })));
});

app.get('/api/longform/:name/source', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.sendFile(project.sourcePath);
    } catch (error) {
        res.status(error.message === 'Invalid clip name' ? 400 : 404).json({ error: error.message });
    }
});

app.get('/api/longform/:name/waveform', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const cacheKey = crypto.createHash('sha256')
            .update(`${project.sourcePath}:${fs.statSync(project.sourcePath).mtimeMs}:${project.sourceDuration}`)
            .digest('hex')
            .slice(0, 24);
        const outputPath = path.join(THUMB_CACHE_DIR, `waveform_${cacheKey}.png`);
        const sendWaveform = () => {
            if (res.headersSent) return;
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'private, max-age=86400');
            res.sendFile(outputPath);
        };
        if (fs.existsSync(outputPath)) return sendWaveform();

        const child = spawn(FFMPEG_BIN, [
            '-y', '-nostdin', '-v', 'error', '-i', project.sourcePath,
            '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1800x180:colors=0xd946ef',
            '-frames:v', '1', outputPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString(); });
        const timer = setTimeout(() => child.kill('SIGTERM'), 5 * MINUTE_MS);
        child.on('error', (error) => {
            clearTimeout(timer);
            if (!res.headersSent) res.status(500).json({ error: error.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(outputPath)) return sendWaveform();
            if (!res.headersSent) res.status(500).json({ error: stderr.trim() || 'Waveform generation failed' });
        });
        return undefined;
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 500;
        return res.status(status).json({ error: error.message });
    }
});

app.patch('/api/longform/:name/project', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const requestedRevision = Math.max(0, Number.parseInt(req.body?.revision, 10) || 0);
        const savedRevision = Math.max(0, Number.parseInt(project.meta.draft_revision, 10) || 0);
        if (requestedRevision && savedRevision > requestedRevision) {
            return res.json({ status: 'stale_ignored', revision: savedRevision, ...project.analysis });
        }
        const options = normalizeLongformOptions(req.body?.options, project.sourceDuration, project.options);
        const cuts = normalizeLongformCuts(req.body?.cuts || [], options);
        const chapters = normalizeLongformChapters(req.body?.chapters, options, project.meta.chapters);
        const creative = normalizeLongformCreative(
            req.body?.creative,
            { ...project, options, cuts },
            project.creative,
        );
        const jsonPath = project.outputPath.replace(/\.mp4$/i, '.json');
        const keepSegments = keepSegmentsFromCuts(cuts, options);
        const renderPlan = splitLongformSegments(cuts, options, creative.editPoints);
        const removedDurationSec = options.enabled
            ? cuts.reduce((sum, cut) => sum + (cut.enabled ? cut.duration : 0), 0)
            : 0;
        const summary = analysisForClient({
            cuts,
            keep_segments: keepSegments,
            original_duration_sec: project.sourceDuration,
            selected_duration_sec: options.endSec - options.startSec,
            removed_duration_sec: removedDurationSec,
            estimated_duration_sec: (options.endSec - options.startSec) - removedDurationSec,
            join_count: Math.max(0, renderPlan.segments.length - 1),
        }, options);
        const nextRevision = requestedRevision || savedRevision + 1;
        if (savedRevision > 0 && nextRevision % 10 === 0) {
            createLongformSnapshot(project, `Autosave r${savedRevision}`, true);
        }
        writeJsonFile(jsonPath, {
            ...project.meta,
            manifest_version: Math.max(6, Number(project.meta.manifest_version) || 0),
            selected_range: { start: options.startSec, end: options.endSec },
            silence: {
                enabled: options.enabled,
                threshold_db: options.thresholdDb,
                min_silence_sec: options.minSilenceSec,
                edge_padding_sec: options.paddingSec,
                audio_fade_sec: options.audioFadeSec,
                video_fade_sec: options.videoFadeSec,
                normalize_audio: options.normalizeAudio,
                target_lufs: options.targetLufs,
                limiter_db: options.limiterDb,
                denoise: options.denoise,
            },
            cuts,
            chapters,
            creative,
            asset_project: project.assetOwner,
            keep_segments: summary.keepSegments.map(([start, end]) => ({ start, end, duration: end - start })),
            original_duration_sec: summary.originalDurationSec,
            selected_duration_sec: summary.selectedDurationSec,
            removed_duration_sec: summary.removedDurationSec,
            estimated_duration_sec: summary.estimatedDurationSec,
            join_count: summary.joinCount,
            draft_saved_at: new Date().toISOString(),
            draft_revision: nextRevision,
        });
        _clipsCache = null;
        return res.json({ status: 'saved', ...summary, chapters, creative });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/analyze', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const options = normalizeLongformOptions(req.body?.options, project.sourceDuration, project.options);
        if (!options.enabled) {
            return res.json({
                cuts: [],
                keepSegments: [[options.startSec, options.endSec]],
                originalDurationSec: project.sourceDuration,
                selectedDurationSec: options.endSec - options.startSec,
                removedDurationSec: 0,
                estimatedDurationSec: options.endSec - options.startSec,
                joinCount: 0,
                options,
            });
        }
        const args = [
            LONGFORM_SCRIPT_PATH, 'analyze', project.sourcePath,
            `--threshold-db=${options.thresholdDb}`,
            '--min-silence-sec', String(options.minSilenceSec),
            '--edge-padding-sec', String(options.paddingSec),
            '--start-sec', String(options.startSec),
            '--end-sec', String(options.endSec),
            '--ffmpeg', FFMPEG_BIN,
            '--ffprobe', FFPROBE_BIN,
        ];
        const result = await runJsonProcess(PYTHON_BIN, args);
        res.json(analysisForClient(result, options));
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/assistant', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const options = normalizeLongformOptions(req.body?.options, project.sourceDuration, project.options);
        const cuts = normalizeLongformCuts(req.body?.cuts || [], options);
        const creative = normalizeLongformCreative(
            req.body?.creative,
            { ...project, options, cuts },
            project.creative,
        );
        return res.json({
            suggestions: buildLongformAssistantSuggestions(project, options, cuts, creative),
        });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/auto-grade', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const sourcePath = sourceForProfessionalTool(project, req.body);
        const start = clampNumber(req.body?.start, project.options.startSec, 0, project.sourceDuration);
        const end = clampNumber(req.body?.end, project.options.endSec, start + 0.02, project.sourceDuration);
        const result = await runJsonProcess(PYTHON_BIN, [
            LONGFORM_TOOLS_PATH,
            'auto-grade',
            sourcePath,
            '--start', String(start),
            '--end', String(end),
            '--samples', String(Math.round(clampNumber(req.body?.samples, 36, 8, 96))),
        ], { timeoutMs: 10 * MINUTE_MS });
        return res.json(result);
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/background-key', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const sourcePath = sourceForProfessionalTool(project, req.body);
        const time = clampNumber(req.body?.time, 0, 0, project.sourceDuration);
        const result = await runJsonProcess(PYTHON_BIN, [
            LONGFORM_TOOLS_PATH,
            'background-key',
            sourcePath,
            '--time', String(time),
        ], { timeoutMs: 2 * MINUTE_MS });
        return res.json(result);
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/track', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const sourcePath = sourceForProfessionalTool(project, req.body);
        const start = clampNumber(req.body?.sourceStart, 0, 0, project.sourceDuration);
        const end = clampNumber(req.body?.sourceEnd, Math.min(project.sourceDuration, start + 5), start + 0.05, project.sourceDuration);
        const args = [
            LONGFORM_TOOLS_PATH,
            'track',
            sourcePath,
            '--start', String(start),
            '--end', String(end),
            '--x', String(clampNumber(req.body?.x, 0.25, 0, 1)),
            '--y', String(clampNumber(req.body?.y, 0.25, 0, 1)),
            '--width', String(clampNumber(req.body?.width, 0.25, 0.005, 1)),
            '--height', String(clampNumber(req.body?.height, 0.25, 0.005, 1)),
            '--interval', String(clampNumber(req.body?.interval, 0.25, 0.08, 2)),
        ];
        if (req.body?.face === true) args.push('--face');
        const result = await runJsonProcess(PYTHON_BIN, args, { timeoutMs: 15 * MINUTE_MS });
        const timelineStart = clampNumber(req.body?.timelineStart, 0, 0, 86400);
        const rate = clampNumber(req.body?.rate, 1, 0.05, 16);
        return res.json({
            ...result,
            keyframes: (result.keyframes || []).map((keyframe, index) => ({
                ...keyframe,
                id: `tracked-${Date.now()}-${index}`,
                time: timelineStart + Math.max(0, Number(keyframe.time) - start) / rate,
            })),
        });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/voiceover/align', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const assetId = String(req.body?.assetId || '').trim();
        const sourcePath = resolveLongformAsset(project.assetOwner, assetId, 'voiceover')
            || resolveLongformAsset(project.assetOwner, assetId, 'media');
        if (!sourcePath) return res.status(404).json({ error: 'Voiceover take not found' });
        const result = await runJsonProcess(PYTHON_BIN, [
            LONGFORM_TOOLS_PATH,
            'align-audio',
            sourcePath,
            '--ffmpeg', FFMPEG_BIN,
            '--threshold-db', String(clampNumber(req.body?.thresholdDb, -42, -70, -20)),
        ], { timeoutMs: 5 * MINUTE_MS });
        const cueStart = clampNumber(req.body?.cueStart, 0, 0, 86400);
        return res.json({
            ...result,
            timelineStart: Math.max(0, cueStart - Number(result.leadingSilenceSec || 0)),
        });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/qc', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const options = normalizeLongformOptions(req.body?.options, project.sourceDuration, project.options);
        const cuts = normalizeLongformCuts(req.body?.cuts || project.cuts, options);
        const creative = normalizeLongformCreative(
            req.body?.creative,
            { ...project, options, cuts },
            project.creative,
        );
        const report = await runJsonProcess(PYTHON_BIN, [
            LONGFORM_TOOLS_PATH,
            'qc',
            project.sourcePath,
            '--start', String(options.startSec),
            '--end', String(options.endSec),
            '--ffmpeg', FFMPEG_BIN,
            '--ffprobe', FFPROBE_BIN,
        ], { timeoutMs: 30 * MINUTE_MS });
        const enriched = supplementQcReport(report, creative, {
            sourcePath: project.sourcePath,
            resolveAsset: (assetId) => resolveLongformAsset(project.assetOwner, assetId),
            chapters: normalizeLongformChapters(req.body?.chapters, options, project.meta.chapters),
        });
        const reportId = `${longformOwnerDigest(project.assetOwner)}-${Date.now()}`;
        writeJsonAtomic(path.join(LONGFORM_QC_DIR, `${reportId}.json`), enriched);
        return res.json({ id: reportId, ...enriched });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.get('/api/longform-effect-templates', (_req, res) => {
    return res.json(readLongformEffectTemplates());
});

app.post('/api/longform-effect-templates', (req, res) => {
    try {
        const templates = readLongformEffectTemplates();
        const incoming = Array.isArray(req.body?.templates) ? req.body.templates : [req.body];
        const normalized = incoming.slice(0, 100).map((item, index) => normalizeEffectTemplate(
            item,
            `template-${Date.now()}-${index + 1}`,
        ));
        const byId = new Map(templates.map((item) => [item.id, item]));
        normalized.forEach((item) => byId.set(item.id, item));
        writeLongformEffectTemplates([...byId.values()]);
        return res.status(201).json(normalized.length === 1 ? normalized[0] : normalized);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.delete('/api/longform-effect-templates/:templateId', (req, res) => {
    const templateId = sanitizeLongformId(req.params.templateId, '');
    const builtins = new Set(defaultLongformEffectTemplates().map((item) => item.id));
    if (builtins.has(templateId)) return res.status(400).json({ error: 'Built-in templates cannot be deleted' });
    const templates = readLongformEffectTemplates();
    writeLongformEffectTemplates(templates.filter((item) => item.id !== templateId));
    return res.json({ status: 'deleted' });
});

app.get('/api/longform/:name/reviews', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const reviews = fs.readdirSync(LONGFORM_REVIEW_DIR)
            .filter((filename) => filename.endsWith('.json'))
            .flatMap((filename) => {
                const review = readJsonFile(path.join(LONGFORM_REVIEW_DIR, filename), null);
                if (!review || review.projectName !== req.params.name) return [];
                return [{
                    ...publicLongformReview(review, project),
                    comments: review.comments || [],
                    url: `${req.protocol}://${req.get('host')}/longform-review/${review.token}`,
                }];
            })
            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
        return res.json(reviews);
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/reviews', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const token = crypto.randomBytes(20).toString('hex');
        const password = hashReviewPassword(req.body?.password);
        const expiryDays = Math.round(clampNumber(req.body?.expiryDays, 14, 1, 365));
        const review = writeLongformReview({
            token,
            projectName: req.params.name,
            assetOwner: project.assetOwner,
            title: String(req.body?.title || creativeReviewTitle(project)).trim().slice(0, 180),
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + expiryDays * 24 * HOUR_MS).toISOString(),
            passwordSalt: password.salt,
            passwordHash: password.hash,
            status: 'in_review',
            comments: [],
        });
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        return res.status(201).json({
            ...publicLongformReview(review, project),
            url: `${baseUrl}/longform-review/${token}`,
        });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.get('/api/longform-reviews/:token', (req, res) => {
    try {
        const review = readLongformReview(req.params.token);
        if (!review) return res.status(404).json({ error: 'Review link not found' });
        if (Date.parse(review.expiresAt) < Date.now()) return res.status(410).json({ error: 'This review link has expired' });
        const password = req.get('x-review-password') || req.query.password || '';
        if (!reviewPasswordMatches(review, password)) return res.status(401).json({ error: 'Review password required', passwordRequired: true });
        const project = loadLongformProject(review.projectName);
        return res.json(publicLongformReview(review, project));
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.post('/api/longform-reviews/:token/comments', (req, res) => {
    try {
        const review = readLongformReview(req.params.token);
        if (!review) return res.status(404).json({ error: 'Review link not found' });
        const password = req.get('x-review-password') || req.body?.password || '';
        if (!reviewPasswordMatches(review, password)) return res.status(401).json({ error: 'Review password required' });
        const text = String(req.body?.text || '').trim().slice(0, 2000);
        if (!text) return res.status(400).json({ error: 'Comment text is required' });
        const comment = {
            id: `comment-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            author: String(req.body?.author || 'Reviewer').trim().slice(0, 100),
            text,
            time: clampNumber(req.body?.time, 0, 0, 86400),
            versionId: String(req.body?.versionId || 'project-master').slice(0, 120),
            drawing: (Array.isArray(req.body?.drawing) ? req.body.drawing : []).slice(0, 2000).map((point) => ({
                x: clampNumber(point?.x, 0, 0, 1),
                y: clampNumber(point?.y, 0, 0, 1),
            })),
            createdAt: new Date().toISOString(),
            resolved: false,
        };
        review.comments = [...(review.comments || []), comment].slice(-5000);
        writeLongformReview(review);
        return res.status(201).json(comment);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.patch('/api/longform-reviews/:token', (req, res) => {
    try {
        const review = readLongformReview(req.params.token);
        if (!review) return res.status(404).json({ error: 'Review link not found' });
        const password = req.get('x-review-password') || req.body?.password || '';
        if (!reviewPasswordMatches(review, password)) return res.status(401).json({ error: 'Review password required' });
        if (['approved', 'changes_requested', 'in_review'].includes(req.body?.status)) {
            review.status = req.body.status;
        }
        if (req.body?.commentId) {
            review.comments = (review.comments || []).map((comment) => (
                comment.id === req.body.commentId
                    ? { ...comment, resolved: req.body.resolved === true }
                    : comment
            ));
        }
        writeLongformReview(review);
        const project = loadLongformProject(review.projectName);
        return res.json(publicLongformReview(review, project));
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

app.get('/api/longform/:name/interchange/:format', async (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const format = String(req.params.format || '').toLowerCase();
        if (!['edl', 'otio', 'fcpxml', 'aaf'].includes(format)) {
            return res.status(400).json({ error: 'Format must be EDL, OTIO, FCPXML, or AAF' });
        }
        const context = longformInterchangeContext(project, project.creative);
        const title = path.basename(req.params.name, '.mp4');
        const digest = interchangeDigest(context.items, { title, frameRate: context.frameRate }).slice(0, 20);
        const extension = format === 'fcpxml' ? 'fcpxml' : format;
        const outputPath = path.join(LONGFORM_INTERCHANGE_DIR, `${digest}.${extension}`);
        if (!fs.existsSync(outputPath)) {
            if (format === 'edl') {
                fs.writeFileSync(outputPath, buildLongformEdl(context.items, { title, frameRate: context.frameRate }));
            } else if (format === 'otio') {
                fs.writeFileSync(outputPath, buildLongformOtio(context.items, { title, frameRate: context.frameRate }));
            } else if (format === 'fcpxml') {
                fs.writeFileSync(outputPath, buildLongformFcpxml(context.items, { title, frameRate: context.frameRate }));
            } else {
                const manifestPath = path.join(LONGFORM_INTERCHANGE_DIR, `${digest}.aaf.json`);
                writeJsonAtomic(manifestPath, { title, frameRate: context.frameRate, items: context.items });
                await runJsonProcess(PYTHON_BIN, [
                    LONGFORM_AAF_PATH,
                    manifestPath,
                    outputPath,
                    '--ffprobe', FFPROBE_BIN,
                ], { timeoutMs: 30 * MINUTE_MS });
            }
        }
        return res.download(outputPath, `${title}.${extension}`);
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.get('/api/longform/:name/archive', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const includeMedia = String(req.query.includeMedia || 'true') !== 'false';
        const archiveName = `${path.basename(req.params.name, '.mp4')}-project-archive.zip`;
        res.attachment(archiveName);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', (error) => {
            if (!res.headersSent) res.status(500).json({ error: error.message });
            else res.destroy(error);
        });
        archive.pipe(res);
        archive.file(project.outputPath.replace(/\.mp4$/i, '.json'), { name: 'project/project.json' });
        const interchange = longformInterchangeContext(project, project.creative);
        archive.append(buildLongformEdl(interchange.items, { title: req.params.name, frameRate: interchange.frameRate }), { name: 'interchange/sequence.edl' });
        archive.append(buildLongformOtio(interchange.items, { title: req.params.name, frameRate: interchange.frameRate }), { name: 'interchange/sequence.otio' });
        archive.append(buildLongformFcpxml(interchange.items, { title: req.params.name, frameRate: interchange.frameRate }), { name: 'interchange/sequence.fcpxml' });
        if (includeMedia) {
            archive.file(project.sourcePath, { name: `media/source/${path.basename(project.sourcePath)}` });
            project.assets.forEach((asset) => {
                if (asset.path && fs.existsSync(asset.path)) {
                    archive.file(asset.path, { name: `media/assets/${asset.id}` });
                }
            });
        }
        archive.finalize();
        return undefined;
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.get('/api/longform/:name/consolidations', (req, res) => {
    try {
        loadLongformProject(req.params.name);
        return res.json(listLongformConsolidations(req.params.name));
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/consolidations', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const codec = ['copy', 'prores', 'dnxhr', 'h264'].includes(req.body?.codec)
            ? req.body.codec
            : 'prores';
        const handlesSec = clampNumber(req.body?.handlesSec, 2, 0, 120);
        const title = String(req.body?.title || project.creative?.publish?.title || path.basename(req.params.name, '.mp4'))
            .trim()
            .slice(0, 180);
        const context = longformInterchangeContext(project, project.creative);
        const items = longformConsolidationItems(project, project.creative).slice(0, 10_000);
        if (!items.length) return res.status(400).json({ error: 'The sequence does not reference any media' });
        const lutIds = new Set([
            project.creative.color?.lutAssetId,
            ...(project.creative.colorWorkflow?.groups || []).map((group) => group.grade?.lutAssetId),
        ].filter(Boolean));
        const supportFiles = project.assets
            .filter((asset) => asset.kind === 'lut' && lutIds.has(asset.id) && asset.path && fs.existsSync(asset.path))
            .map((asset) => ({
                id: asset.id,
                name: asset.name,
                kind: asset.kind,
                path: asset.path,
            }));
        const id = `consolidation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const directory = longformConsolidationDirectory(id);
        fs.mkdirSync(directory, { recursive: true });
        const requestPath = path.join(directory, 'request.json');
        const packagePath = path.join(directory, 'package');
        const progressPath = path.join(directory, 'progress.json');
        const projectPath = project.outputPath.replace(/\.mp4$/i, '.json');
        writeJsonAtomic(requestPath, {
            manifestVersion: 1,
            projectName: req.params.name,
            title,
            projectPath: fs.existsSync(projectPath) ? projectPath : null,
            frameRate: context.frameRate,
            codec,
            handlesSec,
            items,
            supportFiles,
        });
        const job = writeLongformConsolidation({
            id,
            projectName: req.params.name,
            title,
            codec,
            handlesSec,
            frameRate: context.frameRate,
            status: 'queued',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            summary: { total: items.length, complete: 0, failed: 0 },
            warnings: [],
            error: null,
            requestPath,
            packagePath,
            progressPath,
        });
        spawnLongformConsolidation(job);
        return res.status(202).json(publicLongformConsolidation(readLongformConsolidation(id)));
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.get('/api/longform-consolidations/:jobId', (req, res) => {
    const job = readLongformConsolidation(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Consolidation job not found' });
    return res.json(publicLongformConsolidation(job));
});

app.get('/api/longform-consolidations/:jobId/archive', (req, res) => {
    const job = readLongformConsolidation(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Consolidation job not found' });
    if (!['complete', 'partial'].includes(job.status)) {
        return res.status(409).json({ error: 'The consolidated package is not ready yet' });
    }
    if (!job.packagePath || !fs.existsSync(job.packagePath)) {
        return res.status(404).json({ error: 'Consolidated package files are missing' });
    }
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (error) => {
        if (!res.headersSent) res.status(500).json({ error: error.message });
        else res.destroy(error);
    });
    res.attachment(`${path.basename(job.projectName, '.mp4')}-consolidated-${job.codec}.zip`);
    archive.pipe(res);
    archive.directory(job.packagePath, path.basename(job.projectName, '.mp4'));
    archive.finalize();
    return undefined;
});

app.get('/api/longform/:name/deliveries', (req, res) => {
    try {
        loadLongformProject(req.params.name);
        return res.json(listLongformDeliveries(req.params.name));
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.post('/api/longform/:name/publish-package', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const options = normalizeLongformOptions(req.body?.options, project.sourceDuration, project.options);
        const cuts = normalizeLongformCuts(req.body?.cuts || [], options);
        const chapters = normalizeLongformChapters(req.body?.chapters, options, project.meta.chapters);
        const creative = normalizeLongformCreative(
            req.body?.creative,
            { ...project, options, cuts },
            project.creative,
        );
        const basePlan = splitLongformSegments(cuts, options, creative.editPoints);
        if (!basePlan.segments.length) {
            return res.status(400).json({ error: 'The current edit removes the entire selected range' });
        }
        const deliveryId = `${path.basename(req.params.name, '.mp4').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 70)}-${longformOwnerDigest(project.assetOwner)}`;
        const existing = readLongformDelivery(deliveryId);
        const existingById = new Map((existing?.variants || []).map((variant) => [variant.id, variant]));
        const baseStem = path.basename(req.params.name, '.mp4')
            .replace(/_silence_edit_\d+$/i, '')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .slice(0, 100);
        const definitions = [];
        if (creative.publish.includeMaster) definitions.push({ id: 'master', label: 'Long master', aspect: 'source', preset: 'source' });
        if (creative.publish.includeHorizontal) definitions.push({ id: 'horizontal', label: 'Horizontal 16:9', aspect: '16:9', preset: 'youtube_1080p' });
        if (creative.publish.includeSquare) definitions.push({ id: 'square', label: 'Square 1:1', aspect: '1:1', preset: 'youtube_1080p' });
        if (creative.publish.includeVertical) definitions.push({ id: 'vertical', label: 'Vertical 9:16', aspect: '9:16', preset: 'youtube_1080p' });
        const shorts = creative.publish.includeShorts
            ? longformShortCandidates(project, options, chapters, creative.publish)
            : [];
        shorts.forEach((candidate) => definitions.push({
            id: candidate.id,
            label: candidate.title,
            aspect: '9:16',
            preset: 'youtube_1080p',
            range: candidate,
        }));

        const serverSettings = readServerSettings();
        const runtimeMeta = buildTrackedJobMeta({
            ...serverSettings,
            localSemantic: false,
            geminiAnalysis: false,
        }, {
            transcriptionProvider: project.meta.transcription_provider || 'reused',
            transcriptionModel: project.meta.transcription_model || null,
            localSemantic: false,
            geminiAnalysis: false,
        });
        const variants = [];
        let queued = 0;
        for (const definition of definitions) {
            const variantCreative = deliveryVariantCreative(creative, definition.aspect, definition.preset);
            const segments = definition.range
                ? intersectLongformSegments(basePlan.segments, definition.range.start, definition.range.end)
                : basePlan.segments;
            if (!segments.length) continue;
            const payload = buildLongformRenderPayload(project, options, cuts, chapters, variantCreative, segments);
            payload.delivery = {
                package_id: deliveryId,
                variant: definition.id,
                title: creative.publish.title,
                description: creative.publish.description,
                destinations: creative.publish.destinations,
                range: definition.range || null,
            };
            const contentHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            const prior = existingById.get(definition.id);
            const outputName = `_deliveries/${deliveryId}/${baseStem}-${definition.id}.mp4`;
            const outputPath = path.join(CLIPS_DIR, outputName);
            if (prior?.contentHash === contentHash && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                variants.push({ ...prior, status: 'complete' });
                continue;
            }
            const job = enqueueLongformRenderJob({
                projectName: req.params.name,
                outputName,
                sourcePath: project.sourcePath,
                payload,
                serverSettings,
                runtimeMeta,
                metadata: {
                    deliveryId,
                    deliveryVariant: definition.id,
                    contentHash,
                },
            });
            queued += 1;
            variants.push({
                id: definition.id,
                label: definition.label,
                aspect: definition.aspect,
                range: definition.range || null,
                contentHash,
                status: 'queued',
                queueId: job.id,
                outputName,
                outputUrl: null,
                thumbnailUrl: null,
                error: null,
            });
        }
        const delivery = writeLongformDelivery({
            id: deliveryId,
            projectName: req.params.name,
            title: creative.publish.title || baseStem,
            description: creative.publish.description,
            destinations: creative.publish.destinations,
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            projectRevision: Number(project.meta.draft_revision) || 0,
            sourceFingerprint: longformSourceFingerprint(project.sourcePath),
            variants,
            metadata: {
                chapters,
                captions: creative.captions.enabled,
                chapterArt: creative.publish.chapterArt,
                thumbnails: creative.publish.thumbnails,
            },
        });
        return res.status(202).json({ status: queued ? 'queued' : 'current', queued, delivery });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        return res.status(status).json({ error: error.message });
    }
});

app.get('/api/longform-deliveries/:deliveryId', (req, res) => {
    const delivery = readLongformDelivery(req.params.deliveryId);
    if (!delivery) return res.status(404).json({ error: 'Delivery package not found' });
    return res.json(delivery);
});

app.get('/api/longform-deliveries/:deliveryId/archive', (req, res) => {
    const delivery = readLongformDelivery(req.params.deliveryId);
    if (!delivery) return res.status(404).json({ error: 'Delivery package not found' });
    const directory = path.dirname(longformDeliveryManifestPath(delivery.id));
    res.attachment(`${delivery.id}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (error) => {
        if (!res.headersSent) res.status(500).json({ error: error.message });
        else res.destroy(error);
    });
    archive.pipe(res);
    archive.directory(directory, delivery.id);
    archive.finalize();
    return undefined;
});

app.post('/api/longform/:name/render', (req, res) => {
    try {
        const project = loadLongformProject(req.params.name);
        const options = normalizeLongformOptions(req.body?.options, project.sourceDuration, project.options);
        const cuts = normalizeLongformCuts(req.body?.cuts || [], options);
        const creative = normalizeLongformCreative(
            req.body?.creative,
            { ...project, options, cuts },
            project.creative,
        );
        const baseStem = path.basename(req.params.name, '.mp4')
            .replace(/_silence_edit_\d+$/i, '')
            .slice(0, 120);
        const outputName = `${baseStem}_silence_edit_${Date.now()}.mp4`;
        const renderPlan = splitLongformSegments(cuts, options, creative.editPoints);
        if (!renderPlan.segments.length) {
            return res.status(400).json({ error: 'The current edit removes the entire selected range' });
        }
        const payload = buildLongformRenderPayload(
            project,
            options,
            cuts,
            normalizeLongformChapters(req.body?.chapters, options, project.meta.chapters),
            creative,
            renderPlan.segments,
        );

        const serverSettings = readServerSettings();
        const runtimeMeta = buildTrackedJobMeta({
            ...serverSettings,
            localSemantic: false,
            geminiAnalysis: false,
        }, {
            transcriptionProvider: project.meta.transcription_provider || 'reused',
            transcriptionModel: project.meta.transcription_model || null,
            localSemantic: false,
            geminiAnalysis: false,
        });
        const job = enqueueLongformRenderJob({
            projectName: req.params.name,
            outputName,
            sourcePath: project.sourcePath,
            payload,
            serverSettings,
            runtimeMeta,
        });
        res.status(202).json({ status: 'queued', outputName, queueId: job.id });
    } catch (error) {
        const status = /not found|not a long-form/i.test(error.message) ? 404 : 400;
        res.status(status).json({ error: error.message });
    }
});

function compilationWorkPath(projectId) {
    const root = path.resolve(COMPILATION_WORK_DIR);
    const resolved = path.resolve(root, String(projectId || ''));
    if (path.dirname(resolved) !== root) throw new Error('Invalid compilation work directory');
    return resolved;
}

function startCompilationProject({ projectId, jobDir, manifestPath, sources, options }) {
    const outputName = `${sanitizeCompilationSlug(options.name)}-${Date.now()}.mp4`;
    const outputPath = path.join(CLIPS_DIR, outputName);
    const workDir = compilationWorkPath(projectId);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const args = [
        ACTION_COMPILER_PATH, manifestPath,
        '--output', outputPath,
        '--ffmpeg', FFMPEG_BIN,
        '--ffprobe', FFPROBE_BIN,
        '--work-dir', workDir,
        '--mode', 'action-compilation',
    ];
    const cleanupPartialOutputs = () => {
        try { fs.unlinkSync(`${outputPath}.part`); } catch (_) {}
        try { fs.unlinkSync(outputPath.replace(/\.mp4$/i, '.json.part')); } catch (_) {}
    };
    const cleanupWork = () => {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (error) {
            appendActiveJobLog(`⚠️ Could not remove montage work directory: ${error.message}`);
        }
    };
    const isHorizontalLongform = options.format === 'horizontal_longform';
    const profileLabel = isHorizontalLongform
        ? 'Horizontal long-form montage'
        : 'Vertical short montage';
    let compilationFinalized = false;
    const finalizeCompilation = (code) => {
        if (compilationFinalized) return;
        compilationFinalized = true;
        cleanupPartialOutputs();
        cleanupWork();

        if (code === 0) {
            try {
                const retained = promoteLatestCompilation({
                    rootDir: COMPILATION_UPLOAD_DIR,
                    projectId,
                    outputName,
                });
                appendActiveJobLog(`💾 Retained ${sources.length} source clips for safe montage recovery`);
                for (const warning of retained.cleanupErrors) {
                    appendActiveJobLog(`⚠️ Could not remove older montage cache ${warning.projectId}: ${warning.error}`);
                }
            } catch (error) {
                appendActiveJobLog(`⚠️ Montage completed, but its recovery cache could not be updated: ${error.message}`);
            }
            return;
        }

        try {
            const retained = retainFailedCompilation({
                rootDir: COMPILATION_UPLOAD_DIR,
                projectId,
                outputName,
            });
            appendActiveJobLog(`💾 Retained ${sources.length} source clips in the failed-job recovery cache`);
            for (const warning of retained.cleanupErrors) {
                appendActiveJobLog(`⚠️ Could not remove older failed montage cache ${warning.projectId}: ${warning.error}`);
            }
        } catch (error) {
            appendActiveJobLog(`⚠️ Could not register failed montage recovery files: ${error.message}`);
        }
    };

    let compilationProcess;
    try {
        compilationProcess = spawnTrackedFactoryJob({
            args,
            cwd: path.join(__dirname, '..'),
            initialLines: [
                `🎞️ ${profileLabel} queued: ${options.name}`,
                `🎬 ${sources.length} source video${sources.length === 1 ? '' : 's'} · ${options.targetDurationSec}s target · ${options.pacing} pace`,
                '🧠 Visual-first analysis: motion, scene changes, focus, color, and exposure (no transcription)',
            ],
            stateMeta: {
                label: `${profileLabel}: ${options.name}`,
                source: `${sources.length} staged source video${sources.length === 1 ? '' : 's'}`,
                computeDevice: 'cpu',
                videoEncoder: 'cpu',
                transcriptionProvider: 'not-required',
                exportPreset: isHorizontalLongform ? 'youtube_1080p' : 'generic',
            },
            onError: () => finalizeCompilation(null),
            onClose: finalizeCompilation,
        });
    } catch (error) {
        finalizeCompilation(null);
        throw error;
    }
    const trackedJobId = compilationProcess?.jobId || readActiveJobState().jobId;
    return {
        status: 'queued',
        jobId: trackedJobId,
        projectId,
        outputName,
        sourceCount: sources.length,
        targetDurationSec: options.targetDurationSec,
        format: options.format,
    };
}

// Wordless multi-source action montage. Files are staged together and one
// lightweight visual-analysis job starts only after every upload is present.
app.post('/api/action-compilations', async (req, res) => {
    let jobDir = null;
    try {
        const options = normalizeCompilationOptions(req.body || {});
        const validation = validateCompilationFiles(req.files?.clips, options.format);
        if (validation.error) {
            cleanupCompilationMultipartFiles(req.files?.clips);
            return res.status(400).json({ error: validation.error });
        }
        reconcileActiveJobState();
        if (readActiveJobState().active || compilationAdmissionActive) {
            cleanupCompilationMultipartFiles(req.files?.clips);
            return res.status(409).json({ error: 'Another render job is already running' });
        }
        // This assignment occurs before the first await, making admission
        // atomic within the Node event loop for concurrent upload completions.
        compilationAdmissionActive = true;

        const projectId = crypto.randomUUID();
        jobDir = path.join(COMPILATION_UPLOAD_DIR, projectId);
        const sourceDir = path.join(jobDir, 'sources');
        fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });

        const sources = [];
        for (let index = 0; index < validation.files.length; index += 1) {
            const uploaded = validation.files[index];
            const extension = path.extname(String(uploaded.name || '')).toLowerCase();
            const sourceId = `source-${String(index + 1).padStart(3, '0')}`;
            const destination = path.join(sourceDir, `${sourceId}${extension}`);
            await uploaded.mv(destination);
            sources.push({
                id: sourceId,
                name: path.basename(String(uploaded.name || `${sourceId}${extension}`)).slice(0, 220),
                path: destination,
                order: index,
                size: Number(uploaded.size) || 0,
            });
        }

        const manifest = {
            manifest_version: 1,
            id: projectId,
            name: options.name,
            format: options.format,
            created_at: new Date().toISOString(),
            settings: compilationManifestSettings(options),
            sources,
        };
        const manifestPath = path.join(jobDir, 'manifest.json');
        writeJsonAtomic(manifestPath, manifest);

        const queued = startCompilationProject({ projectId, jobDir, manifestPath, sources, options });
        compilationAdmissionActive = false;
        return res.status(202).json(queued);
    } catch (error) {
        compilationAdmissionActive = false;
        cleanupCompilationMultipartFiles(req.files?.clips);
        try { if (jobDir && fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
        return res.status(400).json({ error: error.message || 'Could not create action compilation' });
    }
});

// Serve the new Vite build (webui/dist) at / and provide SPA fallback for non-API routes
const DIST_DIR = path.join(__dirname, 'public/dist');
if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR, {
        maxAge: '1h',
        setHeaders(res, filePath) {
            if (/index\.html$/i.test(filePath)) {
                res.setHeader('Cache-Control', 'no-cache');
                return;
            }
            if (/\.(js|css|woff2?|ttf)$/i.test(filePath)) {
                res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
            }
        },
    }));
    // SPA fallback — only for non-API GETs that accept HTML
    app.get(/^(?!\/api|\/clips|\/fonts).*/, (req, res, next) => {
        if (req.method !== 'GET') return next();
        if (!req.accepts('html')) return next();
        const indexPath = path.join(DIST_DIR, 'index.html');
        if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
        next();
    });
    console.log(`📦 Serving webui build from ${DIST_DIR}`);
} else {
    console.log(`ℹ️  No webui build at ${DIST_DIR} — run \`npm run build:webui\` to generate one.`);
}

server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Viral Dashboard running at http://${HOST}:${PORT}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
        console.warn('Dashboard is exposed beyond localhost. No authentication layer is enabled.');
    }
    console.log(`⏱️ HTTP request timeout: ${formatDuration(HTTP_REQUEST_TIMEOUT_MS)}`);
    console.log(`⏱️ Upload idle timeout: ${formatDuration(UPLOAD_IDLE_TIMEOUT_MS)}`);
});

server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;

if (!readActiveJobState().active) {
    const recoveredQueue = readLongformRenderQueue();
    let changed = false;
    for (const job of recoveredQueue) {
        if (job.status !== 'rendering') continue;
        job.status = 'queued';
        job.startedAt = null;
        job.error = 'Dashboard restarted before this queued render began reporting progress';
        changed = true;
    }
    if (changed) writeLongformRenderQueue(recoveredQueue);
}
setTimeout(processLongformRenderQueue, 250).unref();
setInterval(processLongformRenderQueue, 5000).unref();
