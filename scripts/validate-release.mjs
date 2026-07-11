import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) throw new Error('A release tag is required');
if (tag !== `v${packageJson.version}`) throw new Error(`Tag ${tag} does not match package version ${packageJson.version}`);
if (packageJson.repository !== 'https://github.com/yaakovch/agent-fleet') throw new Error('Unexpected release repository');
console.log(`Validated ${tag}`);
