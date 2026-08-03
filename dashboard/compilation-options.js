const path = require('path');

const GIB = 1024 * 1024 * 1024;

function positiveIntegerEnvironment(name, fallback) {
    const parsed = Number.parseInt(String(process.env[name] || ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const MIN_COMPILATION_FILES = 2;
const MIN_HORIZONTAL_COMPILATION_FILES = 1;
const MAX_COMPILATION_FILES = 20;
const MAX_COMPILATION_FILE_BYTES = positiveIntegerEnvironment(
    'VCF_COMPILATION_MAX_FILE_BYTES',
    20 * GIB,
);
const MAX_COMPILATION_TOTAL_BYTES = positiveIntegerEnvironment(
    'VCF_COMPILATION_MAX_TOTAL_BYTES',
    100 * GIB,
);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.mts', '.m2ts']);

function formatByteLimit(bytes) {
    if (bytes % GIB === 0) return `${bytes / GIB}GB`;
    return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

function oneOf(value, allowed, fallback) {
    const normalized = String(value || '').trim();
    return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeCompilationOptions(input = {}) {
    const format = oneOf(input.format, ['vertical_short', 'horizontal_longform'], 'vertical_short');
    const target = Number.parseInt(input.targetDurationSec ?? input.target_duration_sec, 10);
    const targetDefaults = format === 'horizontal_longform'
        ? { fallback: 300, min: 180, max: 900 }
        : { fallback: 30, min: 4, max: 180 };
    const defaultPacing = format === 'horizontal_longform' ? 'balanced' : 'fast';
    return {
        name: String(input.name || 'Action compilation').trim().slice(0, 100) || 'Action compilation',
        format,
        goal: oneOf(input.goal, ['fast_action', 'cosplay_showcase', 'cinematic'], 'fast_action'),
        targetDurationSec: Math.min(
            targetDefaults.max,
            Math.max(targetDefaults.min, Number.isFinite(target) ? target : targetDefaults.fallback),
        ),
        pacing: oneOf(input.pacing, ['rapid', 'fast', 'balanced', 'cinematic'], defaultPacing),
        transitionMode: oneOf(input.transitionMode ?? input.transition_mode, ['auto', 'minimal', 'none'], 'auto'),
        selectionMode: oneOf(input.selectionMode ?? input.selection_mode, ['best_moments', 'use_every_clip'], 'best_moments'),
        orderMode: oneOf(input.orderMode ?? input.order_mode, ['ai', 'manual'], 'ai'),
    };
}

function sanitizeCompilationSlug(value) {
    const slug = String(value || 'action-compilation')
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 80);
    return slug || 'action-compilation';
}

function normalizeCompilationFiles(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function validateCompilationFiles(value, format = 'vertical_short') {
    const files = normalizeCompilationFiles(value);
    const minimumFiles = format === 'horizontal_longform'
        ? MIN_HORIZONTAL_COMPILATION_FILES
        : MIN_COMPILATION_FILES;
    if (files.length < minimumFiles || files.length > MAX_COMPILATION_FILES) {
        return { files: [], error: `Choose ${minimumFiles} to ${MAX_COMPILATION_FILES} video clips` };
    }
    let totalBytes = 0;
    for (const file of files) {
        const size = Number(file?.size) || 0;
        const extension = path.extname(String(file?.name || '')).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(extension)) {
            return { files: [], error: `Unsupported video type: ${extension || 'unknown'}` };
        }
        if (size <= 0 || size > MAX_COMPILATION_FILE_BYTES) {
            return {
                files: [],
                error: `Each source clip must be between 1 byte and ${formatByteLimit(MAX_COMPILATION_FILE_BYTES)}`,
            };
        }
        totalBytes += size;
    }
    if (totalBytes > MAX_COMPILATION_TOTAL_BYTES) {
        return {
            files: [],
            error: `Compilation uploads are limited to ${formatByteLimit(MAX_COMPILATION_TOTAL_BYTES)} total`,
        };
    }
    return { files, totalBytes, error: null };
}

function compilationManifestSettings(options) {
    const normalized = normalizeCompilationOptions(options);
    const horizontal = normalized.format === 'horizontal_longform';
    return {
        format: normalized.format,
        goal: normalized.goal,
        target_duration_sec: normalized.targetDurationSec,
        pacing: normalized.pacing,
        transition_mode: normalized.transitionMode,
        selection_mode: normalized.selectionMode,
        order_mode: normalized.orderMode,
        output_width: horizontal ? 1920 : 1080,
        output_height: horizontal ? 1080 : 1920,
        fps: 30,
    };
}

module.exports = {
    MAX_COMPILATION_FILES,
    MAX_COMPILATION_FILE_BYTES,
    MAX_COMPILATION_TOTAL_BYTES,
    MIN_COMPILATION_FILES,
    MIN_HORIZONTAL_COMPILATION_FILES,
    VIDEO_EXTENSIONS,
    compilationManifestSettings,
    normalizeCompilationFiles,
    normalizeCompilationOptions,
    sanitizeCompilationSlug,
    validateCompilationFiles,
};
