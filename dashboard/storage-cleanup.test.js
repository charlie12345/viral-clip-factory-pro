'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStorageManager, summarizeRoot } = require('./storage-cleanup');

function temporaryRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-storage-cleanup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('summarizes nested regenerable files without following symbolic links', (t) => {
    const root = temporaryRoot(t);
    const cache = path.join(root, 'cache');
    const external = path.join(root, 'external');
    fs.mkdirSync(path.join(cache, 'nested'), { recursive: true });
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(cache, 'one.bin'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cache, 'nested', 'two.bin'), Buffer.alloc(20));
    fs.writeFileSync(path.join(external, 'protected.bin'), Buffer.alloc(100));
    fs.symlinkSync(external, path.join(cache, 'linked-external'));

    const summary = summarizeRoot(cache);

    assert.equal(summary.files, 3);
    assert.ok(summary.bytes >= 30);
    assert.ok(summary.bytes < 130);
});

test('cleans only selected allowlisted categories and preserves their roots', (t) => {
    const root = temporaryRoot(t);
    const temporary = path.join(root, 'temporary');
    const previews = path.join(root, 'previews');
    fs.mkdirSync(temporary);
    fs.mkdirSync(previews);
    fs.writeFileSync(path.join(temporary, 'large.bin'), Buffer.alloc(128));
    fs.writeFileSync(path.join(previews, 'thumb.jpg'), Buffer.alloc(64));
    const manager = createStorageManager([
        { id: 'temporary', label: 'Temporary', roots: [temporary] },
        { id: 'previews', label: 'Previews', roots: [previews] },
    ]);

    const result = manager.cleanup(['temporary']);

    assert.equal(result.freedBytes, 128);
    assert.equal(fs.existsSync(temporary), true);
    assert.deepEqual(fs.readdirSync(temporary), []);
    assert.equal(fs.existsSync(path.join(previews, 'thumb.jpg')), true);
});

test('deleting a child symbolic link never deletes its target', (t) => {
    const root = temporaryRoot(t);
    const cache = path.join(root, 'cache');
    const external = path.join(root, 'external');
    fs.mkdirSync(cache);
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'protected');
    fs.symlinkSync(external, path.join(cache, 'link'));
    const manager = createStorageManager([{ id: 'cache', roots: [cache] }]);

    manager.cleanup(['cache']);

    assert.equal(fs.existsSync(path.join(cache, 'link')), false);
    assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'protected');
});

test('rejects unknown categories and symbolic-link roots', (t) => {
    const root = temporaryRoot(t);
    const real = path.join(root, 'real');
    const linked = path.join(root, 'linked');
    fs.mkdirSync(real);
    fs.symlinkSync(real, linked);
    const manager = createStorageManager([{ id: 'cache', roots: [real] }]);

    assert.throws(() => manager.cleanup(['unknown']), /Unknown storage category/);
    assert.throws(() => summarizeRoot(linked), /real directories/);
});

test('admin routes require an explicit confirmation and refuse cleanup while work is active', () => {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const start = server.indexOf("app.get('/api/admin/storage'");
    const end = server.indexOf('// Provider credentials', start);
    const routes = server.slice(start, end);

    assert.match(routes, /DELETE_REGENERABLE_FILES/);
    assert.match(routes, /storageCleanupBusyReason\(\)/);
    assert.match(routes, /storageManager\.cleanup\(req\.body\?\.categories\)/);
});
