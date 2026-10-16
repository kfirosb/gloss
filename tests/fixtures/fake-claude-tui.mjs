// Draws a Claude-like input box ("❯ " between two rules), turns on bracketed paste and appends every input byte to
// the log file. A preset draft is shown after the prompt; Ctrl+U clears it. Used only by tmux plumbing tests.
import { appendFileSync } from 'node:fs';

const [log, draft = ''] = process.argv.slice(2);
let input = draft;
const rule = '─'.repeat(60);
function draw() {
  process.stdout.write('\u001b[2J\u001b[H\u001b[?2004h');
  process.stdout.write(`\r\n${rule}\r\n❯ ${input}\r\n${rule}\r\n`);
  // Row 3, column 3 + draft length (1-based): the cell right after the prompt and the draft.
  process.stdout.write(`\u001b[3;${3 + input.length}H`);
}
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  appendFileSync(log, chunk);
  if (chunk.includes(0x15)) {
    input = '';
    draw();
  }
});
draw();
