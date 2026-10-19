import { expect, it } from 'vitest';
import { ownPidDomain } from '../../src/agents/claude/pid-domain.js';
import { trustedProcStart } from '../../src/agents/claude/session-records.js';

const fakeFs = (machineId?: string, pidNamespace?: string) => ({
  readFileSync: (): string => {
    if (machineId === undefined) throw new Error('ENOENT');
    return machineId;
  },
  readlinkSync: (): string => {
    if (pidNamespace === undefined) throw new Error('ENOENT');
    return pidNamespace;
  },
});

it('is plain darwin on macOS', () => {
  expect(ownPidDomain('darwin', fakeFs('abc', 'pid:[1]'))).toBe('darwin');
});

it('names the machine and pid namespace on Linux the way Claude does', () => {
  expect(ownPidDomain('linux', fakeFs('abc\n', 'pid:[4026531836]'))).toBe(
    'darwin:abc:pid:[4026531836]',
  );
});

it('keeps the Linux shape when the machine id and namespace are unreadable', () => {
  expect(ownPidDomain('linux', fakeFs())).toBe('darwin::');
});

it('trusts a start time only from the same pid domain', () => {
  const linux = 'darwin:abc:pid:[1]';
  expect(trustedProcStart({ pidDomain: linux, procStart: 'X' }, linux)).toBe('X');
  expect(trustedProcStart({ pidDomain: 'darwin:other:pid:[1]', procStart: 'X' }, linux)).toBe(
    undefined,
  );
  expect(trustedProcStart({ pidDomain: 'darwin', procStart: 'X' }, linux)).toBeUndefined();
  expect(trustedProcStart({ pidDomain: linux, procStart: 'X' }, 'darwin')).toBeUndefined();
});
