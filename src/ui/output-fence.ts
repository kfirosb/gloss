/** Terminal output as a `text` code block whose fence is longer than any backtick run inside it (at least three). */
export function fencedOutput(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + 'text\n' + text + '\n' + fence + '\n';
}
