// Draws a Claude-like input box ("❯ " between two rules), turns on bracketed paste and appends every input byte to
// the log file. A preset draft is shown after the prompt; Ctrl+U clears it, and pasted text is drawn in the
// box. A one-row footer is drawn under the box, as Claude draws one. Ctrl+S moves the draft to one stash slot (shown
// as `› stashed` on the footer) or brings it back on an empty box; Enter puts it back. Synthetic, not a Claude screen:
// used only by tmux plumbing tests.
import { appendFileSync } from 'node:fs';

const [log, draft = ''] = process.argv.slice(2);
let input = draft;
let stash;
const rule = '─'.repeat(60);
function draw() {
  process.stdout.write('\u001b[2J\u001b[H\u001b[?2004h');
  process.stdout.write(
    `\r\n${rule}\r\n❯ ${input.replace(/\n/g, '\r\n')}\r\n${rule}\r\n  ? for shortcuts${stash === undefined ? '' : ' · › stashed'}\r\n`,
  );
  // Row 3, column 3 + draft length (1-based): the cell right after the prompt and the draft.
  process.stdout.write(`\u001b[3;${3 + input.length}H`);
}
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  appendFileSync(log, chunk);
  const text = chunk.toString('utf8').replace(/\u001b\[20[01]~/g, '');
  if (chunk.includes(0x13)) {
    // Ctrl+S: a stash slot like Claude's. Text moves to it; on an empty box the stash comes back.
    if (input) [stash, input] = [input, ''];
    else if (stash !== undefined) [input, stash] = [stash, undefined];
  } else if (chunk.includes(0x15)) input = '';
  else if (text.includes('\r')) [input, stash] = [stash ?? '', undefined];
  else input += text;
  draw();
});
draw();
