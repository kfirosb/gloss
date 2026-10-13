import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/runtime/cli.js';
describe('launcher arguments', () => {
  it('keeps project paths as one argv value', () => { expect(parseArgs(['--language', 'he', '--project', '/tmp/a;touch nope', '--agent', 'codex', '--session', 'id'])).toEqual({ language: 'he', project: '/tmp/a;touch nope', agent: 'codex', session: 'id' }); });
});
