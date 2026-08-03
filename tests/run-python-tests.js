#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const candidates = [
    process.env.VCF_PYTHON_PATH,
    process.platform === 'win32'
        ? path.join(root, 'venv', 'Scripts', 'python.exe')
        : path.join(root, 'venv', 'bin', 'python'),
    process.platform === 'win32' ? 'python' : 'python3',
].filter(Boolean);

function isRunnable(executable) {
    if (path.isAbsolute(executable) && !fs.existsSync(executable)) return false;
    const probe = spawnSync(executable, ['-c', 'import sys'], { cwd: root, stdio: 'ignore' });
    return probe.status === 0;
}

const python = candidates.find(isRunnable);
if (!python) {
    console.error('No runnable Python interpreter was found for the test suite.');
    process.exit(1);
}

console.log(`Python test interpreter: ${python}`);
const result = spawnSync(
    python,
    ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
    { cwd: root, stdio: 'inherit' },
);
if (result.error) {
    console.error(result.error.message);
    process.exit(1);
}
process.exit(result.status ?? 1);
