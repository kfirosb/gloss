import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { inspectSse, readOptionalWal } = await import(
  new URL('../../scripts/probes/claude-channel-privacy.mjs', import.meta.url).href
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const snapshot = 'data: {"sessionId":"scratch","snapshot":{"codingMessages":[]}}\n\n';
async function endpoint(write: (res: ServerResponse) => void) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    write(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP listener');
  return fetch(`http://127.0.0.1:${address.port}/events`);
}
const options = { windowMs: 80, expectedSessionId: 'scratch' };
describe('channel privacy evidence over actual HTTP/SSE', () => {
  it('rejects a credential split across transport chunks in the initial snapshot', async () => {
    const response = await endpoint((res) => {
      res.write('data: {"sessionId":"scratch","snapshot":{"text":"SENTINEL-');
      setTimeout(() => res.write('SECRET"}}\n\n'), 20);
    });
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).rejects.toThrow(/Credential/);
  });
  it('rejects credentials in later complete frames during the observation window', async () => {
    const response = await endpoint((res) => {
      res.write(snapshot);
      setTimeout(() => res.write('data: {"secret":"SENTINEL-SECRET"}\n\n'), 20);
    });
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).rejects.toThrow(/Credential/);
  });
  it('rejects an incomplete initial frame rather than certifying a prefix', async () => {
    const response = await endpoint((res) => res.write(snapshot.slice(0, -2)));
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).rejects.toThrow(/Incomplete/);
  });
  it('rejects a partial trailing frame even after a complete initial snapshot', async () => {
    const response = await endpoint((res) => res.write(snapshot + 'data: {"partial":'));
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).rejects.toThrow(/Incomplete/);
  });
  it('inspects a complete split snapshot and records bounded coverage', async () => {
    const response = await endpoint((res) => {
      res.write(snapshot.slice(0, 25));
      setTimeout(() => res.write(snapshot.slice(25)), 20);
    });
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).resolves.toMatchObject({
      completeInitialSnapshot: true,
      frames: 1,
      observationWindowMs: 80,
    });
  });
  it('rejects an ended or broken stream without a complete observation window', async () => {
    const response = await endpoint((res) => res.end(snapshot));
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).rejects.toThrow(
      /ended|stream/i,
    );
  });
  it('propagates an actual HTTP stream read failure after an initial snapshot', async () => {
    const response = await endpoint((res) => {
      res.write(snapshot);
      setTimeout(() => res.destroy(), 20);
    });
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).rejects.toThrow();
  });
  it('rejects a complete snapshot for the wrong session', async () => {
    const response = await endpoint((res) => res.write(snapshot.replace('scratch', 'other')));
    await expect(inspectSse(response, ['SENTINEL-SECRET'], options)).rejects.toThrow(
      /exact-session/,
    );
  });
  it('fails rather than truncates inspection at the byte bound', async () => {
    const response = await endpoint((res) => res.write(snapshot));
    await expect(
      inspectSse(response, ['SENTINEL-SECRET'], { ...options, maxBytes: 10 }),
    ).rejects.toThrow(/byte limit/);
  });
  it('tolerates only ENOENT for absent WAL and propagates real read errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'privacy-wal-'));
    cleanups.push(() => rm(root, { recursive: true }));
    expect(await readOptionalWal(join(root, 'absent-wal'))).toEqual(Buffer.alloc(0));
    await writeFile(join(root, 'present-wal'), 'SENTINEL-SECRET');
    expect((await readOptionalWal(join(root, 'present-wal'))).toString()).toBe('SENTINEL-SECRET');
    await expect(readOptionalWal(root)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
