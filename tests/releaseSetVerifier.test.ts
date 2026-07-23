import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentFleetReleaseSetJson } from '../src/shared/release-set';
import {
  ReleaseSetVerificationError,
  signedReleaseSetPayload,
  verifyAgentFleetReleaseSet
} from '../src/main/release-set-verifier';

const fixture = (): Record<string, any> =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'contracts', 'release-set-v1.json'), 'utf8'));

function signedFixture() {
  const pair = generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const value = fixture();
  value.signature = { algorithm: 'ed25519', keyId, value: 'A'.repeat(86) };
  const parsed = parseAgentFleetReleaseSetJson(JSON.stringify(value));
  value.signature.value = sign(null, signedReleaseSetPayload(parsed), pair.privateKey).toString('base64url');
  return { text: JSON.stringify(value), keyId, publicKey: pair.publicKey, value };
}

const options = (signed: ReturnType<typeof signedFixture>) => ({
  trustedKeys: new Map([[signed.keyId, signed.publicKey]]),
  allowedOrigins: new Set(['https://updates.example.invalid', 'https://github.com']),
  installedWindowsVersion: '0.11.0-beta.21',
  now: new Date('2026-07-24T00:00:00Z'),
  minimumReleaseSetSequence: 1081
});

describe('signed release-set verification', () => {
  it('verifies the canonical signature, independent floors, origins, and installed app', () => {
    const signed = signedFixture();
    expect(verifyAgentFleetReleaseSet(signed.text, options(signed))).toMatchObject({
      releaseSetSequence: 1082,
      components: { clientRuntime: { sequence: 45 }, androidApp: { sequence: 1076 } }
    });
  });

  it('reports stable expiry, downgrade, compatibility, origin, key, and signature failures', () => {
    const signed = signedFixture();
    const expectCode = (operation: () => unknown, code: string) => {
      try { operation(); throw new Error('verification unexpectedly passed'); }
      catch (error) {
        expect(error).toBeInstanceOf(ReleaseSetVerificationError);
        expect((error as ReleaseSetVerificationError).code).toBe(code);
      }
    };
    expectCode(() => verifyAgentFleetReleaseSet(signed.text, {
      ...options(signed), now: new Date('2026-09-01T00:00:00Z')
    }), 'release_set_expired');
    expectCode(() => verifyAgentFleetReleaseSet(signed.text, {
      ...options(signed), minimumReleaseSetSequence: 1083
    }), 'release_set_downgrade');
    expectCode(() => verifyAgentFleetReleaseSet(signed.text, {
      ...options(signed), installedWindowsVersion: 'different'
    }), 'release_set_incompatible');
    expectCode(() => verifyAgentFleetReleaseSet(signed.text, {
      ...options(signed), allowedOrigins: new Set(['https://updates.example.invalid'])
    }), 'release_set_origin_unapproved');
    expectCode(() => verifyAgentFleetReleaseSet(signed.text, {
      ...options(signed), trustedKeys: new Map()
    }), 'release_set_unknown_key');

    const changed = structuredClone(signed.value);
    changed.artifacts[0].sha256 = '9'.repeat(64);
    expectCode(() => verifyAgentFleetReleaseSet(JSON.stringify(changed), options(signed)), 'release_set_signature_invalid');
  });
});
