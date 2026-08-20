#!/usr/bin/env node

import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMPONENTS = ['clientRuntime', 'hostRuntime', 'providerAdapters', 'contracts'];
const TERMINAL_REPLY_SAFETY_MINIMUMS = Object.freeze({
  clientRuntime: 66,
  hostRuntime: 60,
  providerAdapters: 33
});
const TERMINAL_REPLY_SAFETY_FILES = Object.freeze([
  'lib/tmux_safety.py',
  'lib/tmux_state.sh',
  'scripts/wtmux-tmux-safety'
]);
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

export function assertRuntimeManifestIdentity(value, descriptor) {
  const manifest = exact(value, [
    'formatVersion', 'version', 'components', 'source', 'target', 'files'
  ], 'embedded WSL runtime manifest');
  const components = exact(manifest.components, COMPONENTS, 'embedded WSL runtime manifest components');
  for (const name of COMPONENTS) {
    exact(components[name], ['sequence', 'version'], `embedded WSL runtime manifest ${name} component`);
  }
  const source = exact(manifest.source, [
    'schemaVersion', 'repository', 'commit', 'license', 'contractPackageVersion'
  ], 'embedded WSL runtime source');
  const target = exact(manifest.target, [
    'platform', 'architecture', 'prefix'
  ], 'embedded WSL runtime target');
  if (manifest.formatVersion !== 2 || manifest.version !== descriptor.baselineVersion
    || source.schemaVersion !== 1
    || source.repository !== descriptor.sourceRepository
    || source.commit !== descriptor.sourceCommit
    || source.license !== 'MIT'
    || source.contractPackageVersion !== descriptor.contractPackageVersion
    || target.platform !== 'linux'
    || target.architecture !== 'universal'
    || target.prefix !== '/home/agent-fleet/.local') {
    throw new Error('embedded WSL runtime manifest identity does not match its descriptor');
  }
  if (!COMPONENTS.every((name) =>
    components[name].sequence === descriptor.components[name].sequence
    && components[name].version === descriptor.components[name].version)) {
    throw new Error('embedded WSL runtime components do not match their descriptor');
  }
  return manifest;
}

export function assertTerminalReplySafeRuntime(components, fileNames) {
  if (Object.entries(TERMINAL_REPLY_SAFETY_MINIMUMS).some(
    ([name, minimum]) => !Number.isSafeInteger(components?.[name]?.sequence)
      || components[name].sequence < minimum
  )) {
    throw new Error('embedded runtime predates managed terminal-reply safety');
  }
  const names = new Set(fileNames);
  if (TERMINAL_REPLY_SAFETY_FILES.some((name) => !names.has(name))) {
    throw new Error('embedded runtime omits managed terminal-reply safety');
  }
  return components;
}

export function assertConnectableMachineRegistryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 2 || !Array.isArray(value.roles)) {
    throw new Error('embedded machine registry records must use identity schema v2');
  }
  if (!value.roles.includes('host')) return value;
  if (!Array.isArray(value.endpoints)) {
    throw new Error(`embedded host registry record has no endpoints: ${value.id || 'unknown'}`);
  }
  const connectable = value.endpoints.some((endpoint) => {
    if (!endpoint || typeof endpoint !== 'object' || endpoint.identityState !== 'verified') return false;
    const expectedNetwork = value.transport === 'tailscale'
      ? 'tailnet'
      : value.transport === 'ssh' ? 'direct' : null;
    if (!expectedNetwork) return false;
    if (endpoint.network !== expectedNetwork) return false;
    if (expectedNetwork === 'tailnet' && !endpoint.tailscaleNodeId) return false;
    return (expectedNetwork === 'tailnet' && endpoint.sshEngine === 'tailscale-cli')
      || (endpoint.sshEngine === 'openssh' && Boolean(endpoint.sshHostKeySha256));
  });
  if (!connectable) {
    throw new Error(`embedded host registry record has no verified transport: ${value.id || 'unknown'}`);
  }
  return value;
}

export function verifyEmbeddedRuntime(root) {
  const descriptorPath = join(root, 'embedded-runtime-v1.json');
  if (!existsSync(descriptorPath)) throw new Error('embedded WSL runtime descriptor is missing');
  const descriptor = exact(JSON.parse(readFileSync(descriptorPath, 'utf8')), [
    'schemaVersion', 'baselineVersion', 'sourceRepository', 'sourceCommit',
    'contractPackageVersion', 'components', 'runtime', 'registry', 'trustedReleaseKeys'
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
    'file', 'sha256', 'size', 'formatVersion', 'manifestSha256', 'sbomSha256', 'licenseSha256'
  ], 'embedded WSL runtime artifact');
  if (!/^wtmux-runtime-git-[a-f0-9]{7}\.tar$/u.test(runtime.file)
    || runtime.formatVersion !== 2
    || ![
      runtime.sha256, runtime.manifestSha256, runtime.sbomSha256, runtime.licenseSha256
    ].every((value) => /^[a-f0-9]{64}$/u.test(value))
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
  if (sha256(manifestPayload) !== runtime.manifestSha256) {
    throw new Error('embedded WSL runtime manifest checksum does not match its descriptor');
  }
  const manifest = assertRuntimeManifestIdentity(JSON.parse(manifestPayload.toString('utf8')), descriptor);
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
  assertTerminalReplySafeRuntime(manifest.components, files.keys());
  const sbom = manifest.files.find((item) => item.path === 'runtime.spdx.json');
  const license = manifest.files.find((item) => item.path === 'runtime-license.txt');
  if (sbom?.sha256 !== runtime.sbomSha256 || license?.sha256 !== runtime.licenseSha256) {
    throw new Error('embedded WSL runtime SBOM or license identity does not match');
  }
  const registry = exact(descriptor.registry, [
    'file', 'sha256', 'size', 'records'
  ], 'embedded machine registry artifact');
  if (!/^wtmux-registry-[a-f0-9]{7}\.tar$/u.test(registry.file)
    || !/^[a-f0-9]{64}$/u.test(registry.sha256)
    || !Number.isSafeInteger(registry.size) || registry.size < 1 || registry.size > 32 * 1024 * 1024
    || !Number.isSafeInteger(registry.records) || registry.records < 1 || registry.records > 256) {
    throw new Error('embedded machine registry artifact identity is invalid');
  }
  const registryPayload = readFileSync(join(root, registry.file));
  if (registryPayload.length !== registry.size || sha256(registryPayload) !== registry.sha256) {
    throw new Error('embedded machine registry artifact checksum does not match');
  }
  const registryFiles = tarFiles(registryPayload);
  const registryManifestPayload = registryFiles.get('registry-manifest.json');
  if (!registryManifestPayload) throw new Error('embedded machine registry manifest is missing');
  const registryManifest = exact(JSON.parse(registryManifestPayload.toString('utf8')), [
    'formatVersion', 'schemaVersion', 'records'
  ], 'embedded machine registry manifest');
  if (registryManifest.formatVersion !== 1 || registryManifest.schemaVersion !== 1
    || !Array.isArray(registryManifest.records) || registryManifest.records.length !== registry.records) {
    throw new Error('embedded machine registry manifest identity is invalid');
  }
  const expectedRegistryFiles = new Set(['registry-manifest.json']);
  for (const item of registryManifest.records) {
    exact(item, ['id', 'path', 'sha256', 'size'], 'embedded machine registry record');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item.id)
      || item.path !== `machines/${item.id}.json`
      || expectedRegistryFiles.has(item.path)
      || !/^[a-f0-9]{64}$/u.test(item.sha256)
      || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 64 * 1024) {
      throw new Error(`embedded machine registry record identity is invalid: ${item.id || 'unknown'}`);
    }
    const file = registryFiles.get(item.path);
    if (!file || file.length !== item.size || sha256(file) !== item.sha256) {
      throw new Error(`embedded machine registry member verification failed: ${item.path}`);
    }
    let record;
    try {
      record = JSON.parse(file.toString('utf8'));
    } catch {
      throw new Error(`embedded machine registry record is not valid JSON: ${item.id}`);
    }
    if (record.id !== item.id) {
      throw new Error(`embedded machine registry record ID does not match its manifest: ${item.id}`);
    }
    assertConnectableMachineRegistryRecord(record);
    expectedRegistryFiles.add(item.path);
  }
  if (expectedRegistryFiles.size !== registryFiles.size
    || [...registryFiles.keys()].some((name) => !expectedRegistryFiles.has(name))) {
    throw new Error('embedded machine registry tar contents do not match its manifest');
  }
  if (!Array.isArray(descriptor.trustedReleaseKeys)
    || descriptor.trustedReleaseKeys.length < 1 || descriptor.trustedReleaseKeys.length > 4) {
    throw new Error('embedded trusted release keys are invalid');
  }
  const releaseKeyFiles = new Set();
  const releaseKeyIds = new Set();
  for (const value of descriptor.trustedReleaseKeys) {
    const key = exact(value, ['keyId', 'file', 'sha256'], 'embedded trusted release key');
    if (!/^[a-f0-9]{32}$/u.test(key.keyId)
      || key.file !== `trusted-release-key-${key.keyId}.pem`
      || !/^[a-f0-9]{64}$/u.test(key.sha256)
      || releaseKeyIds.has(key.keyId) || releaseKeyFiles.has(key.file)) {
      throw new Error('embedded trusted release key identity is invalid');
    }
    const keyPayload = readFileSync(join(root, key.file));
    if (keyPayload.length < 1 || keyPayload.length > 4096 || sha256(keyPayload) !== key.sha256) {
      throw new Error(`embedded trusted release key checksum does not match: ${key.keyId}`);
    }
    const publicKey = createPublicKey(keyPayload);
    const derivedKeyId = sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 32);
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
      || derivedKeyId !== key.keyId) {
      throw new Error(`embedded trusted release key is invalid: ${key.keyId}`);
    }
    releaseKeyIds.add(key.keyId);
    releaseKeyFiles.add(key.file);
  }
  const sourceFiles = readdirSync(root).filter((name) => statSync(join(root, name)).isFile()).sort();
  if (JSON.stringify(sourceFiles) !== JSON.stringify([
    'embedded-runtime-v1.json', runtime.file, registry.file, ...releaseKeyFiles
  ].sort())) {
    throw new Error('embedded WSL runtime directory contains stale inputs');
  }
  return {
    baselineVersion: descriptor.baselineVersion,
    sourceCommit: descriptor.sourceCommit,
    contractPackageVersion: descriptor.contractPackageVersion,
    components: descriptor.components,
    sha256: runtime.sha256,
    size: runtime.size,
    manifestSha256: runtime.manifestSha256,
    registrySha256: registry.sha256,
    registryRecords: registry.records,
    trustedReleaseKeyIds: [...releaseKeyIds].sort()
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
