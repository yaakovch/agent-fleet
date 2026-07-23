#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMPONENTS = ['clientRuntime', 'hostRuntime', 'providerAdapters', 'contracts'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function tarFiles(payload) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= payload.length) {
    const header = payload.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const type = header[156];
    if (!name || name.startsWith('/') || name.split('/').includes('..') || files.has(name)
      || !Number.isSafeInteger(size) || size < 0 || ![0, 48].includes(type)) {
      throw new Error(`runtime tar member is unsafe: ${name || 'unknown'}`);
    }
    const start = offset + 512;
    const end = start + size;
    if (end > payload.length) throw new Error(`runtime tar member is truncated: ${name}`);
    files.set(name, payload.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function verifyEmbeddedRuntime(root) {
  const descriptorPath = join(root, 'embedded-runtime-v1.json');
  if (!existsSync(descriptorPath)) throw new Error('embedded WSL runtime descriptor is missing');
  const descriptor = exact(JSON.parse(readFileSync(descriptorPath, 'utf8')), [
    'schemaVersion', 'baselineVersion', 'sourceRepository', 'sourceCommit',
    'contractPackageVersion', 'components', 'runtime'
  ], 'embedded WSL runtime descriptor');
  if (descriptor.schemaVersion !== 1 || !/^git-[a-f0-9]{7}$/u.test(descriptor.baselineVersion)
    || !/^[a-f0-9]{40}$/u.test(descriptor.sourceCommit)
    || descriptor.baselineVersion !== `git-${descriptor.sourceCommit.slice(0, 7)}`
    || descriptor.sourceRepository !== 'https://github.com/yaakovch/wtmux'
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(descriptor.contractPackageVersion)) {
    throw new Error('embedded WSL runtime identity is invalid');
  }
  exact(descriptor.components, COMPONENTS, 'embedded WSL runtime components');
  for (const name of COMPONENTS) {
    const component = exact(descriptor.components[name], ['sequence', 'version'], `${name} component`);
    if (!Number.isSafeInteger(component.sequence) || component.sequence < 1
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(component.version)) {
      throw new Error(`embedded ${name} component is invalid`);
    }
  }
  const runtime = exact(descriptor.runtime, [
    'file', 'sha256', 'size', 'sbomSha256', 'licenseSha256'
  ], 'embedded WSL runtime artifact');
  if (!/^wtmux-runtime-git-[a-f0-9]{7}\.tar$/u.test(runtime.file)
    || ![runtime.sha256, runtime.sbomSha256, runtime.licenseSha256].every((value) => /^[a-f0-9]{64}$/u.test(value))
    || !Number.isSafeInteger(runtime.size) || runtime.size < 1 || runtime.size > 32 * 1024 * 1024) {
    throw new Error('embedded WSL runtime artifact identity is invalid');
  }
  const runtimePath = join(root, runtime.file);
  const payload = readFileSync(runtimePath);
  if (payload.length !== runtime.size || sha256(payload) !== runtime.sha256) {
    throw new Error('embedded WSL runtime artifact checksum does not match');
  }
  const files = tarFiles(payload);
  const manifestPayload = files.get('runtime-manifest.json');
  if (!manifestPayload) throw new Error('embedded WSL runtime manifest is missing');
  const manifest = exact(JSON.parse(manifestPayload.toString('utf8')), [
    'formatVersion', 'version', 'components', 'source', 'target', 'files'
  ], 'embedded WSL runtime manifest');
  if (manifest.formatVersion !== 2 || manifest.version !== descriptor.baselineVersion
    || manifest.source?.repository !== descriptor.sourceRepository
    || manifest.source?.commit !== descriptor.sourceCommit
    || manifest.source?.contractPackageVersion !== descriptor.contractPackageVersion
    || manifest.target?.platform !== 'linux') {
    throw new Error('embedded WSL runtime manifest identity does not match its descriptor');
  }
  if (!COMPONENTS.every((name) =>
    manifest.components?.[name]?.sequence === descriptor.components[name].sequence
    && manifest.components?.[name]?.version === descriptor.components[name].version)) {
    throw new Error('embedded WSL runtime components do not match their descriptor');
  }
  const expected = new Set(['runtime-manifest.json']);
  for (const item of manifest.files) {
    exact(item, ['path', 'sha256', 'size', 'mode'], 'embedded WSL runtime file');
    const file = files.get(item.path);
    if (!file || file.length !== item.size || sha256(file) !== item.sha256) {
      throw new Error(`embedded WSL runtime member verification failed: ${item.path}`);
    }
    expected.add(item.path);
  }
  if (expected.size !== files.size || [...files.keys()].some((name) => !expected.has(name))) {
    throw new Error('embedded WSL runtime tar contents do not match its manifest');
  }
  const sbom = manifest.files.find((item) => item.path === 'runtime.spdx.json');
  const license = manifest.files.find((item) => item.path === 'runtime-license.txt');
  if (sbom?.sha256 !== runtime.sbomSha256 || license?.sha256 !== runtime.licenseSha256) {
    throw new Error('embedded WSL runtime SBOM or license identity does not match');
  }
  const sourceFiles = readdirSync(root).filter((name) => statSync(join(root, name)).isFile()).sort();
  if (JSON.stringify(sourceFiles) !== JSON.stringify(['embedded-runtime-v1.json', runtime.file].sort())) {
    throw new Error('embedded WSL runtime directory contains stale inputs');
  }
  return {
    baselineVersion: descriptor.baselineVersion,
    sourceCommit: descriptor.sourceCommit,
    contractPackageVersion: descriptor.contractPackageVersion,
    components: descriptor.components,
    sha256: runtime.sha256,
    size: runtime.size
  };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    console.log(JSON.stringify(verifyEmbeddedRuntime(join(repository, 'resources', 'runtime'))));
  } catch (error) {
    console.error(`verify-embedded-runtime: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
