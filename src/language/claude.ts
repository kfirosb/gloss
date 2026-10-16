import { readFile } from 'node:fs/promises';
import { recordOf, textBlocks } from '../core/json-record.js';
import type { LanguageBackend, LanguageSession } from '../core/contracts.js';
import {
  classifyError,
  LanguageError,
  LanguageWorkers,
  requireSubscription,
  type BackendOptions,
  type ResponseParser,
  type SessionOptions,
} from './shared.js';
import { parseClaudeRateLimit, parseClaudeSpend } from '../core/usage.js';
export { LanguageError } from './shared.js';

export const DEFAULT_CLAUDE_MODEL = 'haiku';
function parser(): ResponseParser {
  let streamed = '';
  let assistant = '';
  let final: string | undefined;
  return {
    accept(event) {
      if (
        event.type === 'error' ||
        (event.type === 'result' && (event.is_error || event.subtype !== 'success'))
      )
        throw classifyError(event);
      const streamEvent = recordOf(event.event);
      const delta =
        event.type === 'stream_event' && streamEvent?.type === 'content_block_delta'
          ? recordOf(streamEvent.delta)
          : undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        streamed += delta.text;
        return delta.text;
      }
      const message = recordOf(event.message);
      if (event.type === 'assistant' && Array.isArray(message?.content))
        assistant = textBlocks(message.content).join('');
      if (event.type === 'result' && typeof event.result === 'string') final = event.result;
      return '';
    },
    finish() {
      if (final === undefined) throw new LanguageError('invalid-output');
      return final || streamed || assistant;
    },
  };
}
export class ClaudeLanguageBackend implements LanguageBackend {
  private readonly workers: LanguageWorkers;
  constructor(private readonly options: BackendOptions = {}) {
    this.workers = new LanguageWorkers(
      {
        provider: 'claude',
        executable: 'claude',
        parser,
        observe: (event, at) => ({
          ...(parseClaudeRateLimit(event, at) ? { usage: parseClaudeRateLimit(event, at)! } : {}),
          ...(parseClaudeSpend(event) ? { spend: parseClaudeSpend(event)! } : {}),
        }),
        args: (model, images = []) => [
          '--safe-mode',
          '-p',
          '--model',
          model,
          '--tools',
          '',
          '--no-session-persistence',
          ...(images.length ? ['--input-format', 'stream-json'] : []),
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
        ],
        async input(prompt, images) {
          if (!images.length) return prompt;
          const content = [
            { type: 'text', text: prompt },
            ...(await Promise.all(
              images.map(async (image) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mime,
                  data: (await readFile(image.path)).toString('base64'),
                },
              })),
            )),
          ];
          return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
        },
      },
      options,
    );
  }
  async models() {
    // Documented CLI aliases, not a claim that every subscription has access.
    return ['haiku', 'sonnet', 'opus'].map((id) => ({
      id,
      label: `${id} (CLI alias; account access checked on use)`,
    }));
  }
  async open(
    model: string = DEFAULT_CLAUDE_MODEL,
    _resumeId?: string,
    sessionOptions?: SessionOptions,
  ): Promise<LanguageSession> {
    await requireSubscription('claude', this.options);
    return this.workers.session(model, sessionOptions);
  }
  /** A one-word call on the cheapest model: the CLI answers it with the account's current rate-limit windows. */
  async refreshUsage(signal: AbortSignal): Promise<void> {
    const session = this.workers.session(DEFAULT_CLAUDE_MODEL, { scope: 'usage-probe' });
    try {
      await session.raw('Reply with the single word OK.', signal);
    } finally {
      await session.close();
    }
  }
}
