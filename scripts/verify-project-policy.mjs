#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXPECTED_REPOSITORY = 'https://github.com/yaakovch/agent-fleet';
const FULL_COMMIT = /^[a-f0-9]{40}$/u;
const IMMUTABLE_CONTAINER = /^docker:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function read(root, path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) fail(`${path} is missing`);
  return readFileSync(absolute, 'utf8');
}

function sameRecord(left, right) {
  const ordered = (value) => Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

export function validateWorkflowActionPins(source, label = 'workflow') {
  let count = 0;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!/^\s*(?:-\s*)?uses:/u.test(line)) continue;
    const match = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^"'#\s]+)["']?(?:\s+#.*)?$/u);
    if (!match) fail(`${label}:${index + 1} action reference cannot be parsed safely`);
    count += 1;
    const value = match[1];
    if (value.startsWith('./')) continue;
    if (value.startsWith('docker://')) {
      if (!IMMUTABLE_CONTAINER.test(value)) {
        fail(`${label}:${index + 1} container action must use an immutable sha256 digest: ${value}`);
      }
      continue;
    }
    const separator = value.lastIndexOf('@');
    if (separator < 1 || !FULL_COMMIT.test(value.slice(separator + 1))) {
      fail(`${label}:${index + 1} action must use a full 40-character commit SHA: ${value}`);
    }
  }
  return count;
}

function workflowFiles(root) {
  const directory = join(root, '.github', 'workflows');
  if (!existsSync(directory) || !statSync(directory).isDirectory()) fail('.github/workflows is missing');
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => join('.github', 'workflows', name));
}

function verifyPackageMetadata(root) {
  const packageJson = JSON.parse(read(root, 'package.json'));
  const lock = JSON.parse(read(root, 'package-lock.json'));
  const lockRoot = lock.packages?.[''];

  if (packageJson.name !== 'agent-fleet'
    || typeof packageJson.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)
    || packageJson.description !== 'Windows tray dashboard for local AI coding sessions, schedules, hosts, and usage limits.'
    || packageJson.main !== 'out/main/index.js'
    || packageJson.type !== 'module'
    || packageJson.license !== 'MIT'
    || packageJson.author !== 'Yaakov Chen Zion'
    || packageJson.repository !== EXPECTED_REPOSITORY
    || packageJson.homepage !== EXPECTED_REPOSITORY) {
    fail('package.json identity, ownership, or MIT license metadata is invalid');
  }
  if (lock.lockfileVersion !== 3 || !lockRoot
    || lockRoot.name !== packageJson.name
    || lockRoot.version !== packageJson.version
    || lockRoot.license !== packageJson.license
    || !sameRecord(lockRoot.dependencies, packageJson.dependencies)
    || !sameRecord(lockRoot.devDependencies, packageJson.devDependencies)) {
    fail('package-lock.json root metadata does not match package.json');
  }

  const expectedScripts = {
    quality: 'node scripts/quality-gate.mjs',
    'verify:policy': 'node scripts/verify-project-policy.mjs',
    'verify:runtime': 'node scripts/verify-embedded-runtime.mjs',
    'audit:runtime': 'npm audit --omit=dev --audit-level=high',
    'audit:critical': 'npm audit --audit-level=critical',
    'audit:release': 'npm audit --audit-level=high',
    'build:production': 'electron-vite build',
    sbom: 'cyclonedx-npm --package-lock-only --output-reproducible --validate --output-file dist/bom.json --spec-version 1.6',
    'package:built': 'electron-builder --win nsis portable --x64 --publish never',
    'package:dir:built': 'electron-builder --win dir --x64 --publish never'
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    if (packageJson.scripts?.[name] !== command) fail(`package.json script ${name} must be ${JSON.stringify(command)}`);
  }
}

function verifyLicense(root) {
  const license = read(root, 'LICENSE').replace(/\r\n/gu, '\n').trim();
  const required = [
    'MIT License',
    'Copyright (c) 2026 Yaakov Chen Zion',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'The above copyright notice and this permission notice shall be included in all',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR'
  ];
  for (const phrase of required) {
    if (!license.includes(phrase)) fail(`LICENSE is not the expected MIT grant: missing ${JSON.stringify(phrase)}`);
  }

  const builder = read(root, 'electron-builder.yml');
  const builderRequirements = [
    /^appId: com\.yaakovch\.ailimitswidget$/mu,
    /^productName: Agent Fleet$/mu,
    /^copyright: Copyright © 2026 Yaakov Chen Zion$/mu,
    /^files:\r?\n(?: {2}- .*\r?\n)* {2}- LICENSE$/mu
  ];
  for (const pattern of builderRequirements) {
    if (!pattern.test(builder)) fail(`electron-builder.yml is missing required package metadata: ${pattern}`);
  }
}

function verifyHashBoundLineEndings(root) {
  const attributes = read(root, '.gitattributes');
  const required = [
    'tests/fixtures/** text eol=lf',
    'resources/runtime/*.json text eol=lf',
    'resources/runtime/*.pem text eol=lf',
    '*.mjs text eol=lf'
  ];
  for (const rule of required) {
    if (!attributes.split(/\r?\n/u).includes(rule)) {
      fail(`.gitattributes is missing hash-bound LF policy: ${rule}`);
    }
  }
}

function verifyCiEntryPoints(root) {
  const ci = read(root, join('.github', 'workflows', 'ci.yml'));
  const release = read(root, join('.github', 'workflows', 'release.yml'));
  const exactQualityRun = /^\s*-\s+run:\s+npm run quality\s*$/gmu;
  if ([...ci.matchAll(exactQualityRun)].length !== 1) {
    fail('CI must invoke the canonical npm run quality gate exactly once');
  }
  if ([...release.matchAll(exactQualityRun)].length !== 1
    || !/^\s*run:\s+npm run audit:release\s*$/mu.test(release)) {
    fail('the signed release workflow must run quality and the complete dependency audit');
  }
  if (!/^\s{2}wsl-runtime-security:\s*$/mu.test(ci)
    || !/^\s*-\s+run:\s+npx vitest run tests\/wslRuntimeManager\.test\.ts\s*$/mu.test(ci)) {
    fail('CI must exercise the POSIX-only WSL installer security program on Linux');
  }
  const releaseRequirements = [
    /^\s{2}workflow_dispatch:\s*$/mu,
    /^\s{6}release_tag:\s*$/mu,
    /^\s{2}contents:\s*read\s*$/mu,
    /^\s{2}publish-draft:\s*$/mu,
    /^\s{4}if:\s*github\.event_name == 'push'\s*$/mu,
    /^\s{6}contents:\s*write\s*$/mu,
    /Upload signed release bundle/u,
    /A signed release candidate must use the exact pushed main commit\./u,
    /Missing release-environment secrets:/u
  ];
  for (const pattern of releaseRequirements) {
    if (!pattern.test(release)) fail('the signed release workflow is missing release-candidate policy: ' + pattern);
  }
}

export function verifyRepositoryPolicy(root) {
  verifyPackageMetadata(root);
  verifyLicense(root);
  verifyHashBoundLineEndings(root);
  verifyCiEntryPoints(root);

  const workflows = workflowFiles(root);
  let actions = 0;
  for (const path of workflows) actions += validateWorkflowActionPins(read(root, path), path);
  if (actions < 1) fail('no workflow actions were inspected');
  return { workflows: workflows.length, actions };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    console.log(JSON.stringify(verifyRepositoryPolicy(repository)));
  } catch (error) {
    console.error(`verify-project-policy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
