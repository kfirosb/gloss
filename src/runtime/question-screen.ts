import { promptRegion } from './attention-markers.js';

/** Claude's AskUserQuestion dialog as read from the terminal screen. */
export interface TerminalQuestion {
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
}

// Captured from tests/fixtures/screens/claude-2.1.314-question.txt: a checkbox header, the question, numbered
// options with an indented description each, then the dialog's own rows and its key help.
const FOOTER = /^\s*Enter to select · ↑\/↓ to navigate · Esc to cancel\s*$/;
const HEADER = /^\s*[☐☑]\s*(.*)$/;
const OPTION = /^\s*(?:❯\s*)?\d+\.\s+(.+?)\s*$/;
const SEPARATOR = /^\s*─+\s*$/;
/** Rows the dialog adds itself; they are the terminal's affordances, not Claude's options. */
const DIALOG_ROWS = [/^Type something\.?$/, /^Chat about this$/];

/** The open question at the bottom of a Claude screen, or undefined when no question dialog is showing. */
export function parseQuestionScreen(screen: string): TerminalQuestion | undefined {
  const lines = promptRegion(screen).split('\n');
  const footer = lines.findLastIndex((line) => FOOTER.test(line));
  if (footer < 0) return undefined;
  const header = lines.slice(0, footer).findLastIndex((line) => HEADER.test(line));
  if (header < 0) return undefined;
  // A multi-question dialog shows one checkbox per question on the header row; the first unanswered one is open.
  const title = HEADER.exec(lines[header]!)![1]!
    .split(/\s*[☐☑]\s*/)[0]!
    .trim();
  const questionLines: string[] = [];
  const options: { label: string; description?: string }[] = [];
  for (const line of lines.slice(header + 1, footer)) {
    if (SEPARATOR.test(line)) continue;
    const option = OPTION.exec(line);
    if (option) {
      options.push({ label: option[1]! });
      continue;
    }
    const text = line.trim();
    if (!text) continue;
    const last = options.at(-1);
    if (!last) questionLines.push(text);
    else last.description = last.description ? `${last.description} ${text}` : text;
  }
  const question = questionLines.join(' ');
  const asked = options.filter((o) => !DIALOG_ROWS.some((row) => row.test(o.label)));
  if (!question || !asked.length) return undefined;
  return { ...(title ? { header: title } : {}), question, options: asked };
}

/** The question as conversation text, so it is shown and translated like any assistant message. */
export function questionMessageText(question: TerminalQuestion): string {
  const title = (question.header ? `**${question.header}** · ` : '') + question.question;
  const options = question.options.map(
    (o, i) => `${i + 1}. **${o.label}**${o.description ? ` — ${o.description}` : ''}`,
  );
  return `${title}\n\n${options.join('\n')}`;
}
