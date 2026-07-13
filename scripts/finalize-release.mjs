import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');
const distDir = resolve(process.argv[2] ?? 'dist');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const files = readdirSync(distDir);
const setupName = files.find((name) => /^Agent-Fleet-.*-Setup-x64\.exe$/.test(name));
if (!setupName) throw new Error(`No Setup x64 executable found in ${distDir}`);
const setupPath = join(distDir, setupName);
const blockmapName = `${setupName}.blockmap`;
await buildBlockMap(setupPath, 'gzip', join(distDir, blockmapName));
const sha512 = await hashFile(setupPath, 'sha512', 'base64');
const latest = [
  `version: ${packageJson.version}`,
  'files:',
  `  - url: ${setupName}`,
  `    sha512: ${sha512}`,
  `    size: ${statSync(setupPath).size}`,
  `path: ${setupName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n');
writeFileSync(join(distDir, 'latest.yml'), latest, 'utf8');

const checksumFiles = readdirSync(distDir)
  .filter((name) => /\.(exe|blockmap|json|yml)$/.test(name) && !/^builder-/.test(name))
  .sort();
const checksums = [];
for (const name of checksumFiles) checksums.push(`${await hashFile(join(distDir, name), 'sha256', 'hex')}  ${name}`);
writeFileSync(join(distDir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');
console.log(`Finalized ${basename(setupPath)} and ${checksumFiles.length} checksums`);

function hashFile(path, algorithm, encoding) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest(encoding)));
  });
}
