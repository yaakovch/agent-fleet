import { createWriteStream, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AppInfo } from '../shared/app';
import type { CombinedLimitState } from '../shared/limits';
import type { WidgetSettings } from '../shared/settings';
import type { FleetBridgeView, FleetDoctorResult } from '../shared/fleet-protocol';

interface DiagnosticsInput {
  app: AppInfo;
  settings: WidgetSettings;
  state: CombinedLimitState;
  logPath: string;
  fleet: FleetBridgeView;
  doctors: FleetDoctorResult[];
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
  archive.append(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        app: input.app,
        os: { platform: process.platform, arch: process.arch },
        runtime: process.versions,
        state: input.state,
        fleet: input.fleet,
        doctors: input.doctors
      },
      null,
      2
    )}\n`,
    { name: 'diagnostics.json' }
  );
  archive.append(`${JSON.stringify(input.settings, null, 2)}\n`, { name: 'settings.json' });
  if (existsSync(input.logPath)) archive.file(input.logPath, { name: 'logs/main.log' });
  await archive.finalize();
  await completion;
}
