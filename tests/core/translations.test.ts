import { describe, expect, it } from 'vitest';
import { translateMessage, translateMessageResult } from '../../src/core/translations.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { MemoryConversationStore } from '../helpers/memory-store.js';

describe('translateMessage', () => {
  it('caches complete messages and edits use a new content hash', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translationReply = 'תרגום';
    const input = {
      sourceScope: 'project/session',
      sourceId: 'message-1',
      sourceRevision: 1,
      text: 'Original',
      complete: true,
      language: 'he',
      model: 'm1',
      promptVersion: 'v1',
    };
    expect(await translateMessage(input, { store, session })).toBe('תרגום');
    expect(await translateMessage(input, { store, session })).toBe('תרגום');
    expect(
      await translateMessage({ ...input, text: 'Edited', sourceRevision: 2 }, { store, session }),
    ).toBe('תרגום');
    expect(session.translated).toHaveLength(2);
  });

  it('returns the original for incomplete updates and translation failures', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translationError = new Error('offline');
    const input = {
      sourceScope: 'p/s',
      sourceId: 'message-1',
      sourceRevision: 1,
      text: 'Still arriving',
      complete: false,
      language: 'he',
      model: 'm1',
      promptVersion: 'v1',
    };
    expect(await translateMessage(input, { store, session })).toBe('Still arriving');
    expect(await translateMessage({ ...input, complete: true }, { store, session })).toBe(
      'Still arriving',
    );
  });

  it('preserves code fences, inline code, URLs, and paths through Hebrew translation', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = (text) => `עברית ${text}`;
    const original =
      'Run `npm test` in ./src/app.ts, inspect /var/log/app.log and https://example.com/x.\n```ts\nconst x = 1;\n```';
    const translated = await translateMessage(
      {
        sourceScope: 'p/s',
        sourceId: 'm',
        sourceRevision: 1,
        text: original,
        complete: true,
        language: 'he',
        model: 'm1',
        promptVersion: 'v1',
      },
      { store, session },
    );
    for (const literal of [
      '`npm test`',
      './src/app.ts',
      '/var/log/app.log',
      'https://example.com/x',
      '```ts\nconst x = 1;\n```',
    ]) {
      expect(translated).toContain(literal);
    }
  });

  it('preserves quoted, escaped-space, and UNC paths exactly', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = (text) =>
      `מתורגם ${text}`
        .replaceAll('Program', 'BROKEN')
        .replaceAll('Files', 'BROKEN')
        .replaceAll('Hebrow', 'BROKEN')
        .replaceAll('My', 'BROKEN')
        .replaceAll('File', 'BROKEN')
        .replaceAll('Team', 'BROKEN')
        .replaceAll('Folder', 'BROKEN');
    const literals = [
      '"C:\\Program Files\\Hebrow\\config.json"',
      './docs/My\\ File.md',
      '\\\\server\\share\\Team Folder\\plan.md',
    ];
    const original = `Open ${literals[0]} and ${literals[1]}.\nCopy ${literals[2]}`;
    const translated = await translateMessage(
      {
        sourceScope: 'p/s',
        sourceId: 'paths',
        sourceRevision: 1,
        text: original,
        complete: true,
        language: 'he',
        model: 'm1',
        promptVersion: 'v1',
      },
      { store, session },
    );
    for (const literal of literals) expect(translated).toContain(literal);
  });

  it('stops Windows path protection at a filename extension so prose is translated', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = (text) => text.replace('explain the failure', 'הסבר את התקלה');
    const original = 'Open C:\\tmp\\a.txt and explain the failure';
    const translated = await translateMessage(
      {
        sourceScope: 'p/s',
        sourceId: 'boundary',
        sourceRevision: 1,
        text: original,
        complete: true,
        language: 'he',
        model: 'm1',
        promptVersion: 'v1',
      },
      { store, session },
    );
    expect(translated).toContain('C:\\tmp\\a.txt');
    expect(translated).toContain('הסבר את התקלה');
  });

  it('protects every extension component in quoted and unquoted multi-dot paths', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = (text) =>
      text
        .replaceAll('.ts', '.BROKEN')
        .replaceAll('.gz', '.BROKEN')
        .replaceAll('explain', 'הסבר')
        .replaceAll('inspect', 'בדוק');
    const paths = [
      'C:\\tmp\\vite.config.ts',
      '/tmp/archive.tar.gz',
      '"C:\\Program Files\\app.config.ts"',
    ];
    const original = `Open ${paths[0]} and explain; inspect ${paths[1]} and ${paths[2]}`;
    const translated = await translateMessage(
      {
        sourceScope: 'p/s',
        sourceId: 'multi-dot',
        sourceRevision: 1,
        text: original,
        complete: true,
        language: 'he',
        model: 'm1',
        promptVersion: 'v1',
      },
      { store, session },
    );
    for (const path of paths) expect(translated).toContain(path);
    expect(translated).toContain('הסבר');
    expect(translated).toContain('בדוק');
    expect(translated).not.toContain('BROKEN');
  });

  it('returns the original when a translator corrupts a protected placeholder', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = () => 'תרגום ללא placeholder';
    const original = 'Run `npm test`.';
    expect(
      await translateMessage(
        {
          sourceScope: 'p/s',
          sourceId: 'm',
          sourceRevision: 1,
          text: original,
          complete: true,
          language: 'he',
          model: 'm1',
          promptVersion: 'v1',
        },
        { store, session },
      ),
    ).toBe(original);
  });
});

it('keeps English product terminology intact while translating surrounding prose', async () => {
  const store = new MemoryConversationStore();
  const session = new FakeLanguageSession();
  session.translateTransform = (text) =>
    text
      .replace(
        'Size controls for the',
        '\u05d1\u05e7\u05e8\u05d9 \u05d2\u05d5\u05d3\u05dc \u05e2\u05d1\u05d5\u05e8',
      )
      .replace(
        /Queue|Live Conversation|Language Assistant|Markdown|code blocks|Copy code|layout|refresh/g,
        'WRONG',
      );
  const original =
    'Size controls for the Queue: Live Conversation, Language Assistant, Markdown, code blocks, Copy code, layout, refresh.';
  const translated = await translateMessage(
    {
      sourceScope: 'style',
      sourceId: 'm',
      sourceRevision: 1,
      text: original,
      complete: true,
      language: 'he',
      model: 'test',
      promptVersion: 'style-v2',
    },
    { store, session },
  );
  expect(translated).toContain(
    '\u05d1\u05e7\u05e8\u05d9 \u05d2\u05d5\u05d3\u05dc \u05e2\u05d1\u05d5\u05e8 Queue',
  );
  for (const term of [
    'Live Conversation',
    'Language Assistant',
    'Markdown',
    'code blocks',
    'Copy code',
    'layout',
    'refresh',
  ])
    expect(translated).toContain(term);
  expect(translated).not.toContain('WRONG');
});

it('keeps English product terminology intact for non-Hebrew languages', async () => {
  const store = new MemoryConversationStore();
  const session = new FakeLanguageSession();
  session.translateTransform = (text) =>
    text
      .replace('Size controls for the', 'pour les commandes de taille')
      .replace(
        /Queue|Live Conversation|Language Assistant|Markdown|code blocks|Copy code|layout|refresh/g,
        'WRONG',
      );
  const original =
    'Size controls for the Queue: Live Conversation, Language Assistant, Markdown, code blocks, Copy code, layout, refresh.';
  const translated = await translateMessage(
    {
      sourceScope: 'style-fr',
      sourceId: 'm',
      sourceRevision: 1,
      text: original,
      complete: true,
      language: 'fr',
      promptLanguage: 'French',
      model: 'test',
      promptVersion: 'style-v2',
    },
    { store, session },
  );
  expect(translated).toContain('pour les commandes de taille');
  for (const term of [
    'Live Conversation',
    'Language Assistant',
    'Markdown',
    'code blocks',
    'Copy code',
    'layout',
    'refresh',
  ])
    expect(translated).toContain(term);
  expect(translated).not.toContain('WRONG');
});

describe('translation placeholders', () => {
  const request = (text: string, sourceId = 'm') => ({
    sourceScope: 'p/s',
    sourceId,
    sourceRevision: 1,
    text,
    complete: true,
    language: 'he',
    model: 'm1',
    promptVersion: 'v1',
  });
  const markers = (text: string) => text.match(/⟪LITERAL_\d+⟫/g) ?? [];

  it('translates a reply that itself quotes placeholder text (regression: replies about the marker bug always failed)', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = (text) =>
      text.replace(
        'The translation instructions mention special markers to preserve',
        'הוראות התרגום מזכירות סמנים מיוחדים',
      );
    const original =
      'The translation instructions mention special markers to preserve (`⟪LITERAL_0⟫` etc.). A bare ⟪LITERAL_1⟫ too, and `npm test`.';
    const result = await translateMessageResult(request(original), { store, session });
    expect(result.status).toBe('complete');
    expect(result.text).toContain('הוראות התרגום מזכירות סמנים מיוחדים');
    for (const literal of ['`⟪LITERAL_0⟫`', '⟪LITERAL_1⟫', '`npm test`'])
      expect(result.text).toContain(literal);
  });

  it('retries once when the model drops a placeholder, and uses the second translation', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    let calls = 0;
    session.translateTransform = (text) => {
      calls++;
      const [first] = markers(text);
      return calls === 1 ? 'תרגום ' + text.replace(first!, '') : 'תרגום ' + text;
    };
    const result = await translateMessageResult(
      request('Then `$` it is: `/` opens skills and `$` opens MCP.'),
      { store, session },
    );
    expect(result).toEqual({
      status: 'complete',
      text: 'תרגום Then `$` it is: `/` opens skills and `$` opens MCP.',
    });
    expect(session.translated).toHaveLength(2);
  });

  it('gives up after the retry and keeps the original', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = (text) => text.replace(markers(text)[0]!, '');
    const original = 'Run `npm test` and `npm run build`.';
    expect(await translateMessageResult(request(original), { store, session })).toEqual({
      status: 'error',
      text: original,
    });
    expect(session.translated).toHaveLength(2);
  });

  it('rejects a duplicated or invented placeholder', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translateTransform = (text) => text + ' ' + markers(text)[0];
    expect(
      (await translateMessageResult(request('Run `npm test`.', 'dup'), { store, session })).status,
    ).toBe('error');
    session.translateTransform = (text) => text + ' ⟪LITERAL_9⟫';
    expect(
      (await translateMessageResult(request('Run `npm test`.', 'invented'), { store, session }))
        .status,
    ).toBe('error');
  });

  it('does not retry when the session itself fails', async () => {
    const store = new MemoryConversationStore();
    const session = new FakeLanguageSession();
    session.translationError = new Error('offline');
    expect(
      (await translateMessageResult(request('Run `npm test`.'), { store, session })).status,
    ).toBe('error');
    expect(session.translated).toHaveLength(1);
  });
});
