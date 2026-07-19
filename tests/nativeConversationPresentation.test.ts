import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderConversationRows } from '../src/renderer/src/session-workspace';
import { mergeConversationItems } from '../src/shared/conversation';
import type { ConversationItem } from '../src/shared/conversation';

vi.mock('dompurify', () => ({ default: { sanitize: (value: string) => value } }));

function item(value: Partial<ConversationItem>): ConversationItem {
  return {
    id: 'item-1', kind: 'tool', timestamp: '', role: '', title: '', text: '', detail: '', state: 'complete',
    tool: '', attachments: [], choices: [], ...value
  };
}

describe('native conversation presentation', () => {
  it('consumes the shared structured-work fixture', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'conversation_structured_work_v1.json'), 'utf8'));
    const items = mergeConversationItems([], fixture.items);
    const html = renderConversationRows(items);
    expect(items.map((value) => value.kind)).toEqual(['task_list', 'plan', 'question']);
    expect(html).toContain('Repairing the Native view');
    expect(html).toContain('Open plan');
    expect(html).toContain('Tap an answer to continue');
  });

  it('bounds a huge single-line tool in the feed and opens details separately', () => {
    const command = `pwsh -Command ${'very-long-argument '.repeat(200)}`;
    const html = renderConversationRows([item({
      tool: 'exec', presentation: {
        version: 1, title: 'Run command', subtitle: 'pwsh', previewLines: 12,
        inputBlocks: [{ title: 'Run command', kind: 'code', content: command }], resultBlocks: []
      }
    })]);
    expect(html).toContain('Run command');
    expect(html).toContain('native-open-tool');
    expect(html).not.toContain(command);
    expect(html.length).toBeLessThan(2_500);
  });

  it('renders task checklists and suppresses redundant Done status rows', () => {
    const html = renderConversationRows([
      item({ id: 'tasks', kind: 'task_list', title: 'Updated plan', tasks: [
        { id: 'one', title: 'Finished', activeTitle: '', detail: '', state: 'completed' },
        { id: 'two', title: 'Build UI', activeTitle: 'Building UI', detail: '', state: 'in_progress' }
      ] }),
      item({ id: 'done', kind: 'status', title: 'Done' })
    ]);
    expect(html).toContain('Current work');
    expect(html).toContain('Building UI');
    expect(html).not.toContain('<small>Done</small>');
  });

  it('renders the exact provider work counter even beside structured tasks', () => {
    const html = renderConversationRows([
      item({ id: 'tasks', kind: 'task_list', title: 'Updated plan', tasks: [
        { id: 'one', title: 'Finished', activeTitle: '', detail: '', state: 'completed' }
      ] }),
      item({
        id: 'done', kind: 'status', title: 'Done',
        startedAt: '2026-07-19T00:00:00.143Z', completedAt: '2026-07-19T00:24:44.000Z'
      })
    ]);
    expect(html).toContain('Worked for 24m 43s');
  });

  it('uses tappable choice rows without radio controls or a final submit button', () => {
    const html = renderConversationRows([item({
      kind: 'question', state: 'pending', revision: 'r1', title: 'Answer needed', questions: [{
        id: 'mode', header: 'Mode', prompt: 'Choose a mode', type: 'single', required: true,
        allowOther: false, options: [{ id: 'safe', label: 'Safe', description: 'Recommended' }]
      }]
    })]);
    expect(html).toContain('native-question-choice');
    expect(html).toContain('Tap an answer to continue');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('Submit answers');
  });

  it('keeps local suggestion controls out of ordinary choice questions', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'session-workspace.ts'), 'utf8');
    const stylesheet = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'style.css'), 'utf8');
    expect(source).toContain('canSuggestForQuestion');
    expect(source).toContain('data-action="native-suggestion-use"');
    expect(source).toContain('state.draft = value');
    expect(stylesheet).toContain('textarea[data-native-message]:not(:placeholder-shown)');
  });
});
