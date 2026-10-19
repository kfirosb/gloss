import path from 'node:path';
import { ACTIVITY_RESULT_CHARS } from './activity-contracts.js';
import type { JsonRecord } from './json-record.js';

export { applyActivityEvent, emptyActivity } from './activity-reducer.js';

const SUMMARY_CHARS = 120;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const cut = (text: string): string => text.slice(0, SUMMARY_CHARS);

const stringField = (input: JsonRecord, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

function relativeToCwd(file: string, cwd?: string): string {
  if (!cwd) return file;
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

function fallbackSummary(input: JsonRecord): string {
  const first = Object.values(input).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return first ?? JSON.stringify(input);
}

export function summarizeToolCall(tool: string, input: JsonRecord, cwd?: string): string {
  const summary = (): string => {
    if (tool === 'Bash') {
      const description = stringField(input, 'description');
      if (description) return description;
      const command = stringField(input, 'command') ?? '';
      return command.split('\n').find((line) => line.trim()) ?? '';
    }
    if (FILE_TOOLS.has(tool)) {
      const file = stringField(input, 'file_path');
      if (file) return relativeToCwd(file, cwd);
    }
    if (tool === 'Grep') {
      const pattern = stringField(input, 'pattern');
      if (pattern) {
        const where = stringField(input, 'path');
        return where ? `${pattern} in ${relativeToCwd(where, cwd)}` : pattern;
      }
    }
    const direct: Record<string, string> = {
      Glob: 'pattern',
      Agent: 'description',
      Skill: 'skill',
      WebFetch: 'url',
      WebSearch: 'query',
    };
    const key = direct[tool];
    const value = key ? stringField(input, key) : undefined;
    return value ?? fallbackSummary(input);
  };
  return cut(summary());
}

export function renderToolInput(tool: string, input: JsonRecord): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    return input.command.slice(0, ACTIVITY_RESULT_CHARS);
  }
  return (JSON.stringify(input, null, 2) ?? '').slice(0, ACTIVITY_RESULT_CHARS);
}
