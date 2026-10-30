import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseQuestionScreen, questionMessageText } from '../../src/runtime/question-screen.js';

const fixture = (name: string) => readFileSync(`tests/fixtures/screens/${name}`, 'utf8');

describe('parseQuestionScreen', () => {
  it('reads the header, question and real options off the 2.1.314 dialog, not the dialog rows', () => {
    expect(parseQuestionScreen(fixture('claude-2.1.314-question.txt'))).toEqual({
      header: 'Next step',
      question: 'Which would you like to do next in this session?',
      options: [
        {
          label: 'Review recent changes',
          description: 'Look over the latest commits and working tree for issues.',
        },
        {
          label: 'Start a new task',
          description: "Tell me what you want built or fixed and I'll get going.",
        },
      ],
    });
  });
  it('joins wrapped question and description lines and takes the open tab of a multi-question dialog', () => {
    const screen = [
      '❯ earlier prompt',
      ' ☐ Scope  ☐ Priority',
      'What should the mobile task cover, in',
      'one sentence?',
      '❯ 1. Read & reply',
      '     See sessions and read replies, translated, from the',
      '     phone.',
      '  2. Push only',
      '  3. Type something.',
      '────────',
      '  4. Chat about this',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
      '',
    ].join('\n');
    expect(parseQuestionScreen(screen)).toEqual({
      header: 'Scope',
      question: 'What should the mobile task cover, in one sentence?',
      options: [
        {
          label: 'Read & reply',
          description: 'See sessions and read replies, translated, from the phone.',
        },
        { label: 'Push only' },
      ],
    });
  });
  it('is undefined for a permission prompt, an idle screen, or a dialog that scrolled away', () => {
    for (const name of ['claude-2.1.299-permission.txt', 'claude-2.1.299-idle.txt'])
      expect(parseQuestionScreen(fixture(name)), name).toBeUndefined();
    const gone =
      fixture('claude-2.1.314-question.txt') +
      Array.from({ length: 25 }, (_, i) => `  reply line ${i}`).join('\n') +
      '\n❯ \n';
    expect(parseQuestionScreen(gone)).toBeUndefined();
  });
});

it('questionMessageText renders markdown with numbered bold options', () => {
  expect(
    questionMessageText({
      header: 'Color',
      question: 'Which color?',
      options: [{ label: 'Red', description: 'Warm.' }, { label: 'Blue' }],
    }),
  ).toBe('**Color** · Which color?\n\n1. **Red** — Warm.\n2. **Blue**');
  expect(questionMessageText({ question: 'Which?', options: [{ label: 'A' }] })).toBe(
    'Which?\n\n1. **A**',
  );
});
