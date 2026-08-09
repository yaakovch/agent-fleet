import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdaterManager, type UpdateClient } from '../src/main/updater';
import type {
  FleetReleaseSetAuthorityLike,
  VerifiedReleaseSetAdmission
} from '../src/main/release-set-authority';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeUpdateClient extends EventEmitter implements UpdateClient {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger: unknown = null;
  checkForUpdates = vi.fn(async (): Promise<unknown> => undefined);
  downloadUpdate = vi.fn(async (): Promise<string[]> => []);
  quitAndInstall = vi.fn();
}

function updateInfo(version = '1.0.0') {
  return {
    version,
    files: [{ url: `Agent-Fleet-${version}-Setup-x64.exe` }],
    path: `Agent-Fleet-${version}-Setup-x64.exe`,
    sha512: 'unused',
    releaseDate: '2026-08-01T00:00:00Z'
  };
}

function admission(payload: Buffer, version = '1.0.0'): VerifiedReleaseSetAdmission {
  return {
    configurationDigest: 'a'.repeat(64),
    sourceUrl: 'https://updates.example.invalid/runtime/manifest.json',
    releaseSet: {
      releaseSetSequence: 1,
      signature: {
        algorithm: 'ed25519',
        keyId: 'b'.repeat(32),
        value: 'test-signature'
      }
    },
    windowsArtifact: {
      version,
      size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
      url: `https://updates.example.invalid/Agent-Fleet-${version}-Setup-x64.exe`
    }
  } as unknown as VerifiedReleaseSetAdmission;
}

describe('updater manager', () => {
  it('admits and verifies exact downloaded bytes before allowing restart', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    writeFileSync(path, payload);
    const selected = admission(payload);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => selected),
      assertCurrent: vi.fn(),
      commitHealthy: vi.fn()
    };
    const info = updateInfo();
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info });
    client.downloadUpdate.mockImplementationOnce(async () => {
      client.emit('update-downloaded', info);
      return [path];
    });
    const verifiedUpdateRoot = join(root, 'verified');
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot
    });

    await expect(updater.checkNow()).resolves.toMatchObject({
      status: 'downloaded', availableVersion: '1.0.0'
    });
    expect(client.autoDownload).toBe(false);
    expect(client.autoInstallOnAppQuit).toBe(false);
    expect(authority.verifyWindowsRelease).toHaveBeenCalledWith('1.0.0');
    expect(authority.commitHealthy).not.toHaveBeenCalled();
    const snapshotPath = join(verifiedUpdateRoot, readdirSync(verifiedUpdateRoot)[0]);
    expect(statSync(snapshotPath).mode & 0o222).toBe(0);
    expect(statSync(snapshotPath).ino).not.toBe(statSync(path).ino);
    await updater.restartToUpdate();
    expect(authority.verifyWindowsRelease).toHaveBeenCalledTimes(2);
    expect(authority.assertCurrent).toHaveBeenCalledTimes(2);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(readFileSync(path)).toEqual(payload);
    expect(client.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('fails closed for a signed admission when the authority cannot prove freshness', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    writeFileSync(path, payload);
    const selected = admission(payload);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => selected),
      commitHealthy: vi.fn()
    };
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: updateInfo() });
    client.downloadUpdate.mockResolvedValueOnce([path]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot: join(root, 'verified')
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    await updater.restartToUpdate();

    expect(updater.getState()).toMatchObject({
      status: 'error',
      message: 'Downloaded update is no longer admitted by current policy'
    });
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it('rechecks signed admission freshness after binding and blocks a late policy change', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    const verifiedUpdateRoot = join(root, 'verified');
    writeFileSync(path, payload);
    const selected = admission(payload);
    const assertCurrent = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('configuration generation changed'); });
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => selected),
      assertCurrent,
      commitHealthy: vi.fn()
    };
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: updateInfo() });
    client.downloadUpdate.mockResolvedValueOnce([path]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    const snapshotPath = join(verifiedUpdateRoot, readdirSync(verifiedUpdateRoot)[0]);
    await updater.restartToUpdate();

    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(updater.getState()).toMatchObject({
      status: 'error',
      message: 'Downloaded update is no longer admitted by current policy'
    });
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it('fails closed if the updater-selected installer is replaced after download', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    writeFileSync(path, payload);
    const selected = admission(payload);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => selected),
      commitHealthy: vi.fn()
    };
    const info = updateInfo();
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info });
    client.downloadUpdate.mockResolvedValueOnce([path]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot: join(root, 'verified')
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    unlinkSync(path);
    writeFileSync(path, Buffer.alloc(payload.length, 0x78));

    await updater.restartToUpdate();

    expect(authority.verifyWindowsRelease).toHaveBeenCalledTimes(2);
    expect(updater.getState()).toMatchObject({ status: 'error' });
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it('fails closed if the protected snapshot is modified before restart', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    const verifiedUpdateRoot = join(root, 'verified');
    writeFileSync(path, payload);
    const selected = admission(payload);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => selected),
      commitHealthy: vi.fn()
    };
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: updateInfo() });
    client.downloadUpdate.mockResolvedValueOnce([path]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    const snapshotPath = join(verifiedUpdateRoot, readdirSync(verifiedUpdateRoot)[0]);
    chmodSync(snapshotPath, 0o600);
    writeFileSync(snapshotPath, Buffer.alloc(payload.length, 0x79));

    await updater.restartToUpdate();

    expect(updater.getState()).toMatchObject({ status: 'error' });
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each([
    ['current configuration changes', 'configuration'],
    ['the signed release cohort changes', 'cohort'],
    ['the signed release is revoked', 'revocation']
  ])('re-admits at restart and fails closed when %s', async (_description, change) => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    writeFileSync(path, payload);
    const selected = admission(payload);
    const changed = change === 'configuration'
      ? { ...selected, configurationDigest: 'c'.repeat(64) }
      : change === 'cohort'
        ? { ...selected, releaseSet: { ...selected.releaseSet, releaseSetSequence: 2 } }
        : null;
    const verifyWindowsRelease = vi.fn()
      .mockResolvedValueOnce(selected)
      .mockResolvedValueOnce(changed);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease,
      commitHealthy: vi.fn()
    };
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: updateInfo() });
    client.downloadUpdate.mockResolvedValueOnce([path]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot: join(root, 'verified')
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    await updater.restartToUpdate();

    expect(verifyWindowsRelease).toHaveBeenCalledTimes(2);
    expect(updater.getState()).toMatchObject({
      status: 'error',
      message: 'Downloaded update is no longer admitted by current policy'
    });
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each([
    ['size', Buffer.from('wrong-size')],
    ['checksum', Buffer.from('corrupt-bytes')]
  ])('rejects a downloaded artifact with the wrong %s', async (_label, downloaded) => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const expected = _label === 'size'
      ? Buffer.from('signed Windows installer')
      : Buffer.from('trusted-bytes');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    writeFileSync(path, downloaded);
    const selected = admission(expected);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => selected),
      commitHealthy: vi.fn()
    };
    const info = updateInfo();
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info });
    client.downloadUpdate.mockImplementationOnce(async () => {
      client.emit('update-downloaded', info);
      return [path];
    });
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot: join(root, 'verified')
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'error' });
    expect(updater.getState().message).toContain('does not match the signed release set');
    expect(client.autoInstallOnAppQuit).toBe(false);
    updater.restartToUpdate();
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it('keeps the legacy no-policy updater path available without claiming signed admission', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const path = join(root, 'legacy-installer.exe');
    writeFileSync(path, 'legacy updater bytes');
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => null),
      commitHealthy: vi.fn()
    };
    const info = updateInfo();
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info });
    client.downloadUpdate.mockImplementationOnce(async () => {
      client.emit('update-downloaded', info);
      return [path];
    });
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot: join(root, 'verified')
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    expect(authority.verifyWindowsRelease).toHaveBeenCalledOnce();
    expect(authority.commitHealthy).not.toHaveBeenCalled();
    await updater.restartToUpdate();
    expect(authority.verifyWindowsRelease).toHaveBeenCalledTimes(2);
    expect(client.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('blocks an unconfigured legacy download if signed policy is enrolled before restart', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'legacy-installer.exe');
    writeFileSync(path, 'legacy updater bytes');
    const verifyWindowsRelease = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(admission(payload));
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease,
      commitHealthy: vi.fn()
    };
    const info = updateInfo();
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info });
    client.downloadUpdate.mockResolvedValueOnce([path]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot: join(root, 'verified')
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    await updater.restartToUpdate();

    expect(verifyWindowsRelease).toHaveBeenCalledTimes(2);
    expect(updater.getState()).toMatchObject({
      status: 'error',
      message: 'Downloaded update is no longer admitted by current policy'
    });
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not accept a signed decoy after a different selected installer path', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const selectedPath = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    const decoyPath = join(root, 'signed-decoy.exe');
    writeFileSync(selectedPath, 'different selected installer');
    writeFileSync(decoyPath, payload);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => admission(payload)),
      commitHealthy: vi.fn()
    };
    const info = updateInfo();
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info });
    client.downloadUpdate.mockResolvedValueOnce([selectedPath, decoyPath]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot: join(root, 'verified')
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'error' });
    updater.restartToUpdate();
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(['disable', 'stop'] as const)('removes the prepared snapshot on updater %s', async (action) => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const payload = Buffer.from('signed Windows installer');
    const path = join(root, 'Agent-Fleet-1.0.0-Setup-x64.exe');
    const verifiedUpdateRoot = join(root, 'verified');
    writeFileSync(path, payload);
    const selected = admission(payload);
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => selected),
      assertCurrent: vi.fn(),
      commitHealthy: vi.fn()
    };
    client.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: updateInfo() });
    client.downloadUpdate.mockResolvedValueOnce([path]);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot
    });

    await expect(updater.checkNow()).resolves.toMatchObject({ status: 'downloaded' });
    expect(readdirSync(verifiedUpdateRoot)).toHaveLength(1);
    if (action === 'disable') updater.setEnabled(false);
    else updater.stop();

    await vi.waitFor(() => expect(readdirSync(verifiedUpdateRoot)).toEqual([]));
    expect(client.quitAndInstall).not.toHaveBeenCalled();
  });

  it('sweeps only owned verified-update snapshots at process startup', async () => {
    const client = new FakeUpdateClient();
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-update-')); roots.push(root);
    const verifiedUpdateRoot = join(root, 'verified');
    mkdirSync(verifiedUpdateRoot);
    const digest = 'a'.repeat(64);
    const ownedName = `windows-${digest}-12345678-1234-4123-8123-123456789abc.exe`;
    const unknownNames = [
      'operator-note.txt',
      `windows-${digest}-not-an-owned-uuid.exe`,
      `${ownedName}.backup`
    ];
    writeFileSync(join(verifiedUpdateRoot, ownedName), 'stale snapshot');
    for (const name of unknownNames) writeFileSync(join(verifiedUpdateRoot, name), 'preserve me');
    const authority: FleetReleaseSetAuthorityLike = {
      verifyWindowsRelease: vi.fn(async () => null),
      commitHealthy: vi.fn()
    };
    const updater = new UpdaterManager({
      currentVersion: '0.9.0', eligible: true, prerelease: false, client,
      releaseSetAuthority: authority,
      verifiedUpdateRoot
    });

    expect(updater.getState()).toMatchObject({ status: 'idle' });
    await vi.waitFor(() => expect(existsSync(join(verifiedUpdateRoot, ownedName))).toBe(false));
    expect(client.checkForUpdates).not.toHaveBeenCalled();
    expect(readdirSync(verifiedUpdateRoot).sort()).toEqual(unknownNames.sort());
  });

  it('disables automatic updates for ineligible builds', async () => {
    const client = new FakeUpdateClient();
    const updater = new UpdaterManager({ currentVersion: '1.0.0', eligible: false, prerelease: false, client });
    updater.setEnabled(true);
    expect(updater.getState().status).toBe('disabled');
    await updater.checkNow();
    expect(client.checkForUpdates).not.toHaveBeenCalled();
  });

  it('tracks one owned download generation and restarts only once after download', async () => {
    const client = new FakeUpdateClient();
    let finishDownload = (): void => undefined;
    const downloadPromise = new Promise<void>((resolve) => { finishDownload = resolve; });
    client.checkForUpdates.mockResolvedValueOnce({ downloadPromise });
    const updater = new UpdaterManager({ currentVersion: '0.9.0', eligible: true, prerelease: true, client });
    const check = updater.checkNow();
    await vi.waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledTimes(1));
    client.emit('update-available', { version: '1.0.0' });
    client.emit('download-progress', { percent: 42 });
    expect(updater.getState()).toMatchObject({ status: 'downloading', progressPercent: 42 });
    updater.restartToUpdate();
    expect(client.quitAndInstall).not.toHaveBeenCalled();
    client.emit('update-downloaded', { version: '1.0.0' });
    updater.restartToUpdate();
    updater.restartToUpdate();
    expect(client.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(client.quitAndInstall).toHaveBeenCalledTimes(1);
    finishDownload();
    await check;
  });

  it('redacts verbose update feed errors before exposing them to the UI', async () => {
    const client = new FakeUpdateClient();
    client.checkForUpdates.mockRejectedValueOnce(new Error('HTTP 404\nheaders: authorization=secret'));
    const updater = new UpdaterManager({ currentVersion: '0.9.0', eligible: true, prerelease: true, client });
    await updater.checkNow();
    expect(updater.getState()).toMatchObject({
      status: 'error',
      message: 'No published update feed is available yet.'
    });
  });

  it('coalesces checks per generation, serializes replacements, and ignores stale events', async () => {
    const client = new FakeUpdateClient();
    let finishFirst = (): void => undefined;
    let finishSecond = (): void => undefined;
    const firstDownload = new Promise<void>((resolve) => { finishFirst = resolve; });
    const secondDownload = new Promise<void>((resolve) => { finishSecond = resolve; });
    client.checkForUpdates
      .mockResolvedValueOnce({ downloadPromise: firstDownload })
      .mockResolvedValueOnce({ downloadPromise: secondDownload });
    const updater = new UpdaterManager({ currentVersion: '0.9.0', eligible: true, prerelease: false, client });

    const first = updater.checkNow();
    const duplicate = updater.checkNow();
    await vi.waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledTimes(1));
    updater.setEnabled(false);
    const replacement = updater.checkNow();
    client.emit('update-downloaded', { version: 'stale-version' });
    expect(updater.getState().status).toBe('checking');
    expect(updater.getState().availableVersion).toBeUndefined();
    finishFirst();
    await Promise.all([first, duplicate]);
    await vi.waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledTimes(2));

    client.emit('update-not-available', { version: '0.9.0' });
    expect(updater.getState().status).toBe('up-to-date');
    finishSecond();
    await replacement;
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('cancels a timed-out download generation and allows a later check to run', async () => {
    const client = new FakeUpdateClient();
    const cancellationToken = { cancel: vi.fn(), dispose: vi.fn() };
    client.checkForUpdates
      .mockResolvedValueOnce({
        downloadPromise: new Promise(() => undefined),
        cancellationToken
      })
      .mockResolvedValueOnce(undefined);
    const updater = new UpdaterManager({
      currentVersion: '0.9.0',
      eligible: true,
      prerelease: false,
      client,
      operationTimeoutMs: 20
    });

    await expect(updater.checkNow()).resolves.toMatchObject({
      status: 'error',
      message: 'Update operation timed out'
    });
    expect(cancellationToken.cancel).toHaveBeenCalledOnce();
    expect(cancellationToken.dispose).toHaveBeenCalledOnce();

    await updater.checkNow();
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
