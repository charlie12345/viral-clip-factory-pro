'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    validateLocalLlmUrl,
    writeProviderSettingsAtomic,
} = require('./provider-settings');

test('provider status reports configuration and source without leaking secrets', () => {
    const bootstrap = captureBootstrapProviderEnvironment({
        DEEPGRAM_API_KEY: 'environment-deepgram-secret',
        VCF_LOCAL_LLM_URL: 'http://127.0.0.1:8080',
        VCF_LOCAL_LLM_MODEL: 'environment-model',
    });
    const saved = {
        geminiApiKey: 'saved-gemini-secret',
        localLlmApiKey: 'saved-local-secret',
    };

    const status = providerSettingsStatus(saved, bootstrap);
    assert.deepEqual(status.deepgram, { configured: true, source: 'environment' });
    assert.deepEqual(status.gemini, { configured: true, source: 'saved' });
    assert.deepEqual(status.localSemantic, {
        url: 'http://127.0.0.1:8080',
        model: 'environment-model',
        apiKeyConfigured: true,
        apiKeySource: 'saved',
    });

    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes('environment-deepgram-secret'), false);
    assert.equal(serialized.includes('saved-gemini-secret'), false);
    assert.equal(serialized.includes('saved-local-secret'), false);
    assert.equal(serialized.toLowerCase().includes('hint'), false);
});

test('provider status strips credentials and query tokens from bootstrap endpoint URLs', () => {
    const bootstrap = captureBootstrapProviderEnvironment({
        VCF_LOCAL_LLM_URL: 'http://endpoint-user:endpoint-secret@localhost:8080/v1?token=query-secret#fragment',
        VCF_LOCAL_LLM_MODEL: 'local-model',
    });
    const serialized = JSON.stringify(providerSettingsStatus({}, bootstrap));

    assert.equal(serialized.includes('endpoint-user'), false);
    assert.equal(serialized.includes('endpoint-secret'), false);
    assert.equal(serialized.includes('query-secret'), false);
    assert.equal(JSON.parse(serialized).localSemantic.url, 'http://localhost:8080/v1');
});

test('blank secret fields keep the existing saved credentials', () => {
    const current = {
        deepgramApiKey: 'deepgram-existing',
        geminiApiKey: 'gemini-existing',
        localLlmApiKey: 'local-existing',
    };
    const next = updateProviderSettings(current, {
        deepgramApiKey: '',
        geminiApiKey: '   ',
        localLlmApiKey: '',
    });
    assert.deepEqual(next, current);
});

test('explicit secret clear removes the saved override and restores bootstrap environment', () => {
    const current = {
        deepgramApiKey: 'saved-deepgram',
        geminiApiKey: 'saved-gemini',
        localLlmApiKey: 'saved-local',
    };
    const bootstrap = captureBootstrapProviderEnvironment({
        DEEPGRAM_API_KEY: 'env-deepgram',
        GEMINI_API_KEY: 'env-gemini',
    });
    const next = updateProviderSettings(current, {
        clearDeepgramApiKey: true,
        clearGeminiApiKey: true,
        clearLocalLlmApiKey: true,
    });

    assert.deepEqual(next, {});
    const target = {
        DEEPGRAM_API_KEY: 'stale-saved-value',
        GEMINI_API_KEY: 'stale-saved-value',
        VCF_LOCAL_LLM_API_KEY: 'stale-saved-value',
    };
    applyProviderEnvironment(next, bootstrap, target);
    assert.equal(target.DEEPGRAM_API_KEY, 'env-deepgram');
    assert.equal(target.GEMINI_API_KEY, 'env-gemini');
    assert.equal('VCF_LOCAL_LLM_API_KEY' in target, false);
});

test('blank local URL and model clear saved values and fall back to bootstrap environment', () => {
    const next = updateProviderSettings({
        localLlmUrl: 'http://192.168.1.10:8080/v1',
        localLlmModel: 'saved-model',
    }, {
        localLlmUrl: '',
        localLlmModel: '   ',
    });
    const bootstrap = captureBootstrapProviderEnvironment({
        VCF_LOCAL_LLM_URL: 'http://localhost:11434',
        VCF_LOCAL_LLM_MODEL: 'bootstrap-model',
    });
    const target = {};
    applyProviderEnvironment(next, bootstrap, target);

    assert.deepEqual(next, {});
    assert.equal(target.VCF_LOCAL_LLM_URL, 'http://localhost:11434');
    assert.equal(target.VCF_LOCAL_LLM_MODEL, 'bootstrap-model');
    assert.deepEqual(providerSettingsStatus(next, bootstrap).localSemantic, {
        url: 'http://localhost:11434',
        model: 'bootstrap-model',
        apiKeyConfigured: false,
        apiKeySource: 'none',
    });
});

test('atomic persistence writes normalized JSON with owner-only permissions', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-provider-settings-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'runtime', 'provider-settings.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(filePath), 0o755);
    const saved = writeProviderSettingsAtomic(filePath, {
        deepgramApiKey: 'deepgram-secret',
        localLlmUrl: 'http://127.0.0.1:8080/v1/chat/completions',
        localLlmModel: 'qwen-local',
        ignored: 'not-persisted',
    });

    assert.deepEqual(readProviderSettings(filePath), saved);
    // Windows uses ACLs instead of POSIX mode bits, which Node does not
    // expose through stat(). The creation/chmod requests are still exercised.
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
    }
    assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith('.tmp')), false);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(filePath, 'utf8'))).sort(), [
        'deepgramApiKey',
        'localLlmModel',
        'localLlmUrl',
    ]);
});

test('read distinguishes a missing file from corrupt provider settings', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-provider-settings-read-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'provider-settings.json');

    assert.deepEqual(readProviderSettings(filePath), {});
    fs.writeFileSync(filePath, '{"geminiApiKey":', { mode: 0o600 });
    assert.throws(() => readProviderSettings(filePath), ProviderSettingsReadError);

    fs.writeFileSync(filePath, JSON.stringify({ geminiApiKey: 42 }), { mode: 0o600 });
    assert.throws(() => readProviderSettings(filePath), ProviderSettingsReadError);
});

test('read wraps unreadable provider settings without exposing the underlying error', () => {
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (filePath, ...args) => {
        if (filePath === '/unreadable/provider-settings.json') {
            const error = new Error('permission denied for secret-bearing path');
            error.code = 'EACCES';
            throw error;
        }
        return originalReadFileSync(filePath, ...args);
    };

    try {
        assert.throws(
            () => readProviderSettings('/unreadable/provider-settings.json'),
            (error) => error instanceof ProviderSettingsReadError
                && error.message === 'Unable to read provider settings file'
                && !error.message.includes('secret-bearing'),
        );
    } finally {
        fs.readFileSync = originalReadFileSync;
    }
});

test('changing local endpoint origin requires an explicit replacement for a saved key', () => {
    const current = {
        localLlmUrl: 'http://localhost:8080/v1/chat/completions',
        localLlmApiKey: 'saved-key',
    };

    assert.deepEqual(updateProviderSettings(current, {
        localLlmUrl: 'http://localhost:8080/v1/responses',
    }), {
        localLlmUrl: 'http://localhost:8080/v1/responses',
        localLlmApiKey: 'saved-key',
    });
    assert.throws(() => updateProviderSettings(current, {
        localLlmUrl: 'http://192.168.1.20:8080/v1',
    }), /requires replacing or fully clearing/);
    assert.deepEqual(updateProviderSettings(current, {
        localLlmUrl: 'http://192.168.1.20:8080/v1',
        localLlmApiKey: 'replacement-key',
    }), {
        localLlmUrl: 'http://192.168.1.20:8080/v1',
        localLlmApiKey: 'replacement-key',
    });
    assert.deepEqual(updateProviderSettings(current, {
        localLlmUrl: 'http://192.168.1.20:8080/v1',
        clearLocalLlmApiKey: true,
    }), {
        localLlmUrl: 'http://192.168.1.20:8080/v1',
    });
});

test('changing endpoint cannot reveal an environment key through an explicit clear', () => {
    const bootstrap = captureBootstrapProviderEnvironment({
        VCF_LOCAL_LLM_URL: 'http://localhost:8080/v1',
        VCF_LOCAL_LLM_API_KEY: 'environment-key',
    });

    assert.throws(() => updateProviderSettings({}, {
        localLlmUrl: 'http://192.168.1.30:8080/v1',
    }, bootstrap), /requires replacing or fully clearing/);
    assert.throws(() => updateProviderSettings({ localLlmApiKey: 'saved-key' }, {
        localLlmUrl: 'http://192.168.1.30:8080/v1',
        clearLocalLlmApiKey: true,
    }, bootstrap), /requires replacing or fully clearing/);
    assert.deepEqual(updateProviderSettings({}, {
        localLlmUrl: 'http://192.168.1.30:8080/v1',
        localLlmApiKey: 'new-endpoint-key',
    }, bootstrap), {
        localLlmUrl: 'http://192.168.1.30:8080/v1',
        localLlmApiKey: 'new-endpoint-key',
    });
});

test('provider payload limit checks both declared and parsed body sizes', () => {
    const oversizedValue = 'x'.repeat(MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES);
    assert.equal(providerSettingsPayloadTooLarge({}, MAX_PROVIDER_SETTINGS_PAYLOAD_BYTES + 1), true);
    assert.equal(providerSettingsPayloadTooLarge({ geminiApiKey: oversizedValue }, undefined), true);
    assert.equal(providerSettingsPayloadTooLarge({ geminiApiKey: 'short' }, 32), false);
});

test('validation accepts localhost and LAN http(s) endpoints', () => {
    for (const value of [
        'http://localhost:11434',
        'http://127.0.0.1:8080/v1/chat/completions',
        'http://192.168.1.20:1234/v1',
        'http://127.0.0.1:8080',
        'https://llm.internal.example/v1',
    ]) {
        assert.equal(validateLocalLlmUrl(value), value);
    }
});

test('validation rejects invalid types, unsafe URL schemes, and conflicting clear requests', () => {
    assert.throws(
        () => updateProviderSettings({}, { deepgramApiKey: 123 }),
        ProviderSettingsValidationError,
    );
    assert.throws(
        () => updateProviderSettings({}, { localLlmUrl: 'file:///tmp/socket' }),
        /http\(s\) URL/,
    );
    assert.throws(
        () => updateProviderSettings({}, { localLlmUrl: 'http://user:secret@localhost:8080/v1' }),
        /must not contain credentials/,
    );
    assert.throws(
        () => updateProviderSettings({}, { localLlmUrl: 'http://localhost:8080/v1?token=secret' }),
        /must not contain credentials/,
    );
    assert.throws(
        () => updateProviderSettings({}, { geminiApiKey: 'replacement', clearGeminiApiKey: true }),
        /cannot be replaced and cleared together/,
    );
    assert.throws(
        () => updateProviderSettings({}, { clearDeepgramApiKey: 'true' }),
        /must be a boolean/,
    );
    assert.throws(
        () => updateProviderSettings({}, { surpriseCredential: 'secret' }),
        /unsupported provider setting/,
    );
});
