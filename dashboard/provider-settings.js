'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROVIDER_ENV_FIELDS = Object.freeze({
    deepgramApiKey: 'DEEPGRAM_API_KEY',
    geminiApiKey: 'GEMINI_API_KEY',
    localLlmUrl: 'VCF_LOCAL_LLM_URL',
    localLlmModel: 'VCF_LOCAL_LLM_MODEL',
    localLlmApiKey: 'VCF_LOCAL_LLM_API_KEY',
});

const SECRET_FIELDS = Object.freeze([
    'deepgramApiKey',
    'geminiApiKey',
    'localLlmApiKey',
]);

const CLEAR_FIELDS = Object.freeze({
    clearDeepgramApiKey: 'deepgramApiKey',
    clearGeminiApiKey: 'geminiApiKey',
    clearLocalLlmApiKey: 'localLlmApiKey',
});

const NON_SECRET_FIELDS = Object.freeze([
    'localLlmUrl',
    'localLlmModel',
]);

const ALLOWED_REQUEST_FIELDS = new Set([
    ...SECRET_FIELDS,
    ...NON_SECRET_FIELDS,
    ...Object.keys(CLEAR_FIELDS),
]);

const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_MODEL_LENGTH = 256;
const MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES = 64 * 1024;

class ProviderSettingsValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProviderSettingsValidationError';
    }
}

class ProviderSettingsReadError extends Error {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'ProviderSettingsReadError';
    }
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function cleanStoredString(value, maxLength) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maxLength || /[\u0000\r\n]/.test(cleaned)) return null;
    return cleaned;
}

function normalizeSavedProviderSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const normalized = {};

    for (const field of SECRET_FIELDS) {
        const value = cleanStoredString(input[field], MAX_SECRET_LENGTH);
        if (value) normalized[field] = value;
    }

    const url = cleanStoredString(input.localLlmUrl, MAX_URL_LENGTH);
    if (url) {
        try {
            const parsed = new URL(url);
            if (
                (parsed.protocol === 'http:' || parsed.protocol === 'https:')
                && parsed.hostname
                && !parsed.username
                && !parsed.password
                && !parsed.search
                && !parsed.hash
            ) {
                normalized.localLlmUrl = url;
            }
        } catch (_) {}
    }

    const model = cleanStoredString(input.localLlmModel, MAX_MODEL_LENGTH);
    if (model) normalized.localLlmModel = model;

    return normalized;
}

function captureBootstrapProviderEnvironment(environment = process.env) {
    const captured = {};
    for (const envName of Object.values(PROVIDER_ENV_FIELDS)) {
        const value = environment?.[envName];
        if (typeof value === 'string' && value.trim()) captured[envName] = value.trim();
    }
    return captured;
}

function parseStoredProviderSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ProviderSettingsReadError('Provider settings file is invalid');
    }

    for (const key of Object.keys(input)) {
        if (![...SECRET_FIELDS, ...NON_SECRET_FIELDS].includes(key)) {
            throw new ProviderSettingsReadError('Provider settings file is invalid');
        }
    }

    for (const field of SECRET_FIELDS) {
        if (!hasOwn(input, field)) continue;
        const value = cleanStoredString(input[field], MAX_SECRET_LENGTH);
        if (!value) throw new ProviderSettingsReadError('Provider settings file is invalid');
    }

    if (hasOwn(input, 'localLlmUrl')) {
        try {
            if (!validateLocalLlmUrl(input.localLlmUrl)) {
                throw new ProviderSettingsReadError('Provider settings file is invalid');
            }
        } catch (error) {
            if (error instanceof ProviderSettingsReadError) throw error;
            throw new ProviderSettingsReadError('Provider settings file is invalid', { cause: error });
        }
    }

    if (hasOwn(input, 'localLlmModel')) {
        try {
            if (!validateLocalLlmModel(input.localLlmModel)) {
                throw new ProviderSettingsReadError('Provider settings file is invalid');
            }
        } catch (error) {
            if (error instanceof ProviderSettingsReadError) throw error;
            throw new ProviderSettingsReadError('Provider settings file is invalid', { cause: error });
        }
    }

    return normalizeSavedProviderSettings(input);
}

function readProviderSettings(filePath) {
    let serialized;
    try {
        serialized = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return {};
        throw new ProviderSettingsReadError('Unable to read provider settings file', { cause: error });
    }

    let parsed;
    try {
        parsed = JSON.parse(serialized);
    } catch (error) {
        throw new ProviderSettingsReadError('Provider settings file is invalid', { cause: error });
    }

    const normalized = parseStoredProviderSettings(parsed);
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        throw new ProviderSettingsReadError('Unable to secure provider settings file', { cause: error });
    }
    return normalized;
}

function writeProviderSettingsAtomic(filePath, settings) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies when creating a directory. Harden an existing
    // runtime directory before placing a credential-bearing temporary file in it.
    fs.chmodSync(directory, 0o700);

    const normalized = normalizeSavedProviderSettings(settings);
    const temporaryPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );

    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, 0o600);
    } catch (error) {
        try { fs.unlinkSync(temporaryPath); } catch (_) {}
        throw error;
    }

    return normalized;
}

function requireRequestObject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ProviderSettingsValidationError('Provider settings must be a JSON object');
    }
    for (const key of Object.keys(input)) {
        if (!ALLOWED_REQUEST_FIELDS.has(key)) {
            throw new ProviderSettingsValidationError('Request contains an unsupported provider setting');
        }
    }
}

function validateSecretField(field, value) {
    if (typeof value !== 'string') {
        throw new ProviderSettingsValidationError(`${field} must be a string`);
    }
    const cleaned = value.trim();
    if (cleaned.length > MAX_SECRET_LENGTH) {
        throw new ProviderSettingsValidationError(`${field} is too long`);
    }
    if (/[\u0000\r\n]/.test(cleaned)) {
        throw new ProviderSettingsValidationError(`${field} must be a single-line value`);
    }
    return cleaned;
}

function validateLocalLlmUrl(value) {
    if (typeof value !== 'string') {
        throw new ProviderSettingsValidationError('localLlmUrl must be a string');
    }
    const cleaned = value.trim();
    if (!cleaned) return '';
    if (cleaned.length > MAX_URL_LENGTH || /[\u0000\r\n]/.test(cleaned)) {
        throw new ProviderSettingsValidationError('localLlmUrl is invalid or too long');
    }

    let parsed;
    try {
        parsed = new URL(cleaned);
    } catch (_) {
        throw new ProviderSettingsValidationError('localLlmUrl must be a valid http(s) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new ProviderSettingsValidationError('localLlmUrl must be a valid http(s) URL');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new ProviderSettingsValidationError('localLlmUrl must not contain credentials, query parameters, or fragments');
    }
    return cleaned;
}

function validateLocalLlmModel(value) {
    if (typeof value !== 'string') {
        throw new ProviderSettingsValidationError('localLlmModel must be a string');
    }
    const cleaned = value.trim();
    if (!cleaned) return '';
    if (cleaned.length > MAX_MODEL_LENGTH || /[\u0000\r\n]/.test(cleaned)) {
        throw new ProviderSettingsValidationError('localLlmModel is invalid or too long');
    }
    return cleaned;
}

function providerUrlOrigin(value) {
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

function updateProviderSettings(current, request, bootstrapEnvironment = {}) {
    requireRequestObject(request);
    const normalizedCurrent = normalizeSavedProviderSettings(current);
    const next = { ...normalizedCurrent };

    for (const [clearField, targetField] of Object.entries(CLEAR_FIELDS)) {
        if (hasOwn(request, clearField) && typeof request[clearField] !== 'boolean') {
            throw new ProviderSettingsValidationError(`${clearField} must be a boolean`);
        }
        if (request[clearField] === true) delete next[targetField];
    }

    for (const field of SECRET_FIELDS) {
        if (!hasOwn(request, field)) continue;
        const cleaned = validateSecretField(field, request[field]);
        const clearField = Object.keys(CLEAR_FIELDS).find((key) => CLEAR_FIELDS[key] === field);
        if (cleaned && request[clearField] === true) {
            throw new ProviderSettingsValidationError(`${field} cannot be replaced and cleared together`);
        }
        // An empty secret is deliberately a no-op. This lets the UI submit an
        // untouched password field without erasing the saved credential.
        if (cleaned) next[field] = cleaned;
    }

    if (hasOwn(request, 'localLlmUrl')) {
        const value = validateLocalLlmUrl(request.localLlmUrl);
        if (value) next.localLlmUrl = value;
        else delete next.localLlmUrl;
    }

    if (hasOwn(request, 'localLlmModel')) {
        const value = validateLocalLlmModel(request.localLlmModel);
        if (value) next.localLlmModel = value;
        else delete next.localLlmModel;
    }

    const currentUrl = effectiveField(normalizedCurrent, bootstrapEnvironment, 'localLlmUrl');
    const nextUrl = effectiveField(next, bootstrapEnvironment, 'localLlmUrl');
    const currentApiKey = effectiveField(normalizedCurrent, bootstrapEnvironment, 'localLlmApiKey');
    const nextApiKey = effectiveField(next, bootstrapEnvironment, 'localLlmApiKey');
    const localOriginChanged = providerUrlOrigin(currentUrl.value) !== providerUrlOrigin(nextUrl.value);

    if (localOriginChanged && currentApiKey.value) {
        const replacement = hasOwn(request, 'localLlmApiKey')
            ? validateSecretField('localLlmApiKey', request.localLlmApiKey)
            : '';
        const safelyCleared = request.clearLocalLlmApiKey === true && !nextApiKey.value;
        if (!replacement && !safelyCleared) {
            throw new ProviderSettingsValidationError(
                'Changing the local endpoint origin requires replacing or fully clearing its API key',
            );
        }
    }

    return next;
}

function providerSettingsPayloadTooLarge(body, contentLength) {
    const declaredLength = Number.parseInt(String(contentLength ?? ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES) {
        return true;
    }

    try {
        return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8') > MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES;
    } catch (_) {
        return true;
    }
}

function effectiveField(saved, bootstrapEnvironment, field) {
    const envName = PROVIDER_ENV_FIELDS[field];
    if (hasOwn(saved, field) && saved[field]) {
        return { value: saved[field], source: 'saved' };
    }
    const environmentValue = bootstrapEnvironment?.[envName];
    if (typeof environmentValue === 'string' && environmentValue.trim()) {
        return { value: environmentValue.trim(), source: 'environment' };
    }
    return { value: '', source: 'none' };
}

function applyProviderEnvironment(savedInput, bootstrapEnvironment, targetEnvironment = process.env) {
    const saved = normalizeSavedProviderSettings(savedInput);
    for (const field of Object.keys(PROVIDER_ENV_FIELDS)) {
        const envName = PROVIDER_ENV_FIELDS[field];
        const effective = effectiveField(saved, bootstrapEnvironment, field);
        if (effective.value) targetEnvironment[envName] = effective.value;
        else delete targetEnvironment[envName];
    }
    return targetEnvironment;
}

function localUrlForStatus(value) {
    if (!value) return '';
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
        if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return value;
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return '';
    }
}

function providerSettingsStatus(savedInput, bootstrapEnvironment) {
    const saved = normalizeSavedProviderSettings(savedInput);
    const deepgram = effectiveField(saved, bootstrapEnvironment, 'deepgramApiKey');
    const gemini = effectiveField(saved, bootstrapEnvironment, 'geminiApiKey');
    const localUrl = effectiveField(saved, bootstrapEnvironment, 'localLlmUrl');
    const localModel = effectiveField(saved, bootstrapEnvironment, 'localLlmModel');
    const localApiKey = effectiveField(saved, bootstrapEnvironment, 'localLlmApiKey');

    return {
        deepgram: {
            configured: Boolean(deepgram.value),
            source: deepgram.source,
        },
        gemini: {
            configured: Boolean(gemini.value),
            source: gemini.source,
        },
        localSemantic: {
            url: localUrlForStatus(localUrl.value),
            model: localModel.value,
            apiKeyConfigured: Boolean(localApiKey.value),
            apiKeySource: localApiKey.source,
        },
    };
}

module.exports = {
    MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES,
    ProviderSettingsReadError,
    ProviderSettingsValidationError,
    PROVIDER_ENV_FIELDS,
    applyProviderEnvironment,
    captureBootstrapProviderEnvironment,
    normalizeSavedProviderSettings,
    providerSettingsStatus,
    providerSettingsPayloadTooLarge,
    readProviderSettings,
    updateProviderSettings,
    validateLocalLlmUrl,
    writeProviderSettingsAtomic,
};
