const express = require('express');
const fileUpload = require('express-fileupload');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const archiver = require('archiver');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const TEMP_DIR = path.join(__dirname, '../temp_processing');

// Prevent crashes from uncaught errors — log and continue
process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
});

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const ACTIVE_JOB_LOG_TAIL_BYTES = 512 * 1024;
const LOG_HISTORY_LIMIT = 400;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;
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

function sanitizeUploadFilename(fileName) {
    const rawName = path.basename(String(fileName || 'upload.mp4')).trim() || 'upload.mp4';
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return safeName || `upload_${Date.now()}.mp4`;
}

function normalizeUploadOptions(input = {}) {
    const mode = String(input.mode || 'shorts') === 'longform' ? 'longform' : 'shorts';
    const upscale = input.upscale === true || String(input.upscale || '').toLowerCase() === 'true';
    const subtitleStyle = typeof input.subtitleStyle === 'string' && input.subtitleStyle.trim()
        ? input.subtitleStyle.trim()
        : 'classic';
    const maxDuration = ['30', '60', '120', '180'].includes(String(input.maxDuration))
        ? String(input.maxDuration)
        : '180';
    const maxClipsNum = Number.parseInt(input.maxClips, 10);
    const maxClips = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50].includes(maxClipsNum)
        ? String(maxClipsNum)
        : '30';
    const startTime = input.startTime !== undefined && input.startTime !== null && String(input.startTime).trim() !== ''
        ? String(input.startTime).trim()
        : '';
    const endTime = input.endTime !== undefined && input.endTime !== null && String(input.endTime).trim() !== ''
        ? String(input.endTime).trim()
        : '';
    const framingModeRaw = String(input.framingMode || input.framing_mode || 'auto').trim();
    const framingMode = ['auto', 'smart_switch', 'dual_stack'].includes(framingModeRaw)
        ? framingModeRaw
        : 'auto';

    return {
        mode,
        upscale,
        subtitleStyle,
        maxDuration,
        maxClips,
        startTime,
        endTime,
        framingMode
    };
}

function buildFactoryArgsForUpload(uploadPath, options = {}) {
    const normalized = normalizeUploadOptions(options);
    const args = [SCRIPT_PATH, uploadPath, '--mode', normalized.mode];

    if (normalized.upscale) args.push('--upscale');
    if (normalized.subtitleStyle && normalized.subtitleStyle !== 'none') {
        args.push('--subtitle-style', normalized.subtitleStyle);
    }
    if (normalized.maxDuration) {
        args.push('--max-duration', normalized.maxDuration);
    }
    if (normalized.maxClips) {
        args.push('--max-clips', normalized.maxClips);
    }
    if (normalized.startTime) {
        args.push('--start-time', normalized.startTime);
    }
    if (normalized.endTime) {
        args.push('--end-time', normalized.endTime);
    }
    if (normalized.mode === 'shorts' && normalized.framingMode) {
        args.push('--framing-mode', normalized.framingMode);
    }

    return args;
}

function triggerFactoryForUploadedFile(uploadPath, safeName, options = {}) {
    const args = buildFactoryArgsForUpload(uploadPath, options);
    console.log(`🎬 Triggering Factory: ${args.join(' ')}`);

    spawnTrackedFactoryJob({
        args,
        cwd: path.join(__dirname, '..'),
        initialLines: [`🚀 Job Started: ${safeName}`],
        stateMeta: {
            label: safeName,
            source: uploadPath
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

// Config
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PENDING_DIR = path.join(UPLOAD_DIR, 'pending');
const PROCESSING_DIR = path.join(UPLOAD_DIR, 'processing');
const CLIPS_DIR = path.join(__dirname, '../viral_clips');
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const UPLOAD_SESSION_DIR = path.join(RUNTIME_DIR, 'upload-sessions');
const UPLOAD_SESSION_PART_DIR = path.join(RUNTIME_DIR, 'upload-parts');
const ACTIVE_JOB_LOG_PATH = path.join(RUNTIME_DIR, 'active-job.log');
const ACTIVE_JOB_STATE_PATH = path.join(RUNTIME_DIR, 'active-job.json');
const SCRIPT_PATH = path.join(__dirname, '../viral_factory.py');
const DEFAULT_VENV_PYTHON = path.join(__dirname, '../venv/bin/python');
const PYTHON_BIN = process.env.VCF_PYTHON_PATH || (fs.existsSync(DEFAULT_VENV_PYTHON) ? DEFAULT_VENV_PYTHON : 'python3');
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
[UPLOAD_DIR, PENDING_DIR, PROCESSING_DIR, CLIPS_DIR, RUNTIME_DIR, UPLOAD_SESSION_DIR, UPLOAD_SESSION_PART_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.static(path.join(__dirname, 'public')));
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
app.use(fileUpload({
    limits: { fileSize: MAX_UPLOAD_BYTES }, // 50GB limit for 4K/8K videos
    abortOnLimit: true,
    useTempFiles: true,
    tempFileDir: '/tmp/',
    uploadTimeout: UPLOAD_IDLE_TIMEOUT_MS, // wait this long for the next chunk; 0 disables idle timeout
    debug: false
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

function defaultActiveJobState() {
    return {
        active: false,
        recovered: false,
        label: null,
        source: null,
        pid: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        exitCode: null,
        error: null
    };
}

function readActiveJobState() {
    const fallback = defaultActiveJobState();
    if (!fs.existsSync(ACTIVE_JOB_STATE_PATH)) return fallback;
    try {
        const parsed = JSON.parse(fs.readFileSync(ACTIVE_JOB_STATE_PATH, 'utf8'));
        return { ...fallback, ...(parsed || {}) };
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
    if (state.active && isPidRunning(state.pid)) return;

    if (state.active) {
        writeActiveJobState({
            ...state,
            active: false,
            finishedAt: state.finishedAt || new Date().toISOString()
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

function buildClipsCache(cb) {
    fs.readdir(CLIPS_DIR, (err, files) => {
        if (err) { _clipsCache = []; return cb([]); }
        const clips = files
            .filter(f => /\.mp4$/i.test(f))
            .map(f => {
                const meta = readClipMetaSync(f);
                const jsonPath = path.join(CLIPS_DIR, f.replace(/\.mp4$/i, '.json'));
                const scoreFromName = f.match(SCORE_FILENAME_RE)?.[1] || 'N/A';
                return {
                    name: f,
                    url: `/clips/${encodeURIComponent(f)}`,
                    score: typeof meta?.score === 'number' ? meta.score : scoreFromName,
                    candidateScore: typeof meta?.candidate_score === 'number' ? meta.candidate_score : null,
                    reasons: Array.isArray(meta?.reasons) ? meta.reasons.slice(0, 4) : [],
                    scoreBreakdown: meta?.score_breakdown || null,
                    rankingVersion: meta?.ranking_version || null,
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
    
    const args = [SCRIPT_PATH, processingPath, '--mode', 'shorts']; 

    spawnTrackedFactoryJob({
        args,
        cwd: path.join(__dirname, '..'),
        initialLines: [`🚀 Hot Folder Job Started: ${safeName}`],
        stateMeta: {
            label: safeName,
            source: processingPath
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
                  '--rerender-json', tempJson, '--rerender-output', outputPath];

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
        const safeName = sanitizeUploadFilename(originalName);
        const fingerprint = String(body.fingerprint || '').trim();

        if (!originalName || !Number.isFinite(totalSize) || totalSize <= 0) {
            return res.status(400).json({ error: 'Missing file metadata' });
        }
        if (totalSize > MAX_UPLOAD_BYTES) {
            return res.status(400).json({ error: 'File exceeds the 50GB upload limit' });
        }

        let session = readUploadSession(body.sessionId) || findReusableUploadSession(fingerprint);
        if (session && (session.totalSize !== totalSize || session.safeName !== safeName)) {
            session = null;
        }

        const options = normalizeUploadOptions(body);
        const now = new Date().toISOString();

        if (!session || ['processing', 'completed'].includes(session.status)) {
            const sessionId = crypto.randomUUID();
            session = writeUploadSession({
                id: sessionId,
                fingerprint: fingerprint || crypto.createHash('sha1').update(`${safeName}:${totalSize}:${body.lastModified || ''}`).digest('hex'),
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
    const safeName = sanitizeUploadFilename(video.name);
    const uploadPath = path.join(UPLOAD_DIR, safeName);
    const options = normalizeUploadOptions(req.body || {});

    // Reply IMMEDIATELY to prevent browser timeout
    res.json({ status: 'queued', message: 'Upload received! Processing started.' });
    
    video.mv(uploadPath, (err) => {
        if (err) {
            // Only send error if we haven't replied yet (rare race condition, but safe)
            if (!res.headersSent) return res.status(500).send(err);
            console.error("Move error after response:", err);
            return;
        }
        triggerFactoryForUploadedFile(uploadPath, safeName, options);

        // Do NOT send res.json() here again, we already did at the start!
    });
});

// Process URL (YouTube)
app.post('/api/process-url', (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: "Missing URL" });

    const normalized = normalizeUploadOptions(req.body);
    const args = [SCRIPT_PATH, url, '--mode', normalized.mode];
    if (normalized.upscale) args.push('--upscale');
    if (normalized.subtitleStyle && normalized.subtitleStyle !== 'none') {
        args.push('--subtitle-style', normalized.subtitleStyle);
    }
    if (normalized.maxDuration) {
        args.push('--max-duration', normalized.maxDuration);
    }
    if (normalized.maxClips) {
        args.push('--max-clips', normalized.maxClips);
    }
    if (normalized.startTime) {
        args.push('--start-time', normalized.startTime);
    }
    if (normalized.endTime) {
        args.push('--end-time', normalized.endTime);
    }
    if (normalized.mode === 'shorts' && normalized.framingMode) {
        args.push('--framing-mode', normalized.framingMode);
    }

    console.log(`🎬 Triggering Factory (URL): ${args.join(' ')}`);

    spawnTrackedFactoryJob({
        args,
        cwd: path.join(__dirname, '..'),
        initialLines: [`🚀 Video Job Started: ${url}`],
        stateMeta: {
            label: url,
            source: url
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
                  '--rerender-json', tempJson, '--rerender-output', tempOutput];

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

const PROFILES_PATH = path.join(RUNTIME_DIR, 'profiles.json');
const SETTINGS_PATH = path.join(RUNTIME_DIR, 'settings.json');
const JOBS_HISTORY_PATH = path.join(RUNTIME_DIR, 'jobs-history.json');
const THUMB_CACHE_DIR = path.join(RUNTIME_DIR, 'thumbnails');
const FFMPEG_BIN = process.env.VCF_FFMPEG_PATH || 'ffmpeg';
const JOBS_HISTORY_LIMIT = 200;

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

function readJobsHistory() { return readJsonFile(JOBS_HISTORY_PATH, []); }
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
    };
    jobs.push(entry);
    writeJobsHistory(jobs);
    return entry;
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
    const id = recordJobStart({
        kind: (args && args.args && args.args.includes('--mode') && args.args[args.args.indexOf('--mode') + 1]) || 'render',
        label: (args && args.stateMeta && args.stateMeta.label) || 'Job',
        source: (args && args.stateMeta && args.stateMeta.source) || null,
        pid: null,
    });
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
    return _origSpawnTracked({
        ...args,
        onClose: wrappedOnClose,
        onError: wrappedOnError,
    });
};

// Thumbnail — generate on demand, cache to disk
app.get('/api/clips/:name/thumbnail', (req, res) => {
    if (!isValidClipName(req.params.name)) return res.status(400).json({ error: 'Invalid clip name' });
    const clipPath = path.join(CLIPS_DIR, req.params.name);
    if (!fs.existsSync(clipPath)) return res.status(404).json({ error: 'Clip not found' });

    const jsonPath = clipPath.replace(/\.mp4$/i, '.json');
    const meta = readJsonFile(jsonPath, null);
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
        '-vf', 'scale=480:-2:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2:black',
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
        // Apply the same style/anim/font to each clip; one job at a time
        const style = req.body.style;
        const font = req.body.font;
        const animation = req.body.animation;
        const first = clipNames[0];
        const jsonPath = path.join(CLIPS_DIR, first.replace(/\.mp4$/i, '.json'));
        if (!fs.existsSync(jsonPath)) {
            return res.status(404).json({ error: `No metadata for ${first}` });
        }
        let meta;
        try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
        catch { return res.status(500).json({ error: 'Corrupt metadata' }); }
        const { sourcePath: rerenderSource, fallbackReason } = chooseRerenderSource(meta, path.join(CLIPS_DIR, first), jsonPath);
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        const stamp = Date.now();
        const tempJson = path.join(TEMP_DIR, `batch_rerender_${stamp}.json`);
        const payload = { ...meta };
        if (style) payload.style = style;
        if (typeof font !== 'undefined') payload.font = font || null;
        if (animation) payload.animation = animation;
        payload.source = rerenderSource;
        fs.writeFileSync(tempJson, JSON.stringify(payload));
        // Output goes to the first clip in place; subsequent clips will overwrite each other
        // because they share the same source — instead, queue them up
        const remaining = clipNames.slice(1);
        const args = [SCRIPT_PATH, rerenderSource, '--mode', 'rerender',
                      '--rerender-json', tempJson, '--rerender-output', path.join(CLIPS_DIR, first)];
        spawnTrackedFactoryJob({
            args,
            cwd: path.join(__dirname, '..'),
            initialLines: [`🔄 Batch re-render: ${clipNames.length} clip(s)`],
            stateMeta: { label: `Batch re-render: ${clipNames.length} clips`, source: rerenderSource },
            onClose: (code) => {
                try { fs.unlinkSync(tempJson); } catch (_) {}
                if (code !== 0) {
                    appendActiveJobLog(`❌ Batch re-render failed at ${first}`);
                    return;
                }
                if (remaining.length === 0) return;
                // Recursive chain: schedule next by re-entering this handler
                const next = remaining[0];
                const nextJson = path.join(CLIPS_DIR, next.replace(/\.mp4$/i, '.json'));
                if (!fs.existsSync(nextJson)) return;
                let nextMeta;
                try { nextMeta = JSON.parse(fs.readFileSync(nextJson, 'utf8')); } catch { return; }
                const nextSrc = chooseRerenderSource(nextMeta, path.join(CLIPS_DIR, next), nextJson).sourcePath;
                const nextTemp = path.join(TEMP_DIR, `batch_rerender_${Date.now()}.json`);
                const nextPayload = { ...nextMeta, source: nextSrc };
                if (style) nextPayload.style = style;
                if (typeof font !== 'undefined') nextPayload.font = font || null;
                if (animation) nextPayload.animation = animation;
                fs.writeFileSync(nextTemp, JSON.stringify(nextPayload));
                const nextArgs = [SCRIPT_PATH, nextSrc, '--mode', 'rerender',
                                  '--rerender-json', nextTemp, '--rerender-output', path.join(CLIPS_DIR, next)];
                spawnTrackedFactoryJob({
                    args: nextArgs,
                    cwd: path.join(__dirname, '..'),
                    initialLines: [`🔄 Batch re-render: ${next}`],
                    stateMeta: { label: `Batch re-render: ${next}`, source: nextSrc },
                    onClose: () => { try { fs.unlinkSync(nextTemp); } catch (_) {} },
                });
            },
        });
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

// Settings CRUD (lightweight — stores arbitrary JSON)
app.get('/api/settings', (req, res) => {
    res.json(readJsonFile(SETTINGS_PATH, {
        ffmpegPath: FFMPEG_BIN,
        pythonPath: PYTHON_BIN,
        port: PORT,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        resumableChunkBytes: RESUMABLE_CHUNK_BYTES,
    }));
});
app.put('/api/settings', express.json({ limit: '1mb' }), (req, res) => {
    const current = readJsonFile(SETTINGS_PATH, {});
    const next = { ...current, ...req.body, updatedAt: new Date().toISOString() };
    writeJsonFile(SETTINGS_PATH, next);
    res.json({ status: 'ok' });
});

// Serve the new Vite build (webui/dist) at / and provide SPA fallback for non-API routes
const DIST_DIR = path.join(__dirname, 'public/dist');
if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR, {
        maxAge: '1h',
        setHeaders(res, filePath) {
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

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Viral Dashboard running at http://0.0.0.0:${PORT}`);
    console.log(`⏱️ HTTP request timeout: ${formatDuration(HTTP_REQUEST_TIMEOUT_MS)}`);
    console.log(`⏱️ Upload idle timeout: ${formatDuration(UPLOAD_IDLE_TIMEOUT_MS)}`);
});

server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
