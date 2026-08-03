'use strict';

const fs = require('fs');
const path = require('path');

const LATEST_COMPILATION_MARKER = 'latest-successful.json';
const LATEST_FAILED_COMPILATION_MARKER = 'latest-failed.json';
const SAFE_PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,219}$/;

function directProjectPath(rootDir, projectId) {
    const root = path.resolve(String(rootDir || ''));
    const id = String(projectId || '').trim();
    if (!rootDir || !SAFE_PROJECT_ID.test(id) || id === '.' || id === '..') {
        throw new Error('Invalid compilation project id');
    }
    const projectDir = path.resolve(root, id);
    if (path.dirname(projectDir) !== root) {
        throw new Error('Compilation project must be a direct child of the cache root');
    }
    return { root, id, projectDir };
}

function requireRealDirectory(directory, label) {
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`${label} must be a real directory`);
    }
}

function requireRealFile(filePath, label) {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`${label} must be a real file`);
    }
}

function writeJsonAtomic(filePath, payload) {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, filePath);
    } finally {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    }
}

function promoteLatestCompilation({ rootDir, projectId, outputName, completedAt = new Date().toISOString() }) {
    const { root, id, projectDir } = directProjectPath(rootDir, projectId);
    requireRealDirectory(root, 'Compilation cache root');
    requireRealDirectory(projectDir, 'Compilation project');

    const manifestPath = path.join(projectDir, 'manifest.json');
    const sourcesDir = path.join(projectDir, 'sources');
    requireRealFile(manifestPath, 'Compilation manifest');
    requireRealDirectory(sourcesDir, 'Compilation sources');

    const safeOutputName = path.basename(String(outputName || ''));
    if (!safeOutputName || safeOutputName !== String(outputName || '')) {
        throw new Error('Invalid compilation output name');
    }

    const marker = {
        version: 1,
        projectId: id,
        manifest: `${id}/manifest.json`,
        outputName: safeOutputName,
        completedAt: String(completedAt),
    };

    // Publish the new pointer before pruning the previous project. If the
    // process stops between these steps, one canonical successful project is
    // still recoverable and the extra directory is cleaned on the next success.
    writeJsonAtomic(path.join(root, LATEST_COMPILATION_MARKER), marker);

    const removed = [];
    const cleanupErrors = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === id || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const stalePath = path.join(root, entry.name);
        try {
            fs.rmSync(stalePath, { recursive: true, force: true });
            removed.push(entry.name);
        } catch (error) {
            cleanupErrors.push({ projectId: entry.name, error: error.message });
        }
    }
    try { fs.unlinkSync(path.join(root, LATEST_FAILED_COMPILATION_MARKER)); } catch (_) {}

    return { ...marker, projectDir, manifestPath, removed, cleanupErrors };
}

function retainFailedCompilation({ rootDir, projectId, outputName, failedAt = new Date().toISOString() }) {
    const { root, id, projectDir } = directProjectPath(rootDir, projectId);
    requireRealDirectory(root, 'Compilation cache root');
    requireRealDirectory(projectDir, 'Compilation project');
    const manifestPath = path.join(projectDir, 'manifest.json');
    requireRealFile(manifestPath, 'Compilation manifest');
    requireRealDirectory(path.join(projectDir, 'sources'), 'Compilation sources');

    const safeOutputName = path.basename(String(outputName || ''));
    if (!safeOutputName || safeOutputName !== String(outputName || '')) {
        throw new Error('Invalid compilation output name');
    }
    const marker = {
        version: 1,
        status: 'failed',
        projectId: id,
        manifest: `${id}/manifest.json`,
        outputName: safeOutputName,
        failedAt: String(failedAt),
    };
    writeJsonAtomic(path.join(root, LATEST_FAILED_COMPILATION_MARKER), marker);

    const successfulId = readLatestCompilation(root)?.projectId || null;
    const removed = [];
    const cleanupErrors = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (
            entry.name === id
            || entry.name === successfulId
            || !entry.isDirectory()
            || entry.isSymbolicLink()
        ) continue;
        try {
            fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
            removed.push(entry.name);
        } catch (error) {
            cleanupErrors.push({ projectId: entry.name, error: error.message });
        }
    }
    return { ...marker, projectDir, manifestPath, removed, cleanupErrors };
}

function discardCompilationUpload({ rootDir, projectId }) {
    const { projectDir } = directProjectPath(rootDir, projectId);
    if (!fs.existsSync(projectDir)) return false;
    requireRealDirectory(projectDir, 'Compilation project');
    fs.rmSync(projectDir, { recursive: true, force: true });
    return true;
}

function readLatestCompilation(rootDir) {
    try {
        const root = path.resolve(String(rootDir || ''));
        const markerPath = path.join(root, LATEST_COMPILATION_MARKER);
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (marker?.version !== 1) return null;

        const { id, projectDir } = directProjectPath(root, marker.projectId);
        if (marker.manifest !== `${id}/manifest.json`) return null;
        const outputName = path.basename(String(marker.outputName || ''));
        if (!outputName || outputName !== String(marker.outputName || '')) return null;

        const manifestPath = path.join(projectDir, 'manifest.json');
        requireRealDirectory(projectDir, 'Compilation project');
        requireRealDirectory(path.join(projectDir, 'sources'), 'Compilation sources');
        requireRealFile(manifestPath, 'Compilation manifest');
        return { ...marker, projectDir, manifestPath };
    } catch (_) {
        return null;
    }
}

module.exports = {
    LATEST_COMPILATION_MARKER,
    LATEST_FAILED_COMPILATION_MARKER,
    discardCompilationUpload,
    promoteLatestCompilation,
    readLatestCompilation,
    retainFailedCompilation,
};
