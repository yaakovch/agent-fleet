import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import {
  validateWorkflowActionPins,
  verifyRepositoryPolicy
} from '../scripts/verify-project-policy.mjs';

describe('project quality policy', () => {
  it('keeps repository metadata, licensing, and CI entry points coherent', () => {
    expect(verifyRepositoryPolicy(resolve('.'))).toEqual({
      workflows: 2,
      actions: 12
    });
  });

  it('accepts immutable third-party actions and local actions', () => {
    const source = [
      'steps:',
      '  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6',
      '  - uses: ./actions/setup'
    ].join('\n');
    expect(validateWorkflowActionPins(source, 'fixture.yml')).toBe(2);
  });

  it('rejects mutable tags and abbreviated commits', () => {
    expect(() => validateWorkflowActionPins('steps:\n  - uses: actions/checkout@v6', 'tag.yml'))
      .toThrow(/full 40-character commit SHA/u);
    expect(() => validateWorkflowActionPins('steps:\n  - uses: actions/checkout@df4cb1c', 'short.yml'))
      .toThrow(/full 40-character commit SHA/u);
    expect(() => validateWorkflowActionPins('steps:\n  - uses: docker://alpine:latest', 'container.yml'))
      .toThrow(/immutable sha256 digest/u);
    expect(() => validateWorkflowActionPins('steps:\n  - uses: actions/checkout@v6 unexpected', 'syntax.yml'))
      .toThrow(/cannot be parsed safely/u);
  });
});
