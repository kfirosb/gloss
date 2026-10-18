import { expect, it, vi } from 'vitest';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';
import { emptyActivity } from '../../src/core/activity.js';
import { createWorkflow } from '../../src/core/workflow.js';
import type { ActivityEvent, ActivityTask } from '../../src/core/activity-contracts.js';

const target = { agent: 'claude' as const, sessionRef: 'native', projectId: 'project' };

const task = (kind: ActivityTask['kind'], id: string): ActivityTask => ({
  kind,
  id,
  description: id,
  position: 1,
  depth: 0,
  status: 'running',
});

function setup() {
  const agent = new FakeAgent('claude');
  const language = new FakeLanguageSession();
  const store = new MemoryConversationStore();
  const save = vi.spyOn(store, 'save');
  const putTranslation = vi.spyOn(store, 'putTranslation');
  const translate = vi.spyOn(language, 'translate');
  const workflow = createWorkflow({
    conversationId: 'conv',
    language: 'he',
    languageModel: 'test',
    languageSession: language,
    projectContext: '',
    agents: [agent],
    store,
  });
  const emit = (event: ActivityEvent) => agent.emit({ type: 'activity', event });
  return { agent, language, store, save, putTranslation, translate, workflow, emit };
}

it('folds activity events into snapshot.activity without persisting them', async () => {
  const { workflow, emit, save } = setup();
  try {
    emit({ kind: 'task-start', task: task('background', 'b1') });
    await workflow.connect(target);
    await expect.poll(() => workflow.snapshot().codingState).toBe('idle');
    await expect.poll(() => workflow.snapshot().activity?.tasks.length).toBe(1);
    const savesAfterFirst = save.mock.calls.length;
    emit({
      kind: 'call',
      call: { id: 't1', tool: 'Bash', summary: 's', input: 'i', position: 2, depth: 0 },
    });
    await expect.poll(() => workflow.snapshot().activity?.calls.length).toBe(1);
    expect(workflow.snapshot().activity).toMatchObject({
      running: 1,
      tasks: [{ id: 'b1' }],
      calls: [{ id: 't1' }],
    });
    expect(save).toHaveBeenCalledTimes(savesAfterFirst);
  } finally {
    await workflow.close();
  }
});

it('resets activity on reconnect', async () => {
  const { workflow, emit } = setup();
  try {
    emit({ kind: 'task-start', task: task('background', 'b1') });
    await workflow.connect(target);
    await expect.poll(() => workflow.snapshot().activity?.tasks.length).toBe(1);
    await workflow.connect(target);
    expect(workflow.snapshot().activity).toEqual(emptyActivity());
  } finally {
    await workflow.close();
  }
});

it('translates a finished subagent report on request and caches it', async () => {
  const { workflow, emit, language, translate, putTranslation } = setup();
  language.translationReply = 'הכל טוב.';
  try {
    emit({ kind: 'task-start', task: task('subagent', 'a1') });
    emit({ kind: 'task-end', id: 'a1', status: 'finished', report: 'All good.' });
    await workflow.connect(target);
    await expect.poll(() => workflow.snapshot().activity?.tasks[0]?.report).toBe('All good.');
    await workflow.translateActivityReport('a1');
    await expect
      .poll(() => workflow.snapshot().activity!.tasks[0]!.reportTranslation)
      .toEqual({ text: 'הכל טוב.', status: 'complete' });
    expect(putTranslation).toHaveBeenCalledWith(
      expect.objectContaining({ sourceScope: 'conv:activity', sourceId: 'a1' }),
      'הכל טוב.',
    );
    await workflow.translateActivityReport('a1');
    expect(translate).toHaveBeenCalledTimes(1);
  } finally {
    await workflow.close();
  }
});

it('refuses a report translation when the task has no report', async () => {
  const { workflow } = setup();
  try {
    await workflow.connect(target);
    await expect(workflow.translateActivityReport('missing')).rejects.toThrow(
      'Report unavailable for translation',
    );
  } finally {
    await workflow.close();
  }
});
