import type { Target } from '../../core/contracts.js';
import { recordOf, type JsonRecord } from '../../core/json-record.js';
import type { ChannelRecord } from './channel-types.js';
import type { ProcessRunner } from '../../runtime/process-runner.js';
import { isClaudeExecutable, readProcess, type ProcessInfo } from './process-probe.js';
import { isTerminalRecord, sessionRecordOf, trustedProcStart } from './session-records.js';
import { OWN_PID_DOMAIN } from './pid-domain.js';
import { constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  claudeConfigDir,
  projectIdentity,
  uuid,
  validateTarget,
  verifyFirstRecord,
} from '../shared.js';

export type ChannelProcess = ProcessInfo;
export interface ChannelRegistryOptions {
  registryDir?: string;
  configDir?: string;
  port?: number;
  pid?: number;
  uid?: number;
  platform?: NodeJS.Platform;
  probe?: (pid: number, signal: AbortSignal) => Promise<ChannelProcess | undefined>;
  /** Trusted test seam; production authenticates the numeric-loopback endpoint. */
  healthProbe?: (record: ChannelRecord, signal: AbortSignal) => Promise<unknown>;
  runner?: ProcessRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
const MAX_RECORD = 65_536;
/** How long one `ps` identity probe may run, in milliseconds; ancestry runs up to 17 of them per binding. */
const IDENTITY_PS_TIMEOUT_MS = 1000;
const positivePid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const validPort = (value: unknown): value is number => positivePid(value) && value <= 65535;
const sameTarget = (a: Target, b: Target) =>
  a.agent === b.agent && a.sessionRef === b.sessionRef && a.projectId === b.projectId;
interface NativeRecord {
  sessionId: string;
  cwd: string;
  pid: number;
  procStart: string;
  pidDomain: string;
  version: string;
  entrypoint?: string;
}

/** Experimental. Server-owned options only; credentials must never enter browser contracts.
 * The caller binds 127.0.0.1:0, supplies its assigned port, resolves before EVERY
 * dispatch, and calls removeChannel on normal shutdown. No lifecycle/global hooks.
 * Its authenticated /health endpoint becomes ready ONLY after registration returns
 * successfully; failed startup closes the listener. A file alone is not activation.
 */
export function createChannelRegistry(options: ChannelRegistryOptions = {}) {
  const registryDir = resolve(
    options.registryDir ?? join(homedir(), '.language-assistant', 'claude-channels'),
  );
  const configDir = resolve(claudeConfigDir(options.configDir));
  const uid = () => options.uid ?? process.getuid?.();
  const supported = () =>
    (options.platform ?? process.platform) === 'darwin' && uid() !== undefined;
  const own = new Map<string, ChannelRecord>();
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => delay(ms));

  // Reject symlinks in every component, including parent directories. Never chmod
  // pre-existing state: unsafe permissions are a failure, not permission to repair.
  async function checkedPath(path: string, privateMode?: number) {
    const absolute = resolve(path);
    let current = absolute;
    while (true) {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symlinked channel identity path');
      if (current !== absolute && !info.isDirectory())
        throw new Error('Invalid identity directory');
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const info = await lstat(absolute);
    if (
      info.uid !== uid() ||
      (privateMode !== undefined ? (info.mode & 0o777) !== privateMode : (info.mode & 0o022) !== 0)
    )
      throw new Error('Unsafe identity ownership or permissions');
    return info;
  }
  async function readJson(path: string, privateRecord = false): Promise<JsonRecord> {
    const before = await checkedPath(path, privateRecord ? 0o600 : undefined);
    if (!before.isFile() || before.size > MAX_RECORD) throw new Error('Invalid identity record');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.uid !== uid() ||
        info.size > MAX_RECORD
      )
        throw new Error('Identity record changed');
      const buffer = Buffer.alloc(MAX_RECORD + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await checkedPath(path, privateRecord ? 0o600 : undefined);
      if (bytesRead > MAX_RECORD || info.ino !== after.ino || info.dev !== after.dev)
        throw new Error('Identity record changed');
      const record = recordOf(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
      if (!record) throw new Error('Invalid identity record');
      return record;
    } finally {
      await file.close();
    }
  }
  async function names(path: string, privateDirectory = false) {
    const info = await checkedPath(path, privateDirectory ? 0o700 : undefined);
    if (!info.isDirectory()) throw new Error('Invalid identity directory');
    const entries = await readdir(path);
    if (entries.length > 10_000) throw new Error('Identity enumeration exceeds bound');
    return entries;
  }
  async function probe(pid: number, signal: AbortSignal): Promise<ChannelProcess | undefined> {
    if (!positivePid(pid) || signal.aborted) return undefined;
    let value: ChannelProcess | undefined;
    if (options.probe) value = await options.probe(pid, signal);
    else value = await readProcess(pid, signal, IDENTITY_PS_TIMEOUT_MS, options.runner);
    return value &&
      value.pid === pid &&
      value.uid === uid() &&
      Number.isSafeInteger(value.ppid) &&
      value.ppid >= 0 &&
      value.startedAt &&
      !signal.aborted
      ? { ...value }
      : undefined;
  }
  async function ancestry(pid: number, signal: AbortSignal) {
    const chain: ChannelProcess[] = [];
    const visited = new Set<number>();
    // Current process plus at most sixteen parent edges.
    for (let hop = 0; hop <= 16 && pid > 1; hop++) {
      if (visited.has(pid)) throw new Error('Cyclic ancestry');
      visited.add(pid);
      // A system-owned login process can sit above Claude. Stop at that trust
      // boundary; binding still requires Claude inside the verified prefix.
      const observed = await probe(pid, signal);
      if (!observed) break;
      chain.push(observed);
      pid = observed.ppid;
    }
    return chain;
  }
  async function nativeRecords(signal: AbortSignal) {
    const records: NativeRecord[] = [];
    for (const name of await names(join(configDir, 'sessions'))) {
      if (signal.aborted) throw new Error('Identity verification expired');
      if (!name.endsWith('.json')) continue;
      try {
        const r = sessionRecordOf(await readJson(join(configDir, 'sessions', name)));
        const procStart = r && trustedProcStart(r);
        if (
          !r ||
          !procStart ||
          !uuid.test(r.sessionId) ||
          !positivePid(r.pid) ||
          !isAbsolute(r.cwd) ||
          !r.version ||
          !isTerminalRecord(r)
        )
          continue;
        const live = await probe(r.pid, signal);
        if (live && live.startedAt === procStart && isClaudeExecutable(live.command, r.version))
          records.push({
            sessionId: r.sessionId,
            cwd: r.cwd,
            pid: r.pid,
            procStart,
            pidDomain: OWN_PID_DOMAIN,
            version: r.version,
            ...(r.entrypoint === 'cli' ? { entrypoint: r.entrypoint } : {}),
          });
      } catch {
        /* Invalid or stale native metadata cannot establish identity. */
      }
    }
    return records;
  }
  async function transcript(target: Target, signal: AbortSignal) {
    signal.throwIfAborted();
    const root = join(configDir, 'projects');
    const matches: string[] = [];
    for (const name of await names(root)) {
      signal.throwIfAborted();
      const directory = join(root, name);
      try {
        if (!(await checkedPath(directory)).isDirectory()) continue;
        const path = join(directory, `${target.sessionRef}.jsonl`);
        if ((await checkedPath(path)).isFile()) matches.push(path);
      } catch {
        /* Absent/unsafe transcript is not a candidate. */
      }
    }
    signal.throwIfAborted();
    if (matches.length !== 1) throw new Error('Transcript identity absent or ambiguous');
    const path = matches[0]!;
    const before = await checkedPath(path);
    const first = await verifyFirstRecord(path, (record) => {
      if (record.sessionId !== undefined && record.sessionId !== target.sessionRef)
        throw new Error('Transcript UUID mismatch');
      return record.sessionId === target.sessionRef && typeof record.cwd === 'string';
    });
    const after = await checkedPath(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      typeof first.cwd !== 'string' ||
      (await projectIdentity(first.cwd)) !== target.projectId
    )
      throw new Error('Transcript identity changed');
    return path;
  }
  async function binding(channelPid: number, signal: AbortSignal, expected?: Target) {
    const chain = await ancestry(channelPid, signal);
    const records = await nativeRecords(signal);
    const ancestors = records.filter((r) =>
      chain.slice(1).some((p) => p.pid === r.pid && p.startedAt === r.procStart),
    );
    if (ancestors.length !== 1) throw new Error('Native ancestor absent or ambiguous');
    const native = ancestors[0]!;
    if (records.filter((r) => r.sessionId === native.sessionId).length !== 1)
      throw new Error('Multiple live native owners');
    const target: Target = {
      agent: 'claude',
      sessionRef: native.sessionId,
      projectId: await projectIdentity(native.cwd),
    };
    validateTarget(target, 'claude');
    if (expected && !sameTarget(target, expected)) throw new Error('Target identity mismatch');
    signal.throwIfAborted();
    const transcriptPath = await transcript(target, signal);
    // Metadata/transcript reads are asynchronous: verify the observed ancestry
    // again before releasing a binding to the caller.
    const current = await ancestry(channelPid, signal);
    if (JSON.stringify(current) !== JSON.stringify(chain))
      throw new Error('Ancestry changed during verification');
    return {
      target,
      transcriptPath,
      claudePid: native.pid,
      claudeStartedAt: native.procStart,
      channelPid,
      channelStartedAt: chain[0]!.startedAt,
    };
  }
  async function ensureDirectory(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await ensureDirectory(dirname(path));
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    if (!(await checkedPath(path)).isDirectory()) throw new Error('Invalid state directory');
  }
  async function write(record: ChannelRecord, checkDeadline: () => void) {
    checkDeadline();
    await ensureDirectory(registryDir);
    checkDeadline();
    await checkedPath(dirname(registryDir), 0o700);
    checkDeadline();
    await names(registryDir, true);
    checkDeadline();
    const temporary = join(registryDir, `.${record.generation}.${randomUUID()}.tmp`);
    const destination = join(registryDir, `${record.generation}.json`);
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > MAX_RECORD) throw new Error('Channel record exceeds bound');
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let published = false;
    let closed = false;
    try {
      checkDeadline();
      await file.writeFile(data);
      checkDeadline();
      await file.sync();
      checkDeadline();
      await file.close();
      closed = true;
      checkDeadline();
      await checkedPath(registryDir, 0o700);
      checkDeadline();
      // Rename replaces a directory entry, never follows the destination as a link.
      await rename(temporary, destination);
      published = true;
      checkDeadline();
    } catch (error) {
      // Node cannot cancel an already submitted rename. If it completes after
      // timeout, retract this unique generation; never return it as registered.
      if (published) await unlink(destination).catch(() => {});
      throw error;
    } finally {
      // No further I/O on success: cleanup must not stall after publication.
      if (!closed) await file.close();
      if (!published) await unlink(temporary).catch(() => {});
    }
  }
  function validRecord(value: unknown, generation: string): value is ChannelRecord {
    const r = recordOf(value);
    const target = recordOf(r?.target);
    return (
      !!r &&
      r.schemaVersion === 1 &&
      target?.agent === 'claude' &&
      typeof target.sessionRef === 'string' &&
      uuid.test(target.sessionRef) &&
      typeof target.projectId === 'string' &&
      isAbsolute(target.projectId) &&
      typeof r.transcriptPath === 'string' &&
      isAbsolute(r.transcriptPath) &&
      positivePid(r.claudePid) &&
      positivePid(r.channelPid) &&
      typeof r.claudeStartedAt === 'string' &&
      typeof r.channelStartedAt === 'string' &&
      r.generation === generation &&
      uuid.test(generation) &&
      validPort(r.port) &&
      typeof r.token === 'string' &&
      /^[a-f0-9]{64}$/.test(r.token)
    );
  }
  async function ready(record: ChannelRecord, parentSignal: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      let proof: unknown;
      if (options.healthProbe) proof = await options.healthProbe(record, signal);
      else {
        const response = await fetch(`http://127.0.0.1:${record.port}/health`, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${record.token}`, Accept: 'application/json' },
        });
        if (!response.ok || !response.body) return false;
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) return false;
          chunks.push(Buffer.from(value));
        }
        proof = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      return (
        !signal.aborted &&
        !!proof &&
        typeof proof === 'object' &&
        'generation' in proof &&
        proof.generation === record.generation &&
        'ready' in proof &&
        proof.ready === true
      );
    } catch {
      return false;
    } finally {
      // Do not expose credentials or HTTP diagnostics.
      clearTimeout(timer);
      controller.abort();
    }
  }
  return {
    async registerChannel(port = options.port): Promise<ChannelRecord> {
      if (!supported()) throw new Error('Claude channels are experimental and macOS-only');
      if (!validPort(port)) throw new Error('A bound loopback port is required');
      const deadline = now() + 10_000;
      const controller = new AbortController();
      const { signal } = controller;
      const expired = new Error('Channel identity deadline expired; disconnected');
      const checkDeadline = () => {
        if (signal.aborted || now() >= deadline) throw expired;
      };
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(expired);
          reject(expired);
        }, 10_000);
      });
      const register = async (): Promise<ChannelRecord> => {
        const channelPid = options.pid ?? process.pid;
        const original = await probe(channelPid, signal);
        checkDeadline();
        if (!original) throw new Error('Channel process identity unavailable');
        while (!signal.aborted && now() < deadline) {
          try {
            const identity = await binding(channelPid, signal);
            checkDeadline();
            if (identity.channelStartedAt !== original.startedAt)
              throw new Error('Channel process was replaced');
            const record: ChannelRecord = {
              schemaVersion: 1,
              ...identity,
              generation: randomUUID(),
              port,
              token: randomBytes(32).toString('hex'),
            };
            await write(record, checkDeadline);
            try {
              checkDeadline();
            } catch (error) {
              await unlink(join(registryDir, `${record.generation}.json`)).catch(() => {});
              throw error;
            }
            own.set(record.generation, record);
            return structuredClone(record);
          } catch {
            /* Startup metadata may appear after the MCP child launches. */
          }
          const remaining = deadline - now();
          if (remaining <= 0 || signal.aborted) break;
          await sleep(Math.min(250, remaining));
        }
        throw new Error('Channel identity unavailable or ambiguous; disconnected');
      };
      try {
        // Settle at the deadline even if a filesystem syscall cannot be cancelled.
        // The losing operation retains cleanup ownership and cannot return success.
        return await Promise.race([register(), timeout]);
      } finally {
        clearTimeout(timer!);
        controller.abort(expired);
      }
    },
    async resolveChannel(target: Target): Promise<ChannelRecord | undefined> {
      if (!supported()) return undefined;
      try {
        validateTarget(target, 'claude');
        if ((await projectIdentity(target.projectId)) !== target.projectId) return undefined;
        await checkedPath(dirname(registryDir), 0o700);
        const candidates: ChannelRecord[] = [];
        const signal = AbortSignal.timeout(10_000);
        for (const name of await names(registryDir, true)) {
          if (!name.endsWith('.json')) continue;
          const generation = name.slice(0, -5);
          if (!uuid.test(generation)) continue;
          try {
            const path = join(registryDir, name);
            const record = await readJson(path, true);
            if (!validRecord(record, generation) || !sameTarget(record.target, target)) continue;
            const live = await binding(record.channelPid, signal, target);
            if (
              live.claudePid !== record.claudePid ||
              live.claudeStartedAt !== record.claudeStartedAt ||
              live.channelStartedAt !== record.channelStartedAt ||
              live.transcriptPath !== record.transcriptPath
            )
              continue;
            // Exclude failed-startup artifacts before counting competing owners.
            if (!(await ready(record, signal))) continue;
            const current = await readJson(path, true);
            if (JSON.stringify(current) !== JSON.stringify(record)) continue;
            candidates.push(record);
          } catch {
            /* Fail closed for stale, replaced, unsafe or malformed records. */
          }
        }
        await checkedPath(registryDir, 0o700);
        return !signal.aborted && candidates.length === 1 ? candidates[0] : undefined;
      } catch {
        return undefined;
      }
    },
    async removeChannel(generation: string): Promise<void> {
      const record = own.get(generation);
      if (!record) return;
      try {
        await checkedPath(registryDir, 0o700);
        const path = join(registryDir, `${generation}.json`);
        const current = await readJson(path, true);
        if (validRecord(current, generation) && JSON.stringify(current) === JSON.stringify(record))
          await unlink(path);
      } catch {
        /* Missing/replaced registrations are not ours to remove. */
      }
      own.delete(generation);
    },
  };
}
