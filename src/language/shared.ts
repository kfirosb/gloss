import { MAX_TEXT_CHARS } from '../core/content-policy.js';
import { recordOf, type JsonRecord } from '../core/json-record.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentKind,
  LanguageInput,
  LanguageSession,
  ImageAttachment,
} from '../core/contracts.js';
import type { ProviderUsage, Spend } from '../core/usage.js';
import {
  collectProcess,
  runProcess,
  type ProcessOutcome,
  type ProcessRunner,
} from '../runtime/process-runner.js';
import {
  DISCUSSION_WINDOW,
  discussionPrompt,
  preparationPrompt,
  translationPrompt,
  summaryPrompt,
} from './prompts.js';

export type LanguageErrorCode =
  | 'login-required'
  | 'quota-exhausted'
  | 'model-unavailable'
  | 'invalid-output'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'output-limit'
  | 'unavailable'
  | 'busy'
  | 'closed';
const messages: Record<LanguageErrorCode, string> = {
  'login-required': 'Sign in to the selected CLI with your existing account.',
  'quota-exhausted': 'The selected account has reached a usage limit.',
  'model-unavailable': 'The selected model is unavailable for this account.',
  'invalid-output': 'The language provider returned an invalid response.',
  failed: 'The language provider could not complete the request.',
  cancelled: 'The language request was cancelled.',
  timeout: 'The language request timed out.',
  'output-limit': 'The language response exceeded the size limit.',
  unavailable: 'The selected language CLI is unavailable.',
  busy: 'The language provider is busy. Try again shortly.',
  closed: 'The language session is closed.',
};
export class LanguageError extends Error {
  constructor(readonly code: LanguageErrorCode) {
    super(messages[code]);
    this.name = 'LanguageError';
  }
}
/** Accept structured output even when a CLI wraps it in a Markdown fence or short prose. */
export function parseStructuredObject(text: string): JsonRecord {
  const candidates = [text.trim(), text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? ''];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = recordOf(JSON.parse(candidate.trim()));
      if (value) return value;
    } catch {
      /* Try the next bounded representation. */
    }
  }
  throw new LanguageError('invalid-output');
}
export function classifyError(value: unknown): LanguageError {
  const text = (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    .slice(0, 16_384)
    .toLowerCase();
  if (
    /authentication|unauthorized|not.?logged.?in|login.required|invalid.api.key|token.expired|401/.test(
      text,
    )
  )
    return new LanguageError('login-required');
  if (/quota|rate.limit|usage.limit|insufficient_quota|429|credit.balance/.test(text))
    return new LanguageError('quota-exhausted');
  if (
    /model.not.found|model.*(?:unavailable|not.supported|not.exist|access|permission)|unsupported.model/.test(
      text,
    )
  )
    return new LanguageError('model-unavailable');
  return new LanguageError('failed');
}
export function workerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      /^(SUPERSET_|CLAUDE_CODE_MESSAGING_|CODEX_(THREAD|SESSION)_ID$|CLAUDE_(CODE_)?SESSION_ID$)/.test(
        key,
      )
    )
      continue;
    if (
      /^(OPENAI_|ANTHROPIC_)/.test(key) ||
      /^(CLAUDECODE|CODEX_API_KEY|CODEX_ACCESS_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/.test(
        key,
      )
    )
      continue;
    env[key] = value;
  }
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}
/** Receives what each language call reveals about the account: its quota windows and what the call cost. */
export interface LanguageObserver {
  usage(usage: ProviderUsage): void;
  spend(entry: { provider: AgentKind; model: string; scope: string; spend: Spend }): void;
}
export interface BackendOptions {
  runner?: ProcessRunner;
  executable?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  cachePath?: string;
  observer?: LanguageObserver;
  now?: () => number;
}
export interface SessionOptions {
  scope?: string;
}
export interface ResponseParser {
  accept(event: JsonRecord): string;
  finish(): string;
}
export interface ProviderSpec {
  provider: AgentKind;
  executable: string;
  args(model: string, images?: ImageAttachment[]): string[];
  input?(prompt: string, images: ImageAttachment[]): Promise<string>;
  parser(): ResponseParser;
  observe?(
    event: JsonRecord,
    observedAt: number,
  ): { usage?: ProviderUsage; spend?: Spend } | undefined;
}

export async function requireSubscription(
  provider: 'claude' | 'codex',
  options: BackendOptions,
): Promise<void> {
  let cwd: string | undefined;
  try {
    cwd = await mkdtemp(join(tmpdir(), 'language-auth-'));
    const result = await collectProcess(
      (options.runner ?? runProcess)(
        options.executable ?? provider,
        provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'],
        '',
        new AbortController().signal,
        { cwd, env: workerEnvironment(), timeoutMs: 10_000, maxOutputBytes: 16_384 },
      ),
    );
    if (result.outcome.reason === 'spawn-error') throw new LanguageError('unavailable');
    if (result.outcome.reason === 'timeout') throw new LanguageError('timeout');
    if (result.outcome.code !== 0 || result.outcome.reason !== 'exited')
      throw new LanguageError('login-required');
    if (provider === 'claude') {
      const auth = recordOf(JSON.parse(result.lines.join('\n')));
      if (
        auth?.loggedIn !== true ||
        auth.authMethod !== 'claude.ai' ||
        auth.apiProvider !== 'firstParty'
      )
        throw new LanguageError('login-required');
    } else if (
      !`${result.lines.join('\n')}\n${result.outcome.diagnostics}`
        .split(/\r?\n/)
        .some((line) => line.trim() === 'Logged in using ChatGPT')
    )
      throw new LanguageError('login-required');
  } catch (error) {
    throw error instanceof LanguageError ? error : new LanguageError('login-required');
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** One shared bound per backend, including all its logical language sessions. */
export class LanguageWorkers {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly spec: ProviderSpec,
    private readonly options: BackendOptions,
  ) {}
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new LanguageError('cancelled'));
    if (this.active < (this.options.maxConcurrent ?? 2)) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const admit = () => {
        signal.removeEventListener('abort', cancel);
        this.active++;
        resolve();
      };
      const cancel = () => {
        const index = this.waiting.indexOf(admit);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(new LanguageError('cancelled'));
      };
      this.waiting.push(admit);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  private release() {
    this.active--;
    this.waiting.shift()?.();
  }
  session(
    model: string,
    sessionOptions: SessionOptions = {},
  ): LanguageSession & { raw(prompt: string, signal: AbortSignal): Promise<string> } {
    const scope = sessionOptions.scope ?? 'unscoped';
    if (!model.trim() || model.length > 200 || /[\x00-\x1f]/.test(model))
      throw new LanguageError('model-unavailable');
    const controllers = new Set<AbortController>();
    let closed = false;
    const workers = this;
    async function* request(
      prompt: string,
      signal: AbortSignal,
      images: ImageAttachment[] = [],
    ): AsyncGenerator<{ delta: string } | { final: string }> {
      if (closed) throw new LanguageError('closed');
      if (signal.aborted) throw new LanguageError('cancelled');
      if (prompt.length > 240_000) throw new LanguageError('output-limit');
      const controller = new AbortController();
      controllers.add(controller);
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      let cwd: string | undefined;
      let admitted = false;
      try {
        await workers.acquire(controller.signal);
        admitted = true;
        if (controller.signal.aborted) throw new LanguageError('cancelled');
        cwd = await mkdtemp(join(tmpdir(), 'language-worker-'));
        const parser = workers.spec.parser();
        const runner = workers.options.runner ?? runProcess;
        let outcome: ProcessOutcome | undefined;
        const input = workers.spec.input ? await workers.spec.input(prompt, images) : prompt;
        if (controller.signal.aborted) throw new LanguageError('cancelled');
        for await (const event of runner(
          workers.options.executable ?? workers.spec.executable,
          workers.spec.args(model, images),
          input,
          controller.signal,
          {
            cwd,
            env: workerEnvironment(),
            timeoutMs: workers.options.timeoutMs ?? 90_000,
          },
        )) {
          if (controller.signal.aborted) throw new LanguageError('cancelled');
          if (event.type === 'exit') {
            outcome = event.outcome;
            break;
          }
          if (!event.line.trim()) continue;
          let data: JsonRecord | undefined;
          try {
            data = recordOf(JSON.parse(event.line));
          } catch {
            throw new LanguageError('invalid-output');
          }
          if (!data) throw new LanguageError('invalid-output');
          const observed =
            workers.options.observer &&
            workers.spec.observe?.(data, (workers.options.now ?? Date.now)());
          if (observed?.usage) workers.options.observer!.usage(observed.usage);
          if (observed?.spend)
            workers.options.observer!.spend({
              provider: workers.spec.provider,
              model,
              scope,
              spend: observed.spend,
            });
          const delta = parser.accept(data);
          if (delta) yield { delta };
        }
        if (!outcome) throw new LanguageError('failed');
        if (outcome.reason !== 'exited')
          throw new LanguageError(
            outcome.reason === 'spawn-error' ? 'unavailable' : outcome.reason,
          );
        if (outcome.code !== 0) throw classifyError(outcome.diagnostics);
        const final = parser.finish();
        if (!final.trim()) throw new LanguageError('invalid-output');
        yield { final };
      } catch (error) {
        throw error instanceof LanguageError ? error : new LanguageError('failed');
      } finally {
        controller.abort();
        signal.removeEventListener('abort', abort);
        controllers.delete(controller);
        if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
        if (admitted) workers.release();
      }
    }
    async function complete(
      prompt: string,
      signal: AbortSignal,
      images: ImageAttachment[] = [],
    ): Promise<string> {
      let final = '';
      for await (const item of request(prompt, signal, images))
        if ('final' in item) final = item.final;
      return final;
    }
    return {
      id: `language-${randomUUID()}`,
      raw: (prompt, signal) => complete(prompt, signal),
      async *discuss(input: LanguageInput, signal: AbortSignal) {
        let emitted = false;
        for await (const item of request(discussionPrompt(input), signal, inputImages(input))) {
          if ('delta' in item) {
            emitted = true;
            yield item.delta;
          } else if (!emitted) yield item.final;
        }
      },
      async prepare(input, signal) {
        const text = await complete(preparationPrompt(input), signal, inputImages(input));
        let value: JsonRecord;
        try {
          value = parseStructuredObject(text);
        } catch {
          throw new LanguageError('invalid-output');
        }
        if (
          Object.keys(value).length !== 2 ||
          typeof value.localizedText !== 'string' ||
          !value.localizedText.trim() ||
          typeof value.englishText !== 'string' ||
          !value.englishText.trim()
        )
          throw new LanguageError('invalid-output');
        return { localizedText: value.localizedText, englishText: value.englishText };
      },
      translate(text, language, signal) {
        return complete(translationPrompt(text, language), signal);
      },
      async summarize(text, language, signal) {
        if (!text.trim() || text.length > MAX_TEXT_CHARS) throw new LanguageError('output-limit');
        const result = (await complete(summaryPrompt(text, language), signal)).trim();
        if (!result || result.length > 4000) throw new LanguageError('invalid-output');
        return result;
      },
      async resetContext() {
        for (const controller of controllers) controller.abort();
      },
      async close() {
        closed = true;
        for (const controller of controllers) controller.abort();
      },
    };
  }
}

function inputImages(input: LanguageInput): ImageAttachment[] {
  return [
    ...new Map(
      (input.selectedDiscussion ?? input.discussion.slice(-DISCUSSION_WINDOW))
        .flatMap((t) => t.attachments ?? [])
        .filter((a): a is ImageAttachment => a.kind !== 'file')
        .map((a) => [a.id, a]),
    ).values(),
  ];
}
