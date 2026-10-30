import type { BrowserContext } from '@playwright/test';
import { defaultWorkspace } from '../../src/core/session-contracts.js';
import { pastFromRecords, preferFullAssistant, routePastSessions } from './session-fixture.js';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
export async function sessionFixture(context: BrowserContext) {
  const records = ['A', 'B'].map((id) => ({
    id,
    target: { agent: 'codex', sessionRef: id, projectId: '/project/' + id },
    canonicalRoot: '/project/' + id,
    projectName: id,
    enabled: true,
  }));
  const snapshots: Record<string, any> = Object.fromEntries(
    records.map((r) => [
      r.id,
      {
        id: r.id,
        target: r.target,
        codingState: 'idle',
        codingMessages: [],
        discussion: [{ role: 'assistant', text: 'Discussion ' + r.id }],
        deliveries: [],
        language: 'he',
        languageSessionId: '',
        languageModel: 'default',
        sourceRevision: 0,
      },
    ]),
  );
  const workspaces = Object.fromEntries(
    records.map((r) => [r.id, { sessionId: r.id, revision: 0, data: defaultWorkspace() }]),
  );
  let release: (() => void) | undefined;
  let delay = false;
  let uploadDelay = false;
  let serial = 0;
  const calls: any[] = [];
  let foreign = false;
  const sequences: Record<string, number> = { A: 1, B: 1 };
  await preferFullAssistant(
    context,
    records.map((r) => r.id),
  );
  await context.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const id = p.split('/')[3]!;
    if (p.startsWith('/api/session-catalog'))
      return route.fulfill({ status: 503, json: { error: 'Discovery unavailable in fixture' } });
    if (p === '/api/folders') return route.fulfill({ json: [] });
    if (p === '/api/folders/search')
      return route.fulfill({ json: { hits: [], timedOut: false, unavailable: false } });
    if (p.startsWith('/api/projects/') && p.endsWith('/worktrees'))
      return route.fulfill({ json: { hasCommits: true, worktrees: [] } });
    if (p === '/api/settings/sidebar')
      return route.fulfill({
        json:
          route.request().method() === 'PUT'
            ? route.request().postDataJSON()
            : { order: [], hidden: [], collapsed: [], worktreeLocation: {} },
      });
    if (p === '/api/about')
      return route.fulfill({
        json: {
          name: 'gloss',
          version: '0.0.0-test',
          platform: 'darwin',
          arch: 'arm64',
        },
      });
    if (p === '/api/sessions') return route.fulfill({ json: records });
    if (p === '/api/snapshot')
      return route.fulfill({ json: { sequence: 1, snapshot: snapshots.A } });
    if (p.endsWith('/workspace')) {
      const w = workspaces[id]!;
      if (route.request().method() === 'PUT') {
        const b = route.request().postDataJSON();
        if (b.expectedRevision !== w.revision)
          return route.fulfill({ status: 409, json: { code: 'workspace-conflict', current: w } });
        w.revision++;
        w.data = b.data;
      }
      return route.fulfill({ json: w });
    }
    if (p.endsWith('/actions')) {
      const action = route.request().postDataJSON();
      calls.push({ sessionId: id, ...action });
      if (delay && id === 'A')
        await new Promise<void>((r) => {
          release = r;
        });
      const snapshot = snapshots[id];
      if (action.type === 'prepare')
        snapshot.currentDraft = {
          id: 'draft-' + id,
          revision: 1,
          target: snapshot.target,
          sourceRevision: 0,
          language: 'he',
          localizedText: 'Prepared ' + id,
          englishText: 'Instruction ' + id,
          selectedDiscussion: action.indices,
        };
      if (action.type === 'send-review') {
        snapshot.deliveries = [
          {
            id: 'review-receipt',
            draftId: action.draftId,
            revision: action.revision,
            target: snapshot.target,
            state: 'sent',
            englishText: 'Sent review',
          },
        ];
        delete snapshot.currentDraft;
      }
      if (action.type === 'send-composer')
        snapshot.deliveries = [
          {
            id: 'receipt',
            draftId: 'composer-' + action.requestId,
            revision: 1,
            target: snapshot.target,
            state: 'sent',
            englishText: 'Sent text',
          },
        ];
      return route.fulfill({
        json: {
          sessionId: id,
          sequence: ++sequences[id]!,
          snapshot,
          ...(action.type === 'prepare' ? { review: snapshot.currentDraft } : {}),
        },
      });
    }
    if (p.endsWith('/events'))
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          'data: ' +
          JSON.stringify({
            sessionId: foreign ? 'B' : id,
            sequence: foreign ? 100 : sequences[id],
            snapshot: snapshots[foreign ? 'B' : id],
          }) +
          '\n\n',
      });
    if (p.endsWith('/snapshot'))
      return route.fulfill({
        json: { sessionId: id, sequence: sequences[id], snapshot: snapshots[id] },
      });
    if (p.endsWith('/files')) {
      if (uploadDelay)
        await new Promise<void>((r) => {
          release = r;
        });
      return route.fulfill({
        json: {
          id: id + '-' + ++serial,
          name: 'Screenshot.png',
          mime: 'image/png',
          size: 68,
          kind: 'image',
          index: Number(p.split('/')[5]?.split('-').at(-1)) || serial,
          sessionId: id,
          path: '/tmp/image.png',
          worktreePath: '/project/' + id,
          source: 'upload',
        },
      });
    }
    if (p.endsWith('/metadata'))
      return route.fulfill({
        json: {
          id: p.split('/')[5],
          name: 'Screenshot.png',
          mime: 'image/png',
          size: 68,
          kind: 'image',
          index: Number(p.split('/')[5]?.split('-').at(-1)) || serial,
          sessionId: id,
          path: '/tmp/image.png',
          worktreePath: '/project/' + id,
          source: 'upload',
        },
      });
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
  });
  await routePastSessions(context, pastFromRecords(records));
  return {
    records,
    workspaces,
    snapshots,
    sequences,
    calls,
    foreign() {
      foreign = true;
    },
    delayUpload() {
      uploadDelay = true;
    },
    delay() {
      delay = true;
    },
    release() {
      delay = false;
      uploadDelay = false;
      release?.();
    },
  };
}
