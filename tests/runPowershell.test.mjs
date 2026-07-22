import { describe, expect, it } from 'vitest';
import { resolvePowerShellLaunch, windowsPath } from '../scripts/run-powershell.mjs';

describe('PowerShell runner', () => {
  it('uses /init when the WSL interop registration is absent', () => {
    expect(resolvePowerShellLaunch({
      platform: 'linux',
      markerExists: false,
      launcher: '/init',
      launcherExecutable: true,
      powershell: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      powershellExecutable: true
    })).toEqual({
      command: '/init',
      prefixArguments: ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']
    });
  });

  it('uses PowerShell directly when interop is registered', () => {
    expect(resolvePowerShellLaunch({
      platform: 'linux', markerExists: true, powershell: '/mnt/c/powershell.exe', powershellExecutable: true
    })).toEqual({ command: '/mnt/c/powershell.exe', prefixArguments: [] });
  });

  it('uses the native command on Windows', () => {
    expect(resolvePowerShellLaunch({ platform: 'win32', powershellExecutable: true })).toEqual({
      command: 'powershell.exe', prefixArguments: []
    });
  });

  it('converts mounted Windows paths without shell evaluation', () => {
    expect(windowsPath('/mnt/c/projects/agent-fleet/scripts/smoke.ps1')).toBe(
      'C:\\projects\\agent-fleet\\scripts\\smoke.ps1'
    );
    expect(windowsPath('/tmp/smoke.ps1')).toBe('/tmp/smoke.ps1');
  });
});
