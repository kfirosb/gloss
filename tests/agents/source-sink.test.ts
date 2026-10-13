import { describe, expect, it, vi } from 'vitest';
import { createHttpSourceSink } from '../../src/agents/source-sink.js';

describe('source bridge sink', () => {
  it('posts normalized assistant messages with bearer authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }));
    const sink = createHttpSourceSink({ endpoint: 'http://127.0.0.1:1234/api/source/messages', capability: 'cap', fetcher });
    await sink.send({ agent: 'codex', sourceSessionId: 'session', sourceId: 'message', sequence: 7, role: 'assistant', text: 'Done.', complete: true, cursor: '7' });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:1234/api/source/messages', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer cap' }),
      body: expect.stringContaining('"agent":"codex"'),
    }));
  });

  it('fails when the panel rejects the message', async () => {
    const sink = createHttpSourceSink({ endpoint: 'http://127.0.0.1:1234/api/source/messages', capability: 'cap', fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 })) });
    await expect(sink.send({ agent: 'codex', sourceSessionId: 'session', sourceId: 'message', sequence: 1, role: 'assistant', text: 'Done.', complete: true, cursor: '1' })).rejects.toThrow('401');
  });
});
