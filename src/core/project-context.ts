import type { AgentMessage } from './contracts.js';

export interface ProjectContextInput {
  notes?: string;
  messages: AgentMessage[];
  maxCharacters: number;
}

export function buildProjectContext({
  notes = '',
  messages,
  maxCharacters,
}: ProjectContextInput): string {
  if (maxCharacters <= 0) return '';
  const visibleNotes = notes.slice(0, maxCharacters);
  if (visibleNotes.length === maxCharacters) return visibleNotes;

  const selected: string[] = [];
  let remaining = maxCharacters - visibleNotes.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.complete) continue;
    const rendered = `${message.role}: ${message.text}`;
    const separator = visibleNotes || selected.length ? 2 : 0;
    if (rendered.length + separator > remaining) continue;
    selected.unshift(rendered);
    remaining -= rendered.length + separator;
  }
  return [visibleNotes, ...selected].filter(Boolean).join('\n\n');
}
