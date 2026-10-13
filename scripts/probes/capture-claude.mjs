// SessionStart hook for a disposable test session; never use on an unrelated session.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const output = process.argv[2];
if (!output) throw new Error('Pass a private scratch output path');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) throw new Error('Hook input too large');
}
const event = JSON.parse(input);
writeFileSync(resolve(output), JSON.stringify({
  session_id: event.session_id, transcript_path: event.transcript_path, cwd: event.cwd,
  socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
  token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
}), { mode: 0o600, flag: 'wx' });
