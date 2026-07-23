import { describe, expect, it } from 'vitest';
import { buildFleetTerminalCommand, buildFleetVscodeUri, buildFleetWslAttachCommand, resolveWslExecutable } from '../src/main/fleet-terminal';

describe('fleet terminal launcher', () => {
  it('resolves WSL from the Windows system directory instead of PATH', () => {
    const expected = 'C:\\Windows\\System32\\wsl.exe';
    expect(resolveWslExecutable({ SystemRoot: 'C:\\Windows' }, (path) => path === expected)).toBe(expected);
    expect(() => resolveWslExecutable({}, () => false)).toThrow(/could not be located/i);
  });
  it('builds a direct argv launch for the exact validated session', () => {
    expect(buildFleetTerminalCommand({
      id: 'work-m-ubuntu:wtmux-project-1',
      hostId: 'work-m-ubuntu',
      project: 'project',
      sessionName: 'wtmux-project-1',
      label: 'project:1'
    }, 'Ubuntu')).toEqual({
      command: 'wt.exe',
      args: [
        'new-tab', '--title', 'project:1',
        'wsl.exe', '-d', 'Ubuntu', '--cd', '~', '--',
        '.local/share/agent-fleet/wtmux/current/scripts/wtmux', '--host', 'work-m-ubuntu', '--project', 'project',
        '--session', 'wtmux-project-1', '--fast'
      ]
    });
  });

  it('rejects shell syntax in the internal session name', () => {
    expect(() => buildFleetTerminalCommand({
      id: 'host:session', hostId: 'host', project: 'project',
      sessionName: 'session;calc.exe', label: 'session'
    }, 'Ubuntu')).toThrow(/session name/i);
  });

  it('builds the direct WSL attach used by the embedded PTY', () => {
    expect(buildFleetWslAttachCommand({
      id: 'gaming:wtmux-main-1', hostId: 'gaming', project: 'main',
      sessionName: 'wtmux-main-1', label: 'main'
    }, 'Ubuntu')).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '~', '--', '.local/share/agent-fleet/wtmux/current/scripts/wtmux', '--host', 'gaming',
        '--project', 'main', '--session', 'wtmux-main-1', '--fast']
    });
  });

  it('builds a validated VS Code URI without shell text', () => {
    const uri = buildFleetVscodeUri({
      id: 'work-m-ubuntu:wtmux-project-1', hostId: 'work-m-ubuntu', project: 'project name',
      sessionName: 'wtmux-project-1', label: 'project:1'
    }, 'Ubuntu');
    expect(uri).toBe('vscode://wtmux.wtmux-image-paste/open?host=work-m-ubuntu&project=project+name&session=wtmux-project-1&distro=Ubuntu');
  });
});
