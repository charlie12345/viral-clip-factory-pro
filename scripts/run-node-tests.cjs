#!/usr/bin/env node

// Explicitly enumerate the dashboard unit tests so npm runs them the same way
// in POSIX shells and in Windows PowerShell (which does not expand globs).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dashboardDirectory = path.join(root, 'dashboard');
const tests = fs
    .readdirSync(dashboardDirectory)
    .filter((file) => file.endsWith('.test.js'))
    .sort()
    .map((file) => path.join('dashboard', file));

if (tests.length === 0) {
    console.error('No dashboard Node unit tests were found.');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root,
    stdio: 'inherit',
});

if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}

process.exit(result.status ?? 1);
