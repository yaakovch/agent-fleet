import { describe, expect, it } from 'vitest';
import { mergeConversationItems, resolveConversationScroll, type ConversationItem } from '../src/shared/conversation';

function item(value: Partial<ConversationItem>): ConversationItem {
  return {
    id: 'call-1', kind: 'tool', timestamp: '2026-07-14T06:00:00Z', role: 'activity',
    title: '', text: '', detail: '', state: 'running', tool: 'exec_command', attachments: [], choices: [],
    ...value
  };
}

describe('conversation lifecycle model', () => {
  it('keeps semantic start input when a generic completion arrives', () => {
    const start = item({
      input: '{"cmd":"npm test"}', startedAt: '2026-07-14T06:00:00Z',
      presentation: {
        version: 1, title: 'Run command', subtitle: 'npm test', previewLines: 12,
        inputBlocks: [{ title: 'Cmd', kind: 'code', content: 'npm test' }], resultBlocks: []
      }
    });
    const completion = item({
      state: 'complete', input: '', result: '18 tests passed', completedAt: '2026-07-14T06:00:02Z',
      presentation: {
        version: 1, title: 'Tool', subtitle: '', previewLines: 12, inputBlocks: [],
        resultBlocks: [{ title: 'Output', kind: 'terminal', content: '18 tests passed' }]
      }
    });
    const merged = mergeConversationItems([start], [completion])[0];
    expect(merged.state).toBe('complete');
    expect(merged.presentation?.title).toBe('Run command');
    expect(merged.presentation?.subtitle).toBe('npm test');
    expect(merged.presentation?.inputBlocks[0].content).toBe('npm test');
    expect(merged.presentation?.resultBlocks[0].content).toBe('18 tests passed');
    expect(merged.startedAt).toBe(start.startedAt);
    expect(merged.completedAt).toBe(completion.completedAt);
  });

  it('preserves draft question answers across pending updates', () => {
    const pending = item({ kind: 'question', revision: 'revision-1', questions: [{
      id: 'q1', header: 'Mode', prompt: 'Choose', type: 'single', required: true,
      allowOther: false, options: [{ id: 'safe', label: 'Safe', description: '' }]
    }], answers: [{ questionId: 'q1', choiceIds: ['safe'], text: '' }] });
    const updated = item({ kind: 'question', revision: 'revision-2', questions: [] });
    expect(mergeConversationItems([pending], [updated])[0].answers).toEqual(pending.answers);
  });

  it('anchors prepended history and follows appends only from the bottom', () => {
    expect(resolveConversationScroll('prepend', 300, 1_000, 1_600, false)).toBe(900);
    expect(resolveConversationScroll('append', 300, 1_000, 1_200, false)).toBe(300);
    expect(resolveConversationScroll('append', 760, 1_000, 1_200, true)).toBe(1_200);
  });

  it('replaces Codex task boards and merges Claude task patches', () => {
    const board = item({ kind: 'task_list', id: 'tasks-1', updateMode: 'replace', tasks: [
      { id: 'one', title: 'First', activeTitle: 'Doing first', detail: 'Details', state: 'in_progress' },
      { id: 'two', title: 'Second', activeTitle: '', detail: '', state: 'pending' }
    ] });
    const patch = item({ kind: 'task_list', id: 'tasks-1', updateMode: 'merge', tasks: [
      { id: 'one', title: '', activeTitle: '', detail: '', state: 'completed' }
    ] });
    const merged = mergeConversationItems([board], [patch])[0];
    expect(merged.tasks).toEqual([
      { id: 'one', title: 'First', activeTitle: 'Doing first', detail: 'Details', state: 'completed' },
      { id: 'two', title: 'Second', activeTitle: '', detail: '', state: 'pending' }
    ]);
    const replacement = item({ kind: 'task_list', id: 'tasks-1', updateMode: 'replace', tasks: [
      { id: 'three', title: 'Only', activeTitle: '', detail: '', state: 'pending' }
    ] });
    expect(mergeConversationItems([merged], [replacement])[0].tasks?.map((task) => task.id)).toEqual(['three']);
  });
});
