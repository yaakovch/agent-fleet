import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open, rm } from 'node:fs/promises';
import { basename, join, parse } from 'node:path';
import { verifyLocalArtifact } from './fleet-download';

/** Publish verified complete bytes without ever overwriting a Downloads file. */
export async function publishVerifiedCopy(source: string, directory: string, name: string, size: number, sha256: string): Promise<string> {
  if (basename(name) !== name || !name || !await verifyLocalArtifact(source, size, sha256)) throw new Error('Preview failed integrity verification');
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.wtmux-save-${randomUUID()}.part`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    if (!await verifyLocalArtifact(temporary, size, sha256)) throw new Error('Saved file failed integrity verification');
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const parsed = parse(name);
    for (let suffix = 0; suffix < 10_000; suffix++) {
      const destination = join(directory, suffix ? `${parsed.name} (${suffix})${parsed.ext}` : name);
      try { await link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      if (await verifyLocalArtifact(destination, size, sha256)) return destination;
      await rm(destination, { force: true });
      throw new Error('Saved file failed integrity verification');
    }
    throw new Error('No unused Downloads file name is available');
  } finally { await rm(temporary, { force: true }); }
}
