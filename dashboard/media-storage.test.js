'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { assertConfiguredMediaMount } = require('./media-storage');

function directoryStats({ dev, symbolic = false }) {
    return {
        dev,
        isDirectory: () => true,
        isSymbolicLink: () => symbolic,
    };
}

test('allows an explicitly mounted media root on a distinct device', () => {
    const mountPath = path.resolve('vcf-media-mount');
    const mediaRoot = path.join(mountPath, 'viral-clip-factory');
    const resolved = assertConfiguredMediaMount({
        mediaRoot,
        mountPath,
        lstatSync: () => directoryStats({ dev: 20 }),
        statSync: (target) => directoryStats({ dev: target === mountPath ? 20 : 10 }),
    });
    assert.equal(resolved, mountPath);
});

test('rejects an absent mount that would write through to the parent filesystem', () => {
    assert.throws(
        () => assertConfiguredMediaMount({
            mediaRoot: '/mnt/media/viral-clip-factory',
            mountPath: '/mnt/media',
            lstatSync: () => directoryStats({ dev: 10 }),
            statSync: () => directoryStats({ dev: 10 }),
        }),
        /not mounted/,
    );
});

test('rejects a media root outside the required mount', () => {
    assert.throws(
        () => assertConfiguredMediaMount({
            mediaRoot: '/var/lib/viral-clip-factory',
            mountPath: '/mnt/media',
        }),
        /must be located on/,
    );
});

test('does nothing when no required mount is configured', () => {
    assert.equal(assertConfiguredMediaMount({ mediaRoot: '/tmp/media' }), null);
});
