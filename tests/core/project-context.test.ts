import { describe, expect, it } from 'vitest';
import { buildProjectContext } from '../../src/core/project-context.js';
import type { AgentMessage } from '../../src/core/contracts.js';

const message = (sourceId: string, text: string, complete = true): AgentMessage => ({
  sourceId,
  revision: 1,
  role: 'assistant',
  text,
  complete,
});

describe('buildProjectContext', () => {
  it('keeps visible notes and the newest complete messages within the character budget', () => {
    expect(
      buildProjectContext({
        notes: 'NOTE',
        messages: [message('1', 'old'), message('2', 'partial', false), message('3', 'new')],
        maxCharacters: 20,
      }),
    ).toBe('NOTE\n\nassistant: new');
  });

  it('truncates oversized notes visibly instead of retaining hidden message context', () => {
    expect(
      buildProjectContext({
        notes: '123456789',
        messages: [message('1', 'old')],
        maxCharacters: 6,
      }),
    ).toBe('123456');
  });
});
