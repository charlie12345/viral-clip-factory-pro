'use strict';

const DEFAULT_SOURCE_URL = 'https://github.com/charlie12345/viral-clip-factory-pro/tree/main';
const ULTRALYTICS_VERSION = '8.4.91';
const ULTRALYTICS_SOURCE_URL = 'https://github.com/ultralytics/ultralytics/tree/8fc958ed38c4c4f8b58da9f5f4f24183aa2bbb96';

function sourceUrlFromEnvironment(environment = process.env) {
    const configured = String(environment.VCF_SOURCE_URL || '').trim();
    if (!configured) return DEFAULT_SOURCE_URL;

    try {
        const url = new URL(configured);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
            return DEFAULT_SOURCE_URL;
        }
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/$/, '');
    } catch (_) {
        return DEFAULT_SOURCE_URL;
    }
}

function legalInfo(environment = process.env) {
    return {
        license: 'AGPL-3.0-only',
        sourceUrl: sourceUrlFromEnvironment(environment),
        thirdPartySources: [{
            name: 'Ultralytics YOLO',
            version: ULTRALYTICS_VERSION,
            sourceUrl: ULTRALYTICS_SOURCE_URL,
        }],
    };
}

module.exports = {
    DEFAULT_SOURCE_URL,
    ULTRALYTICS_SOURCE_URL,
    ULTRALYTICS_VERSION,
    legalInfo,
    sourceUrlFromEnvironment,
};
