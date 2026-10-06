import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishVerifiedCopy } from '../src/main/host-file-save';

describe('private preview publication', () => {
  it('preserves existing Downloads and publishes independent verified bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-preview-test-'));
    try {
      const source = join(root, 'private.txt'); const downloads = join(root, 'Downloads');
      const bytes = Buffer.from('verified bytes\n'); const digest = createHash('sha256').update(bytes).digest('hex');
      await writeFile(source, bytes);
      const first = await publishVerifiedCopy(source, downloads, 'report.txt', bytes.length, digest);
      const second = await publishVerifiedCopy(source, downloads, 'report.txt', bytes.length, digest);
      expect(first).toBe(join(downloads, 'report.txt')); expect(second).toBe(join(downloads, 'report (1).txt'));
      await writeFile(source, 'replaced private file');
      expect(await readFile(first)).toEqual(bytes); expect(await readFile(second)).toEqual(bytes);
      await expect(publishVerifiedCopy(source, downloads, 'report.txt', bytes.length, digest)).rejects.toThrow();
      expect(await readdir(downloads)).toEqual(['report (1).txt', 'report.txt']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
