'use strict';

const fs = require('fs');
const path = require('path');

function safeRoot(rootPath) {
    const resolved = path.resolve(String(rootPath || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw new Error('Refusing to manage an unsafe storage root');
    }
    return resolved;
}

function summarizeEntry(entryPath) {
    let stat;
    try {
        stat = fs.lstatSync(entryPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return { bytes: 0, files: 0, directories: 0 };
        throw error;
    }
    if (stat.isSymbolicLink()) {
        return { bytes: stat.size, files: 1, directories: 0 };
    }
    if (!stat.isDirectory()) {
        return { bytes: stat.size, files: 1, directories: 0 };
    }
    const summary = { bytes: 0, files: 0, directories: 1 };
    for (const child of fs.readdirSync(entryPath)) {
        const childSummary = summarizeEntry(path.join(entryPath, child));
        summary.bytes += childSummary.bytes;
        summary.files += childSummary.files;
        summary.directories += childSummary.directories;
    }
    return summary;
}

function summarizeRoot(rootPath) {
    const root = safeRoot(rootPath);
    if (!fs.existsSync(root)) return { bytes: 0, files: 0, directories: 0 };
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Storage roots must be real directories');
    }
    const summary = { bytes: 0, files: 0, directories: 0 };
    for (const child of fs.readdirSync(root)) {
        const childSummary = summarizeEntry(path.join(root, child));
        summary.bytes += childSummary.bytes;
        summary.files += childSummary.files;
        summary.directories += childSummary.directories;
    }
    return summary;
}

function clearRoot(rootPath) {
    const root = safeRoot(rootPath);
    if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true });
        return;
    }
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Storage roots must be real directories');
    }
    for (const child of fs.readdirSync(root)) {
        fs.rmSync(path.join(root, child), { recursive: true, force: true });
    }
}

function combineSummaries(summaries) {
    return summaries.reduce((total, summary) => ({
        bytes: total.bytes + summary.bytes,
        files: total.files + summary.files,
        directories: total.directories + summary.directories,
    }), { bytes: 0, files: 0, directories: 0 });
}

function createStorageManager(definitions) {
    const categories = (Array.isArray(definitions) ? definitions : []).map((definition) => {
        const id = String(definition?.id || '').trim();
        if (!/^[a-z][a-z0-9_-]{1,48}$/.test(id)) throw new Error(`Invalid storage category: ${id || '(empty)'}`);
        const roots = [...new Set((definition.roots || []).map(safeRoot))];
        if (!roots.length) throw new Error(`Storage category ${id} has no roots`);
        return {
            id,
            label: String(definition.label || id),
            description: String(definition.description || ''),
            warning: String(definition.warning || ''),
            roots,
        };
    });
    const byId = new Map(categories.map((category) => [category.id, category]));
    if (byId.size !== categories.length) throw new Error('Storage category ids must be unique');

    const summarizeCategory = (category) => ({
        id: category.id,
        label: category.label,
        description: category.description,
        warning: category.warning,
        ...combineSummaries(category.roots.map(summarizeRoot)),
    });

    return {
        summarize() {
            const items = categories.map(summarizeCategory);
            return {
                categories: items,
                totals: combineSummaries(items),
                protected: [
                    'Source uploads and long-form source media',
                    'Finished clips, masters, deliveries, and review links',
                    'Project JSON, snapshots, imported media, and LUT libraries',
                ],
            };
        },
        cleanup(categoryIds) {
            const requested = [...new Set((Array.isArray(categoryIds) ? categoryIds : []).map((item) => String(item)))];
            if (!requested.length) throw new Error('Choose at least one storage category');
            const selected = requested.map((id) => {
                const category = byId.get(id);
                if (!category) throw new Error(`Unknown storage category: ${id}`);
                return category;
            });
            const beforeItems = selected.map(summarizeCategory);
            selected.forEach((category) => category.roots.forEach(clearRoot));
            const afterItems = selected.map(summarizeCategory);
            const before = combineSummaries(beforeItems);
            const after = combineSummaries(afterItems);
            return {
                categories: requested,
                before,
                after,
                freedBytes: Math.max(0, before.bytes - after.bytes),
            };
        },
    };
}

module.exports = {
    createStorageManager,
    summarizeRoot,
};
