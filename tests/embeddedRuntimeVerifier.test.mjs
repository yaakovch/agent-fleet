import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRuntimeManifestIdentity,
  verifyEmbeddedRuntime
} from '../scripts/verify-embedded-runtime.mjs';

const source = resolve('resources/runtime');
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-fleet-embedded-runtime-'));
  roots.push(root);
  await cp(source, root, { recursive: true });
  return root;
}

describe('embedded runtime verifier', () => {
  it('rejects ambiguous source, target, component, and license provenance', () => {
    const descriptor = JSON.parse(readFileSync(join(source, 'embedded-runtime-v1.json'), 'utf8'));
    const baseline = {
      formatVersion: 2,
      version: descriptor.baselineVersion,
      components: structuredClone(descriptor.components),
      source: {
        schemaVersion: 1,
        repository: descriptor.sourceRepository,
        commit: descriptor.sourceCommit,
        license: 'MIT',
        contractPackageVersion: descriptor.contractPackageVersion
      },
      target: {
        platform: 'linux',
        architecture: 'universal',
        prefix: '/home/agent-fleet/.local'
      },
      files: []
    };
    expect(assertRuntimeManifestIdentity(structuredClone(baseline), descriptor)).toEqual(baseline);

    for (const mutate of [
      (value) => { value.source.license = 'NOASSERTION'; },
      (value) => { value.source.unexpected = true; },
      (value) => { value.target.architecture = 'x86_64'; },
      (value) => { value.target.prefix = '/tmp/runtime'; },
      (value) => { value.components.clientRuntime.unexpected = true; }
    ]) {
      const candidate = structuredClone(baseline);
      mutate(candidate);
      expect(() => assertRuntimeManifestIdentity(candidate, descriptor)).toThrow(/fields are invalid|identity/u);
    }
  });

  it('binds the immutable descriptor to the exact archived manifest bytes', async () => {
    const root = await fixture();
    const descriptorPath = join(root, 'embedded-runtime-v1.json');
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    descriptor.runtime.manifestSha256 = '0'.repeat(64);
    writeFileSync(descriptorPath, JSON.stringify(descriptor));

    expect(() => verifyEmbeddedRuntime(root)).toThrow(
      'runtime manifest checksum does not match its descriptor'
    );
  });
});
