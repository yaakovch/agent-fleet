import { createHash, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  parseAgentFleetReleaseSetJson,
  type AgentFleetReleaseSet,
  type ReleaseComponentId
} from '../shared/release-set';

export type ReleaseSetVerificationCode =
  | 'release_set_not_yet_valid'
  | 'release_set_expired'
  | 'release_set_downgrade'
  | 'release_set_component_downgrade'
  | 'release_set_incompatible'
  | 'release_set_origin_unapproved'
  | 'release_set_unknown_key'
  | 'release_set_signature_invalid';

export class ReleaseSetVerificationError extends Error {
  constructor(readonly code: ReleaseSetVerificationCode, message: string) {
    super(message);
    this.name = 'ReleaseSetVerificationError';
  }
}

export interface ReleaseSetVerificationOptions {
  trustedKeys: ReadonlyMap<string, KeyObject>;
  allowedOrigins: ReadonlySet<string>;
  installedWindowsVersion: string;
  now?: Date;
  minimumReleaseSetSequence?: number;
  componentFloors?: Partial<Record<ReleaseComponentId, number>>;
}

export function verifyAgentFleetReleaseSet(
  text: string,
  options: ReleaseSetVerificationOptions
): AgentFleetReleaseSet {
  const releaseSet = parseAgentFleetReleaseSetJson(text);
  const now = (options.now ?? new Date()).getTime();
  if (now < Date.parse(releaseSet.issuedAt)) {
    throw new ReleaseSetVerificationError('release_set_not_yet_valid', 'The release set is not valid yet.');
  }
  if (now >= Date.parse(releaseSet.expiresAt)) {
    throw new ReleaseSetVerificationError('release_set_expired', 'The release set has expired.');
  }
  const minimum = Math.max(
    options.minimumReleaseSetSequence ?? 0,
    releaseSet.rollbackFloor.releaseSetSequence
  );
  if (releaseSet.releaseSetSequence < minimum) {
    throw new ReleaseSetVerificationError('release_set_downgrade', 'The release set is below the accepted anti-rollback floor.');
  }
  if (releaseSet.components.windowsApp.version !== options.installedWindowsVersion) {
    throw new ReleaseSetVerificationError(
      'release_set_incompatible',
      'The installed Windows app is outside the selected release set.'
    );
  }
  for (const [name, component] of Object.entries(releaseSet.components) as [
    ReleaseComponentId, AgentFleetReleaseSet['components'][ReleaseComponentId]
  ][]) {
    const floor = Math.max(
      options.componentFloors?.[name] ?? 0,
      releaseSet.rollbackFloor.componentSequences[name]
    );
    if (component.sequence < floor) {
      throw new ReleaseSetVerificationError(
        'release_set_component_downgrade',
        `${name} is below its accepted anti-rollback floor.`
      );
    }
  }
  for (const artifact of releaseSet.artifacts) {
    for (const url of [artifact.url, artifact.sourceRepository]) {
      if (!options.allowedOrigins.has(new URL(url).origin)) {
        throw new ReleaseSetVerificationError(
          'release_set_origin_unapproved',
          `The release-set origin is not approved: ${new URL(url).origin}`
        );
      }
    }
  }
  const trusted = options.trustedKeys.get(releaseSet.signature.keyId);
  if (!trusted) {
    throw new ReleaseSetVerificationError('release_set_unknown_key', 'The release set uses an unknown signing key.');
  }
  const signature = Buffer.from(releaseSet.signature.value, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== releaseSet.signature.value
    || !verifySignature(null, signedReleaseSetPayload(releaseSet), trusted, signature)) {
    throw new ReleaseSetVerificationError('release_set_signature_invalid', 'The release-set signature is invalid.');
  }
  const expectedKeyId = createHash('sha256').update(trusted.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32);
  if (expectedKeyId !== releaseSet.signature.keyId) {
    throw new ReleaseSetVerificationError('release_set_unknown_key', 'The release-set key ID does not match the trusted key.');
  }
  return releaseSet;
}

export function signedReleaseSetPayload(releaseSet: AgentFleetReleaseSet): Buffer {
  return Buffer.from(stableJson({
    ...releaseSet,
    signature: {
      algorithm: releaseSet.signature.algorithm,
      keyId: releaseSet.signature.keyId
    }
  }), 'utf8');
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
