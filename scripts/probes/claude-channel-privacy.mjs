import { readFile } from 'node:fs/promises';

export async function readOptionalWal(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
}

// Coverage starts when this reader is attached, not when a prior delivery occurred.
// A boundary/size/read failure is inconclusive: never return an absence flag.
export async function inspectSse(response, secrets, { windowMs = 1000, maxBytes = 4 * 1024 * 1024, expectedSessionId } = {}) {
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('Invalid SSE response');
  if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > 10000 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !expectedSessionId) throw new Error('Invalid SSE observation bounds');
  if (!secrets.length || secrets.some(secret => typeof secret !== 'string' || !secret.length)) throw new Error('Missing credential scan inputs');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), windowMs); });
  let pending = '', inspected = '', bytes = 0, frames = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === null) break;
      if (chunk.done) throw new Error('SSE stream ended before observation window completed');
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('SSE observation byte limit exceeded');
      const text = decoder.decode(chunk.value, { stream: true });
      pending += text; inspected += text;
      if (secrets.some(secret => inspected.includes(secret))) throw new Error('Credential found in SSE');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue; // Comments/heartbeats are scanned, not counted as snapshots.
        let value;
        try { value = JSON.parse(data); } catch { throw new Error('Invalid SSE JSON frame'); }
        if (secrets.some(secret => JSON.stringify(value).includes(secret))) throw new Error('Credential found in SSE');
        if (frames === 0 && (value?.sessionId !== expectedSessionId || !Array.isArray(value?.snapshot?.codingMessages))) throw new Error('Missing exact-session initial SSE snapshot');
        frames++;
      }
    }
    pending += decoder.decode();
    if (pending.length || frames === 0) throw new Error('Incomplete SSE frame or initial snapshot at observation deadline');
    return { completeInitialSnapshot: true, frames, bytes, observationWindowMs: windowMs, maxBytes };
  } finally { clearTimeout(timer); await reader.cancel(); }
}
