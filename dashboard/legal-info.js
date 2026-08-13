'use strict';

const DEFAULT_SOURCE_URL = 'https://github.com/charlie12345/viral-clip-factory-pro/tree/main';

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
    };
}

module.exports = { DEFAULT_SOURCE_URL, legalInfo, sourceUrlFromEnvironment };
