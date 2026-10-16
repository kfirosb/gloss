import { readFile, stat } from 'node:fs/promises';
import { recordOf } from '../core/json-record.js';
import { join } from 'node:path';
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
import { parseCodexSpend } from '../core/usage.js';
import { codexHomeDir } from '../agents/shared.js';
export { LanguageError } from './shared.js';

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
const disabledFeatures = [
  'shell_tool',
  'unified_exec',
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'hooks',
  'remote_plugin',
  'skill_search',
  'multi_agent_v2',
  'code_mode',
  'code_mode_host',
  'view_image',
  'in_app_browser',
];
function parser(): ResponseParser {
  const seen = new Set<string>();
  let text = '';
  let completed = false;
  return {
    accept(event) {
      if (event.type === 'error' || event.type === 'turn.failed') throw classifyError(event);
      if (event.type === 'turn.completed') completed = true;
      const item = event.type === 'item.completed' ? recordOf(event.item) : undefined;
      if (item?.type !== 'agent_message' || typeof item.text !== 'string') return '';
      if (typeof item.id !== 'string') throw new LanguageError('invalid-output');
      if (seen.has(item.id)) return '';
      seen.add(item.id);
      const delta = (text ? '\n' : '') + item.text;
      text += delta;
      return delta;
    },
    finish() {
      if (!completed) throw new LanguageError('invalid-output');
      return text;
    },
  };
}
export class CodexLanguageBackend implements LanguageBackend {
  private readonly workers: LanguageWorkers;
  private readonly cachePath: string;
  constructor(private readonly options: BackendOptions = {}) {
    this.cachePath = options.cachePath ?? join(codexHomeDir(), 'models_cache.json');
    this.workers = new LanguageWorkers(
      {
        provider: 'codex',
        executable: 'codex',
        parser,
        observe: (event) => {
          const spend = parseCodexSpend(event);
          return spend ? { spend } : undefined;
        },
        args: (model, images = []) => [
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--model',
          model,
          '-c',
          'model_reasoning_effort="low"',
          '-c',
          'agents.enabled=false',
          '-c',
          'web_search="disabled"',
          '-c',
          'skills.include_instructions=false',
          '-c',
          'project_doc_max_bytes=0',
          ...disabledFeatures.flatMap((name) => ['-c', `features.${name}=false`]),
          ...images.flatMap((image) => ['--image', image.path]),
          '--json',
          '-',
        ],
      },
      options,
    );
  }
  async models(): Promise<{ id: string; label: string }[]> {
    try {
      if ((await stat(this.cachePath)).size > 2 * 1024 * 1024) throw new Error();
      const cache = recordOf(JSON.parse(await readFile(this.cachePath, 'utf8')));
      const models: { id: string; label: string }[] = [];
      if (Array.isArray(cache?.models))
        for (const item of cache.models) {
          const model = recordOf(item);
          if (!model || model.visibility === 'hide') continue;
          if (
            typeof model.slug !== 'string' ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(model.slug)
          )
            continue;
          if (!models.some((entry) => entry.id === model.slug))
            models.push({
              id: model.slug,
              label:
                typeof model.display_name === 'string'
                  ? model.display_name.slice(0, 200)
                  : model.slug,
            });
        }
      if (models.length) return models;
    } catch {
      /* Cache is optional; the explicit default was verified with subscription auth. */
    }
    return [
      {
        id: DEFAULT_CODEX_MODEL,
        label: `${DEFAULT_CODEX_MODEL} (default; local model cache unavailable)`,
      },
    ];
  }
  async open(
    model: string = DEFAULT_CODEX_MODEL,
    _resumeId?: string,
    sessionOptions?: SessionOptions,
  ): Promise<LanguageSession> {
    await requireSubscription('codex', this.options);
    return this.workers.session(model, sessionOptions);
  }
}
