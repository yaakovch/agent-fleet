import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConversationFrame, parseConversationProtocolFrame } from '../src/shared/conversation';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', 'contracts', name), 'utf8');

describe('canonical conversation v2 contract', () => {
  it('accepts and round-trips every shared frame family', () => {
    const frames = JSON.parse(fixture('conversation-frames-v2.json')).frames as Array<Record<string, unknown>>;
    expect(new Set(frames.map((frame) => frame.type))).toEqual(new Set([
      'conversation.snapshot', 'conversation.event', 'conversation.status', 'conversation.heartbeat',
      'conversation.error', 'directory.snapshot', 'question.response', 'approval.response'
    ]));
    for (const frame of frames) {
      expect(parseConversationProtocolFrame(JSON.stringify(frame))?.type).toBe(frame.type);
      const unknown = structuredClone(frame); unknown.unexpected = true;
      expect(parseConversationProtocolFrame(JSON.stringify(unknown))).toBeNull();
    }
  });

  it('accepts the shared turn projection fixture', () => {
    const parsed = parseConversationFrame(fixture('conversation-turns-v2.json'));
    expect(parsed?.view).toBe('conversation');
    expect(parsed?.items?.map((item) => item.kind)).toEqual(['message', 'activity', 'message']);
    expect(parsed?.items?.[1].activitySummary?.toolCount).toBe(1);
  });

  it('accepts and round-trips the shared structured-work fixture', () => {
    const parsed = parseConversationFrame(fixture('conversation-structured-work-v2.json'));
    expect(parsed?.type).toBe('conversation.snapshot');
    expect(parsed?.items).toHaveLength(3);
    expect(parseConversationFrame(JSON.stringify(parsed))).not.toBeNull();
  });

  it('replays every provider confidence condition fail-closed', () => {
    const corpus = JSON.parse(fixture('provider-confidence-replay-v1.json')) as {
      cases: Array<{ adapter: string; condition: string; confidence: string; mutationsAllowed: boolean; fallback: string }>;
    };
    for (const adapter of ['codex', 'claude', 'copilot', 'shell']) {
      const cases = corpus.cases.filter((value) => value.adapter === adapter);
      expect(new Set(cases.map((value) => value.condition))).toEqual(new Set([
        'current', 'truncated', 'reordered', 'partial', 'stale', 'mixed_version'
      ]));
      expect(cases.filter((value) => value.confidence !== 'verified')
        .every((value) => !value.mutationsAllowed && value.fallback !== 'none')).toBe(true);
    }
  });

  it.each(['conversation-unknown-field-v2.json', 'conversation-item-unknown-field-v2.json'])(
    'rejects shared invalid fixture %s', (name) => {
      expect(parseConversationFrame(fixture(name))).toBeNull();
    }
  );

  it('rejects over-limit frames and nested collections', () => {
    const baseline = JSON.parse(fixture('conversation-structured-work-v2.json'));
    baseline.items[2].questions[0].options = Array.from({ length: 17 }, (_, index) => ({
      id: `option-${index}`, label: `Option ${index}`, description: ''
    }));
    expect(parseConversationFrame(JSON.stringify(baseline))).toBeNull();
    expect(parseConversationFrame(JSON.stringify({
      protocolVersion: 2, type: 'conversation.error', timestamp: '2026-07-22T12:00:00Z',
      error: { code: 'large', message: 'x'.repeat(256 * 1024) }
    }))).toBeNull();
  });

  it('rejects ambiguous identities and answer references', () => {
    const baseline = JSON.parse(fixture('conversation-structured-work-v2.json'));

    const duplicateItems = structuredClone(baseline);
    duplicateItems.items.push({ ...duplicateItems.items[0], title: 'Conflicting board' });

    const duplicateChoices = structuredClone(baseline);
    duplicateChoices.items[2].choices = [
      { id: 'approve', label: 'Approve' },
      { id: 'approve', label: 'Different label' }
    ];

    const duplicateQuestions = structuredClone(baseline);
    duplicateQuestions.items[2].questions.push({
      ...duplicateQuestions.items[2].questions[0], prompt: 'Different prompt'
    });

    const duplicateOptions = structuredClone(baseline);
    duplicateOptions.items[2].questions[0].options.push({
      ...duplicateOptions.items[2].questions[0].options[0], label: 'Different label'
    });

    const duplicateTasks = structuredClone(baseline);
    duplicateTasks.items[0].tasks.push({ ...duplicateTasks.items[0].tasks[0], title: 'Different task' });

    const invalidAnswer = structuredClone(baseline);
    invalidAnswer.items[2].answers = [{
      questionId: invalidAnswer.items[2].questions[0].id,
      choiceIds: ['unknown-option'],
      text: ''
    }];

    const duplicateAnswers = structuredClone(baseline);
    const questionId = duplicateAnswers.items[2].questions[0].id;
    duplicateAnswers.items[2].answers = [
      { questionId, choiceIds: [], text: 'First' },
      { questionId, choiceIds: [], text: 'Second' }
    ];

    for (const candidate of [
      duplicateItems, duplicateChoices, duplicateQuestions, duplicateOptions,
      duplicateTasks, invalidAnswer, duplicateAnswers
    ]) {
      expect(parseConversationFrame(JSON.stringify(candidate))).toBeNull();
    }
  });
});
