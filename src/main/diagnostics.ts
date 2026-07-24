import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AppInfo } from '../shared/app';
import type { FleetBridgeView, FleetDoctorResult } from '../shared/fleet-protocol';
import type { TerminalHealth } from '../shared/terminal';
import type { WslRuntimeState } from '../shared/runtime';
import {
  createWindowsLayeredDiagnostics,
  type LayeredDiagnosticReport
} from '../shared/layered-diagnostics';

interface DiagnosticsInput {
  app: AppInfo;
  fleet: FleetBridgeView;
  doctors: FleetDoctorResult[];
  terminal: TerminalHealth;
  wslRuntime: WslRuntimeState;
  updateConfigured: boolean;
}

interface ArchiveWriter {
  on(event: 'error', listener: (error: Error) => void): void;
  pipe(output: NodeJS.WritableStream): void;
  append(source: string, options: { name: string }): void;
  file(path: string, options: { name: string }): void;
  finalize(): Promise<void>;
}

const require = createRequire(import.meta.url);
const createArchive = require('archiver') as (format: 'zip', options: { zlib: { level: number } }) => ArchiveWriter;

export async function writeDiagnosticsArchive(destination: string, input: DiagnosticsInput): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  const output = createWriteStream(destination);
  const archive = createArchive('zip', { zlib: { level: 9 } });
  const completion = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);
  const entries = createDiagnosticsEntries(input);
  for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
  await archive.finalize();
  await completion;
}

export function createDiagnosticsEntries(input: DiagnosticsInput): Record<string, string> {
  const report = createDiagnosticsReport(input);
  return { 'diagnostics-v2.json': `${JSON.stringify(report, null, 2)}\n` };
}

export function createDiagnosticsReport(input: DiagnosticsInput): LayeredDiagnosticReport {
  return createWindowsLayeredDiagnostics({
    clientVersion: input.app.version,
    fleet: input.fleet,
    doctors: input.doctors,
    terminal: input.terminal,
    wslRuntime: input.wslRuntime,
    updateConfigured: input.updateConfigured
  });
}
