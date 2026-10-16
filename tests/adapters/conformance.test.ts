import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises';
import { harness, watch } from './agent-harness.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
for (const kind of ['claude', 'codex'] as const)
  describe(`${kind} native adapter conformance`, () => {
    async function setup() {
      const h = await harness(kind);
      cleanups.push(h.cleanup);
      const c = await h.adapter.attach(h.target);
      cleanups.push(() => c.detach());
      return { h, c };
    }
    it('discovers only exact project and rejects a different project before history', async () => {
      const { h } = await setup();
      expect(await h.adapter.discover(h.project)).toEqual([h.target]);
      expect(await h.adapter.discover(h.dir)).toEqual([]);
      await expect(h.adapter.attach({ ...h.target, projectId: h.dir })).rejects.toThrow(
        /identity|project/i,
      );
    });
    it('paginates older history and reconciles an append before live subscription without duplicate source events', async () => {
      const { h, c } = await setup();
      const latest = await c.history();
      expect(latest.messages.map((m) => m.text)).toEqual(['READY']);
      expect(latest.next).toBeTruthy();
      const older = await c.history(latest.next);
      expect(older.messages).toHaveLength(1);
      expect(older.messages[0]?.role).toBe('user');
      await h.appendMessage();
      const w = watch(c);
      cleanups.push(w.stop);
      await expect
        .poll(() =>
          w.events.filter((e) => e.type === 'message').some((e) => e.message.text === 'later'),
        )
        .toBe(true);
      await h.appendMessage();
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(
        w.events.filter((e) => e.type === 'message' && e.message.sourceId === 'later-message'),
      ).toHaveLength(1);
      const ready = w.events.find((e) => e.type === 'message' && e.message.text === 'READY');
      if (ready?.type === 'message') expect(ready.message).toEqual(latest.messages[0]);
    });
    it('keeps source revisions stable across reconnect and ignores tool or injected context', async () => {
      const { h, c } = await setup();
      const first = await c.history();
      await appendFile(
        h.transcript,
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '<environment_context>SECRET</environment_context>' },
            ],
          },
        }) + '\n',
      );
      const other = await h.adapter.attach(h.target);
      cleanups.push(() => other.detach());
      expect((await other.history()).messages).toEqual(first.messages);
    });
    it('canonicalizes identical repeats across live, history and reconnect while preserving X → Y → X revisions', async () => {
      const { h, c } = await setup();
      const w = watch(c);
      cleanups.push(w.stop);
      await h.appendMessage('X');
      await expect
        .poll(
          () =>
            w.events.filter((e) => e.type === 'message' && e.message.sourceId === 'later-message')
              .length,
        )
        .toBe(1);
      await h.appendMessage('X');
      const first = w.events.find(
        (e) => e.type === 'message' && e.message.sourceId === 'later-message',
      );
      expect((await c.history()).messages[0]).toEqual(
        first?.type === 'message' ? first.message : undefined,
      );
      await h.appendMessage('Y');
      await expect
        .poll(
          () =>
            w.events.filter((e) => e.type === 'message' && e.message.sourceId === 'later-message')
              .length,
        )
        .toBe(2);
      await h.appendMessage('X');
      await h.appendMessage('X');
      await expect
        .poll(
          () =>
            w.events.filter((e) => e.type === 'message' && e.message.sourceId === 'later-message')
              .length,
        )
        .toBe(3);
      const updates = w.events.filter(
        (e) => e.type === 'message' && e.message.sourceId === 'later-message',
      );
      const last = updates[2];
      expect(
        last?.type === 'message' &&
          updates[1]?.type === 'message' &&
          last.message.revision > updates[1].message.revision,
      ).toBe(true);
      expect((await c.history()).messages[0]).toEqual(
        last?.type === 'message' ? last.message : undefined,
      );
      const next = await h.adapter.attach(h.target);
      cleanups.push(() => next.detach());
      expect((await next.history()).messages[0]).toEqual(
        last?.type === 'message' ? last.message : undefined,
      );
      const resumed = watch(next);
      cleanups.push(resumed.stop);
      await expect
        .poll(
          () =>
            resumed.events.filter(
              (e) => e.type === 'message' && e.message.sourceId === 'later-message',
            ).length,
        )
        .toBe(3);
      expect(
        resumed.events.filter(
          (e) => e.type === 'message' && e.message.sourceId === 'later-message',
        ),
      ).toEqual(updates);
    });
    it('retains newer revisions of the same source ID while suppressing exact repetitions', async () => {
      const { h, c } = await setup();
      const w = watch(c);
      cleanups.push(w.stop);
      await h.appendMessage('first revision');
      await expect
        .poll(
          () =>
            w.events.filter((e) => e.type === 'message' && e.message.sourceId === 'later-message')
              .length,
        )
        .toBe(1);
      await h.appendMessage('second revision');
      await expect
        .poll(
          () =>
            w.events.filter((e) => e.type === 'message' && e.message.sourceId === 'later-message')
              .length,
        )
        .toBe(2);
      const updates = w.events.filter(
        (e) => e.type === 'message' && e.message.sourceId === 'later-message',
      );
      expect(
        updates[1]?.type === 'message' &&
          updates[0]?.type === 'message' &&
          updates[1].message.revision > updates[0].message.revision,
      ).toBe(true);
      expect((await c.history()).messages[0]?.text).toBe('second revision');
    });
    it('paginates beyond the bounded live tail without losing UTF-8 source text', async () => {
      const { h, c } = await setup();
      await c.detach();
      const padding =
        JSON.stringify({ type: 'ignored-tool-detail', value: 'x'.repeat(240_000) }) + '\n';
      await appendFile(h.transcript, padding.repeat(5));
      await h.appendMessage('שלום');
      const other = await h.adapter.attach(h.target);
      cleanups.push(() => other.detach());
      const page = await other.history();
      expect(page.messages[0]?.text).toBe('שלום');
      const older = await other.history(page.next);
      expect(older.messages[0]?.text).toBe('READY');
      const w = watch(other);
      cleanups.push(w.stop);
      await expect.poll(() => w.events.some((e) => e.type === 'gap')).toBe(true);
    });
    it('emits a gap for malformed records and blocks uncertain sends', async () => {
      const { h, c } = await setup();
      const w = watch(c);
      cleanups.push(w.stop);
      await appendFile(h.transcript, '{broken json}\n');
      await expect.poll(() => w.events.some((e) => e.type === 'gap')).toBe(true);
      expect((await c.send('request', 'exact')).state).toBe('failed');
    });
    it.each(['truncate', 'replace'] as const)(
      'detects transcript %s and invalidates pagination',
      async (mode) => {
        const { h, c } = await setup();
        const page = await c.history();
        const w = watch(c);
        cleanups.push(w.stop);
        await expect.poll(() => w.events.some((e) => e.type === 'status')).toBe(true);
        if (mode === 'replace') {
          await rename(h.transcript, h.transcript + '.old');
          await writeFile(h.transcript, h.header + h.fixture);
        } else await writeFile(h.transcript, '');
        await expect.poll(() => w.events.some((e) => e.type === 'gap')).toBe(true);
        await expect(c.history(page.next)).rejects.toThrow(/changed|unavailable|gap/i);
      },
    );
    it('closed source stays history-only and detach stops watchers without terminating source', async () => {
      const { h, c } = await setup();
      h.setLive(false);
      const w = watch(c);
      cleanups.push(w.stop);
      await expect
        .poll(() => w.events.some((e) => e.type === 'status' && e.state === 'disconnected'))
        .toBe(true);
      expect((await c.history()).messages[0]?.text).toBe('READY');
      expect((await c.send('request', 'text')).state).toBe('failed');
      await w.stop();
      const count = w.events.length;
      await h.appendMessage();
      await new Promise((r) => setTimeout(r, 20));
      expect(w.events).toHaveLength(count);
      expect(await readFile(h.transcript, 'utf8')).toContain('later');
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    });
  });
