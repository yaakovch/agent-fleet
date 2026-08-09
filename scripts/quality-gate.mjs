#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const npm = process.env.npm_execpath
  ? [process.execPath, [process.env.npm_execpath]]
  : [process.platform === 'win32' ? 'npm.cmd' : 'npm', []];
const steps = [
  ['project, license, and workflow policy', ['run', 'verify:policy']],
  ['embedded WSL runtime', ['run', 'verify:runtime']],
  ['shipped dependency audit', ['run', 'audit:runtime']],
  ['complete critical dependency audit', ['run', 'audit:critical']],
  ['TypeScript typecheck', ['run', 'lint']],
  ['complete test suite', ['test']],
  ['production application build', ['run', 'build:production']]
];

for (const [label, args] of steps) {
  console.log(`\n[quality] ${label}`);
  const result = spawnSync(npm[0], [...npm[1], ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CI: process.env.CI || '1' },
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(`[quality] could not run ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[quality] ${label} failed with exit code ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[quality] all source-quality checks passed');
