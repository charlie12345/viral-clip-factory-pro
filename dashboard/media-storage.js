'use strict';

const fs = require('fs');
const path = require('path');

function assertConfiguredMediaMount({
    mediaRoot,
    mountPath,
    lstatSync = fs.lstatSync,
    statSync = fs.statSync,
} = {}) {
    const configuredMount = String(mountPath || '').trim();
    if (!configuredMount) return null;

    const resolvedMount = path.resolve(configuredMount);
    const resolvedMediaRoot = path.resolve(String(mediaRoot || ''));
    if (
        !mediaRoot
        || (resolvedMediaRoot !== resolvedMount
            && !resolvedMediaRoot.startsWith(`${resolvedMount}${path.sep}`))
    ) {
        throw new Error('VCF_MEDIA_ROOT must be located on VCF_MEDIA_MOUNT');
    }
    if (resolvedMount === path.parse(resolvedMount).root) {
        throw new Error('VCF_MEDIA_MOUNT must not be the filesystem root');
    }

    let mountStats;
    let parentStats;
    try {
        const mountLinkStats = lstatSync(resolvedMount);
        if (!mountLinkStats.isDirectory() || mountLinkStats.isSymbolicLink()) {
            throw new Error('the configured path is not a real directory');
        }
        mountStats = statSync(resolvedMount);
        parentStats = statSync(path.dirname(resolvedMount));
    } catch (error) {
        throw new Error(`Configured media mount is unavailable at ${resolvedMount}: ${error.message}`);
    }

    if (String(mountStats.dev) === String(parentStats.dev)) {
        throw new Error(`Configured media mount is not mounted at ${resolvedMount}`);
    }
    return resolvedMount;
}

module.exports = { assertConfiguredMediaMount };
