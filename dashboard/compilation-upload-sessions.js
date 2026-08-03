'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    MAX_COMPILATION_FILE_BYTES,
    MAX_COMPILATION_TOTAL_BYTES,
    compilationManifestSettings,
    normalizeCompilationOptions,
    validateCompilationFiles,
} = require('./compilation-options');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_CHUNK_BYTES = 32 * MIB;
const DEFAULT_SESSION_TTL_MS = 72 * 60 * 60 * 1000;
const DEFAULT_RESERVE_BYTES = 50 * GIB;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID_PATTERN = /^source-[0-9]{3}$/;

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class CompilationUploadError extends Error {
    constructor(message, status = 400, details = {}) {
        super(message);
        this.name = 'CompilationUploadError';
        this.status = status;
        Object.assign(this, details);
    }
}

function safeUuid(value, label = 'upload session') {
    const normalized = String(value || '').trim();
    if (!UUID_PATTERN.test(normalized)) {
        throw new CompilationUploadError(`Invalid ${label} id`, 400);
    }
    return normalized;
}

function directChild(root, id, label = 'upload session') {
    const safeId = safeUuid(id, label);
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, safeId);
    if (path.dirname(resolved) !== resolvedRoot) {
        throw new CompilationUploadError(`Invalid ${label} path`, 400);
    }
    return resolved;
}

function ensureRealDirectory(directory) {
    const resolved = path.resolve(String(directory || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw new CompilationUploadError('Refusing to use an unsafe media directory', 500);
    }
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(resolved);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new CompilationUploadError('Media storage paths must be real directories', 500);
    }
    return resolved;
}

function requireRegularFile(filePath, label) {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new CompilationUploadError(`${label} must be a regular file`, 400);
    }
    return stats;
}

function writeJsonAtomic(filePath, payload) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
    } finally {
        try { fs.unlinkSync(temporary); } catch (_) {}
    }
}

function parseContentRange(value) {
    const matched = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(String(value || '').trim());
    if (!matched) {
        throw new CompilationUploadError('A valid Content-Range header is required', 400);
    }
    const start = Number(matched[1]);
    const end = Number(matched[2]);
    const total = Number(matched[3]);
    if (
        !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || !Number.isSafeInteger(total)
        || start < 0
        || end < start
        || total <= end
    ) {
        throw new CompilationUploadError('Invalid Content-Range bounds', 400);
    }
    return { start, end, total, length: end - start + 1 };
}

function normalizeStatfsBytes(stats) {
    const availableBlocks = stats?.bavail ?? stats?.bfree;
    const blockSize = stats?.bsize ?? stats?.frsize;
    if (availableBlocks === undefined || blockSize === undefined) {
        throw new CompilationUploadError('Media storage capacity could not be determined', 507);
    }
    const available = BigInt(availableBlocks) * BigInt(blockSize);
    return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
}

function normalizeFileMetadata(files) {
    return files.map((item, index) => {
        const name = path.basename(String(item?.name || '')).trim().slice(0, 220);
        const size = Number(item?.size);
        if (!name || !Number.isSafeInteger(size) || size <= 0) {
            throw new CompilationUploadError('Every source requires a valid name and byte size', 400);
        }
        return {
            sourceId: `source-${String(index + 1).padStart(3, '0')}`,
            name,
            size,
            type: String(item?.type || '').slice(0, 160),
            lastModified: Number.isFinite(Number(item?.lastModified)) ? Number(item.lastModified) : null,
            extension: path.extname(name).toLowerCase(),
            receivedBytes: 0,
            complete: false,
        };
    });
}

function comparableSessionRequest(fingerprint, options, files) {
    return JSON.stringify({
        fingerprint,
        options,
        files: files.map(({ sourceId, name, size, lastModified, extension }) => ({
            sourceId, name, size, lastModified, extension,
        })),
    });
}

function createCompilationUploadManager(config = {}) {
    const mediaRoot = ensureRealDirectory(config.mediaRoot);
    const incomingRoot = ensureRealDirectory(config.incomingRoot || path.join(mediaRoot, 'action-compilation-incoming'));
    const projectRoot = ensureRealDirectory(config.projectRoot || path.join(mediaRoot, 'action-compilations'));
    const tempRoot = ensureRealDirectory(config.tempRoot || path.join(mediaRoot, 'upload-temp'));
    const workRoot = ensureRealDirectory(config.workRoot || path.join(mediaRoot, 'action-compilation-work'));
    const maxFileBytes = positiveInteger(config.maxFileBytes, MAX_COMPILATION_FILE_BYTES);
    const maxTotalBytes = positiveInteger(config.maxTotalBytes, MAX_COMPILATION_TOTAL_BYTES);
    const chunkBytes = positiveInteger(config.chunkBytes, DEFAULT_CHUNK_BYTES);
    const ttlMs = positiveInteger(config.ttlMs, DEFAULT_SESSION_TTL_MS);
    const reserveBytes = positiveInteger(config.reserveBytes, DEFAULT_RESERVE_BYTES);
    const now = typeof config.now === 'function' ? config.now : Date.now;
    const statfsSync = typeof config.statfsSync === 'function' ? config.statfsSync : fs.statfsSync;
    const locks = new Set();

    function sessionJsonPath(sessionDir) {
        return path.join(sessionDir, 'session.json');
    }

    function queuedResultPath(projectDir) {
        return path.join(projectDir, 'queued-result.json');
    }

    function sourcePaths(sessionDir, source) {
        const sourcesDir = path.join(sessionDir, 'sources');
        const directoryStats = fs.lstatSync(sourcesDir);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
            throw new CompilationUploadError('Upload sources must be stored in a real directory', 400);
        }
        const filename = `${source.sourceId}${source.extension}`;
        return {
            finalPath: path.join(sourcesDir, filename),
            partPath: path.join(sourcesDir, `${filename}.part`),
        };
    }

    function readSessionFromDirectory(sessionDir) {
        const stats = fs.lstatSync(sessionDir);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new CompilationUploadError('Upload session must be a real directory', 400);
        }
        const filePath = sessionJsonPath(sessionDir);
        requireRegularFile(filePath, 'Upload session metadata');
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (_) {
            throw new CompilationUploadError('Upload session metadata is corrupt', 500);
        }
        if (!parsed || parsed.version !== 1 || path.basename(sessionDir) !== parsed.id) {
            throw new CompilationUploadError('Upload session metadata is invalid', 500);
        }
        safeUuid(parsed.id);
        return parsed;
    }

    function readSession(sessionId) {
        const sessionDir = directChild(incomingRoot, sessionId);
        if (!fs.existsSync(sessionDir)) {
            throw new CompilationUploadError('Upload session not found', 404);
        }
        return { sessionDir, session: readSessionFromDirectory(sessionDir) };
    }

    function readQueuedResult(sessionId) {
        const projectDir = directChild(projectRoot, sessionId, 'compilation project');
        if (!fs.existsSync(projectDir)) return null;
        const directoryStats = fs.lstatSync(projectDir);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
            throw new CompilationUploadError('Compilation project must be a real directory', 500);
        }
        const resultPath = queuedResultPath(projectDir);
        if (!fs.existsSync(resultPath)) return null;
        requireRegularFile(resultPath, 'Queued compilation result');
        try {
            const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
            return result && result.status === 'queued' ? result : null;
        } catch (_) {
            throw new CompilationUploadError('Queued compilation result is corrupt', 500);
        }
    }

    function finalizedProject(sessionId) {
        const id = safeUuid(sessionId);
        const jobDir = directChild(projectRoot, id, 'compilation project');
        if (!fs.existsSync(jobDir)) return null;
        const directoryStats = fs.lstatSync(jobDir);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
            throw new CompilationUploadError('Compilation project must be a real directory', 500);
        }
        const session = readSessionFromDirectory(jobDir);
        const manifestPath = path.join(jobDir, 'manifest.json');
        requireRegularFile(manifestPath, 'Compilation manifest');
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
        catch (_) { throw new CompilationUploadError('Compilation manifest is corrupt', 500); }
        if (manifest?.id !== id || !Array.isArray(manifest.sources)) {
            throw new CompilationUploadError('Compilation manifest is invalid', 500);
        }
        return {
            projectId: id,
            jobDir,
            manifestPath,
            sources: manifest.sources,
            options: session.options,
        };
    }

    function recordQueued(sessionId, result) {
        const project = finalizedProject(sessionId);
        if (!project) throw new CompilationUploadError('Compilation project not found', 404);
        writeJsonAtomic(queuedResultPath(project.jobDir), result);
        return result;
    }

    function writeSession(sessionDir, session, { touch = true } = {}) {
        const next = {
            ...session,
            updatedAt: touch ? new Date(now()).toISOString() : session.updatedAt,
        };
        writeJsonAtomic(sessionJsonPath(sessionDir), next);
        return next;
    }

    function reconcileSession(sessionDir, session, { persist = true } = {}) {
        let changed = false;
        const files = session.files.map((source) => {
            if (!SOURCE_ID_PATTERN.test(String(source.sourceId || ''))) {
                throw new CompilationUploadError('Upload session contains an invalid source id', 500);
            }
            const { finalPath, partPath } = sourcePaths(sessionDir, source);
            const finalExists = fs.existsSync(finalPath);
            const partExists = fs.existsSync(partPath);
            if (finalExists && partExists) {
                throw new CompilationUploadError(`Source ${source.sourceId} has conflicting upload files`, 500);
            }
            let receivedBytes = 0;
            if (finalExists) receivedBytes = requireRegularFile(finalPath, 'Completed source').size;
            if (partExists) receivedBytes = requireRegularFile(partPath, 'Partial source').size;
            if (receivedBytes > source.size) {
                throw new CompilationUploadError(`Source ${source.sourceId} exceeds its declared size`, 409);
            }
            const complete = finalExists && receivedBytes === source.size;
            if (receivedBytes !== source.receivedBytes || complete !== source.complete) changed = true;
            return { ...source, receivedBytes, complete };
        });
        const status = files.every((source) => source.receivedBytes === source.size) ? 'ready' : 'uploading';
        if (status !== session.status) changed = true;
        const reconciled = { ...session, files, status };
        return changed && persist ? writeSession(sessionDir, reconciled) : reconciled;
    }

    function responseFor(session, extra = {}) {
        const receivedBytes = session.files.reduce((total, source) => total + source.receivedBytes, 0);
        return {
            sessionId: session.id,
            fingerprint: session.fingerprint,
            status: session.status,
            chunkSize: chunkBytes,
            totalBytes: session.totalBytes,
            receivedBytes,
            expiresAt: new Date(Date.parse(session.updatedAt) + ttlMs).toISOString(),
            options: session.options,
            files: session.files.map(({ sourceId, name, size, type, lastModified, receivedBytes: received, complete }) => ({
                sourceId,
                name,
                size,
                type,
                lastModified,
                receivedBytes: received,
                complete,
            })),
            ...extra,
        };
    }

    function availableBytes() {
        try {
            return normalizeStatfsBytes(statfsSync(mediaRoot, { bigint: true }));
        } catch (error) {
            if (error instanceof CompilationUploadError) throw error;
            throw new CompilationUploadError('Media storage capacity could not be determined', 507);
        }
    }

    function pendingReservationBytes(excludeSessionId = null) {
        let reserved = 0;
        for (const sessionDir of listSessionDirectories()) {
            try {
                const session = reconcileSession(sessionDir, readSessionFromDirectory(sessionDir), { persist: false });
                if (session.id === excludeSessionId) continue;
                reserved += session.files.reduce(
                    (total, source) => total + Math.max(0, source.size - source.receivedBytes),
                    0,
                );
            } catch (_) {}
        }
        return reserved;
    }

    function ensureCapacity(requiredBytes, { includePending = false, excludeSessionId = null } = {}) {
        const required = Number(requiredBytes);
        if (!Number.isSafeInteger(required) || required < 0) {
            throw new CompilationUploadError('Invalid upload capacity request', 400);
        }
        const available = availableBytes();
        const pendingBytes = includePending ? pendingReservationBytes(excludeSessionId) : 0;
        if (available - reserveBytes - pendingBytes < required) {
            throw new CompilationUploadError('Not enough media storage is available for this upload', 507, {
                availableBytes: available,
                reserveBytes,
                requiredBytes: required + pendingBytes,
            });
        }
        return available;
    }

    function listSessionDirectories() {
        return fs.readdirSync(incomingRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && UUID_PATTERN.test(entry.name))
            .map((entry) => path.join(incomingRoot, entry.name));
    }

    function cleanupExpired() {
        const cutoff = now() - ttlMs;
        const removed = [];
        for (const sessionDir of listSessionDirectories()) {
            let session;
            try { session = readSessionFromDirectory(sessionDir); } catch (_) { continue; }
            const updated = Date.parse(session.updatedAt || session.createdAt || 0);
            const locked = locks.has(`session:${session.id}`)
                || [...locks].some((key) => key.startsWith(`source:${session.id}:`));
            if (!Number.isFinite(updated) || updated >= cutoff || locked) continue;
            fs.rmSync(sessionDir, { recursive: true, force: true });
            removed.push(session.id);
        }
        return removed;
    }

    function findByFingerprint(fingerprint, options, files) {
        const requested = comparableSessionRequest(fingerprint, options, files);
        for (const sessionDir of listSessionDirectories()) {
            try {
                const session = readSessionFromDirectory(sessionDir);
                if (
                    session.fingerprint === fingerprint
                    && comparableSessionRequest(session.fingerprint, session.options, session.files) === requested
                ) {
                    return { sessionDir, session };
                }
            } catch (_) {}
        }
        return null;
    }

    function initialize(payload = {}) {
        cleanupExpired();
        const fingerprint = String(payload.fingerprint || '').trim();
        if (!fingerprint || fingerprint.length > 512) {
            throw new CompilationUploadError('A valid upload fingerprint is required', 400);
        }
        const options = normalizeCompilationOptions(payload.options || {});
        if (!Array.isArray(payload.files)) {
            throw new CompilationUploadError('Upload files are required', 400);
        }
        const files = normalizeFileMetadata(payload.files);
        const validation = validateCompilationFiles(files, options.format);
        if (validation.error) throw new CompilationUploadError(validation.error, 400);
        if (validation.totalBytes > maxTotalBytes || files.some((source) => source.size > maxFileBytes)) {
            throw new CompilationUploadError('Compilation upload exceeds the configured large-file limits', 400);
        }
        if (payload.sessionId) {
            const queued = readQueuedResult(payload.sessionId);
            if (queued) {
                return { sessionId: payload.sessionId, status: 'queued', finalized: true, result: queued };
            }
            const project = finalizedProject(payload.sessionId);
            if (project) {
                const existing = reconcileSession(project.jobDir, readSessionFromDirectory(project.jobDir));
                if (
                    comparableSessionRequest(existing.fingerprint, existing.options, existing.files)
                    !== comparableSessionRequest(fingerprint, options, files)
                ) {
                    throw new CompilationUploadError('Upload session metadata does not match the selected files', 409);
                }
                return responseFor(existing, { finalized: true });
            }
        }
        const requested = payload.sessionId
            ? readSession(payload.sessionId)
            : findByFingerprint(fingerprint, options, files);
        if (requested) {
            const existing = reconcileSession(requested.sessionDir, requested.session);
            if (
                comparableSessionRequest(existing.fingerprint, existing.options, existing.files)
                !== comparableSessionRequest(fingerprint, options, files)
            ) {
                throw new CompilationUploadError('Upload session metadata does not match the selected files', 409);
            }
            return responseFor(writeSession(requested.sessionDir, existing));
        }

        ensureCapacity(validation.totalBytes, { includePending: true });
        const id = crypto.randomUUID();
        const sessionDir = directChild(incomingRoot, id);
        try {
            fs.mkdirSync(path.join(sessionDir, 'sources'), { recursive: true, mode: 0o700 });
            const createdAt = new Date(now()).toISOString();
            const session = writeSession(sessionDir, {
                version: 1,
                id,
                fingerprint,
                status: 'uploading',
                options,
                totalBytes: validation.totalBytes,
                files,
                createdAt,
                updatedAt: createdAt,
            });
            return responseFor(session);
        } catch (error) {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
            throw error;
        }
    }

    function status(sessionId) {
        const queued = readQueuedResult(sessionId);
        if (queued) return { sessionId, status: 'queued', finalized: true, result: queued };
        const project = finalizedProject(sessionId);
        if (project) {
            return responseFor(
                reconcileSession(project.jobDir, readSessionFromDirectory(project.jobDir)),
                { finalized: true },
            );
        }
        const { sessionDir, session } = readSession(sessionId);
        return responseFor(reconcileSession(sessionDir, session));
    }

    async function appendChunk(sessionId, sourceId, range, contentLength, stream) {
        const id = safeUuid(sessionId);
        if (!SOURCE_ID_PATTERN.test(String(sourceId || ''))) {
            throw new CompilationUploadError('Invalid source id', 400);
        }
        const parsedRange = typeof range === 'string' ? parseContentRange(range) : range;
        const declaredLength = Number(contentLength);
        if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength !== parsedRange.length) {
            throw new CompilationUploadError('Content-Length must match Content-Range', 400);
        }
        if (parsedRange.length > chunkBytes) {
            throw new CompilationUploadError(`Upload chunks are limited to ${chunkBytes} bytes`, 413);
        }
        const lockKey = `source:${id}:${sourceId}`;
        if (locks.has(lockKey) || locks.has(`session:${id}`)) {
            throw new CompilationUploadError('This upload source is already being updated', 409);
        }
        locks.add(lockKey);
        try {
            const { sessionDir, session: rawSession } = readSession(id);
            let session = reconcileSession(sessionDir, rawSession);
            const sourceIndex = session.files.findIndex((item) => item.sourceId === sourceId);
            if (sourceIndex < 0) throw new CompilationUploadError('Upload source not found', 404);
            const source = session.files[sourceIndex];
            if (parsedRange.total !== source.size) {
                throw new CompilationUploadError('Content-Range total does not match the declared source size', 409);
            }
            if (parsedRange.start < source.receivedBytes && parsedRange.end < source.receivedBytes) {
                return responseFor(session, { duplicate: true });
            }
            if (parsedRange.start !== source.receivedBytes) {
                throw new CompilationUploadError('Chunk offset does not match the persisted source size', 409, {
                    receivedBytes: source.receivedBytes,
                });
            }
            if (source.complete) return responseFor(session, { duplicate: true });
            ensureCapacity(parsedRange.length);
            const { finalPath, partPath } = sourcePaths(sessionDir, source);
            if (fs.existsSync(finalPath)) requireRegularFile(finalPath, 'Completed source');
            if (fs.existsSync(partPath)) requireRegularFile(partPath, 'Partial source');

            const noFollow = fs.constants.O_NOFOLLOW || 0;
            const handle = await fs.promises.open(
                partPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow,
                0o600,
            );
            let written = 0;
            let streamError = null;
            try {
                const opened = await handle.stat();
                if (!opened.isFile()) throw new CompilationUploadError('Partial source must be a regular file', 400);
                for await (const incoming of stream) {
                    const buffer = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
                    if (written + buffer.length > parsedRange.length) {
                        throw new CompilationUploadError('Chunk body exceeds Content-Range', 400);
                    }
                    let offset = 0;
                    while (offset < buffer.length) {
                        const result = await handle.write(buffer, offset, buffer.length - offset, null);
                        if (!result.bytesWritten) throw new Error('Chunk write made no progress');
                        offset += result.bytesWritten;
                    }
                    written += buffer.length;
                }
                await handle.sync();
            } catch (error) {
                streamError = error;
            } finally {
                await handle.close();
            }

            const persisted = requireRegularFile(partPath, 'Partial source').size;
            if (persisted > source.size) {
                throw new CompilationUploadError('Persisted source exceeds its declared size', 409);
            }
            const nextSource = { ...source, receivedBytes: persisted, complete: false };
            session.files[sourceIndex] = nextSource;
            session.status = session.files.every((item) => item.receivedBytes === item.size) ? 'ready' : 'uploading';
            session = writeSession(sessionDir, session);
            if (streamError) throw streamError;
            if (written !== parsedRange.length || persisted !== parsedRange.end + 1) {
                throw new CompilationUploadError('Chunk body ended before Content-Range was complete', 400, {
                    receivedBytes: persisted,
                });
            }
            if (persisted === source.size) {
                fs.renameSync(partPath, finalPath);
                session.files[sourceIndex] = { ...nextSource, complete: true };
                session.status = session.files.every((item) => item.complete) ? 'ready' : 'uploading';
                session = writeSession(sessionDir, session);
            }
            return responseFor(session, { duplicate: false });
        } finally {
            locks.delete(lockKey);
        }
    }

    function finalize(sessionId) {
        const id = safeUuid(sessionId);
        const sessionLock = `session:${id}`;
        if (locks.has(sessionLock) || [...locks].some((key) => key.startsWith(`source:${id}:`))) {
            throw new CompilationUploadError('Upload session is currently being updated', 409);
        }
        locks.add(sessionLock);
        try {
            const { sessionDir, session: rawSession } = readSession(id);
            let session = reconcileSession(sessionDir, rawSession);
            if (!session.files.every((source) => source.receivedBytes === source.size)) {
                throw new CompilationUploadError('Upload session is incomplete', 409, {
                    receivedBytes: session.files.reduce((total, source) => total + source.receivedBytes, 0),
                    totalBytes: session.totalBytes,
                });
            }
            const jobDir = directChild(projectRoot, id, 'compilation project');
            if (fs.existsSync(jobDir)) {
                throw new CompilationUploadError('Compilation project already exists', 409);
            }
            const sources = session.files.map((source, index) => {
                const { finalPath, partPath } = sourcePaths(sessionDir, source);
                if (!fs.existsSync(finalPath)) {
                    requireRegularFile(partPath, 'Completed source');
                    fs.renameSync(partPath, finalPath);
                }
                const stats = requireRegularFile(finalPath, 'Completed source');
                if (stats.size !== source.size) {
                    throw new CompilationUploadError(`Source ${source.sourceId} is incomplete`, 409);
                }
                return {
                    id: source.sourceId,
                    name: source.name,
                    path: path.join(jobDir, 'sources', path.basename(finalPath)),
                    order: index,
                    size: source.size,
                };
            });
            const manifest = {
                manifest_version: 1,
                id,
                name: session.options.name,
                format: session.options.format,
                created_at: session.createdAt,
                settings: compilationManifestSettings(session.options),
                sources,
            };
            writeJsonAtomic(path.join(sessionDir, 'manifest.json'), manifest);
            session = writeSession(sessionDir, { ...session, status: 'finalizing' });
            fs.renameSync(sessionDir, jobDir);
            return {
                projectId: id,
                jobDir,
                manifestPath: path.join(jobDir, 'manifest.json'),
                sources,
                options: session.options,
            };
        } finally {
            locks.delete(sessionLock);
        }
    }

    function discard(sessionId) {
        const id = safeUuid(sessionId);
        if (locks.has(`session:${id}`) || [...locks].some((key) => key.startsWith(`source:${id}:`))) {
            throw new CompilationUploadError('Upload session is currently being updated', 409);
        }
        const sessionDir = directChild(incomingRoot, id);
        if (!fs.existsSync(sessionDir)) return false;
        const stats = fs.lstatSync(sessionDir);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new CompilationUploadError('Upload session must be a real directory', 400);
        }
        fs.rmSync(sessionDir, { recursive: true, force: true });
        return true;
    }

    function capabilities() {
        cleanupExpired();
        let available = null;
        let pendingBytes = 0;
        let storageReady = true;
        let storageError = null;
        try {
            available = availableBytes();
            pendingBytes = pendingReservationBytes();
        } catch (error) {
            storageReady = false;
            storageError = error.message;
        }
        if (available !== null && available - pendingBytes <= reserveBytes) {
            storageReady = false;
            storageError = 'Media storage is below the configured free-space reserve';
        }
        return {
            maxFiles: 20,
            maxFileBytes,
            maxTotalBytes,
            chunkSize: chunkBytes,
            sessionTtlMs: ttlMs,
            storage: {
                availableBytes: available,
                reserveBytes,
                pendingUploadBytes: pendingBytes,
                usableBytes: available === null ? null : Math.max(0, available - reserveBytes - pendingBytes),
                ready: storageReady,
                error: storageError,
            },
        };
    }

    function hasSessions() {
        cleanupExpired();
        return listSessionDirectories().length > 0;
    }

    return {
        appendChunk,
        capabilities,
        cleanupExpired,
        discard,
        ensureCapacity,
        finalize,
        finalizedProject,
        hasSessions,
        initialize,
        readQueuedResult,
        recordQueued,
        status,
        paths: { mediaRoot, incomingRoot, projectRoot, tempRoot, workRoot },
    };
}

module.exports = {
    CompilationUploadError,
    DEFAULT_CHUNK_BYTES,
    DEFAULT_RESERVE_BYTES,
    DEFAULT_SESSION_TTL_MS,
    createCompilationUploadManager,
    parseContentRange,
};
