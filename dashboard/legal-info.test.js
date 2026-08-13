'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_SOURCE_URL,
    ULTRALYTICS_SOURCE_URL,
    ULTRALYTICS_VERSION,
    legalInfo,
    sourceUrlFromEnvironment,
} = require('./legal-info');

test('uses the documented public source repository by default', () => {
    assert.deepEqual(legalInfo({}), {
        license: 'AGPL-3.0-only',
        sourceUrl: DEFAULT_SOURCE_URL,
        thirdPartySources: [{
            name: 'Ultralytics YOLO',
            version: ULTRALYTICS_VERSION,
            sourceUrl: ULTRALYTICS_SOURCE_URL,
        }],
    });
});

test('accepts a deployment-specific public source URL without tokens or fragments', () => {
    assert.equal(
        sourceUrlFromEnvironment({ VCF_SOURCE_URL: 'https://code.example.org/factory/tree/release?token=ignored#section' }),
        'https://code.example.org/factory/tree/release',
    );
});

test('rejects unsafe or credential-bearing source URLs', () => {
    assert.equal(sourceUrlFromEnvironment({ VCF_SOURCE_URL: 'javascript:alert(1)' }), DEFAULT_SOURCE_URL);
    assert.equal(sourceUrlFromEnvironment({ VCF_SOURCE_URL: 'https://token@code.example.org/factory' }), DEFAULT_SOURCE_URL);
});
