import { expect, it } from 'vitest';
import { runRuntimeCommand } from '../src/main/runtime-command';

it('closes unused input and captures complete Unicode output from a real command', async () => {
  const result = await runRuntimeCommand(process.execPath, ['-e',
    `const fs=require('node:fs');if(fs.readFileSync(0).length)process.exit(2);process.stdout.write('שלום 🚀');process.stderr.write('metadata');`], 5000);
  expect(result).toEqual({ stdout: 'שלום 🚀', stderr: 'metadata' });
});

it('rejects a real stalled command at the deadline', async () => {
  await expect(runRuntimeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100))
    .rejects.toThrow('timed out');
});

it('bounds a failed command report without including its arguments', async () => {
  await expect(runRuntimeCommand(process.execPath, ['-e',
    `process.stderr.write('failure'.repeat(1000));process.exitCode=2;`, 'PRIVATE_ARGUMENT'], 5000))
    .rejects.toSatisfy((error: Error) => error.message.length < 600 && !error.message.includes('PRIVATE_ARGUMENT'));
});
