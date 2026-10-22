import { describe, expect, it, vi } from 'vitest';
import { watchUpdates, type UpdateState, type UpdatesBridge } from '../../src/ui/update-state.js';

function fakeBridge(initial: UpdateState | null) {
  const listeners = new Set<(s: UpdateState) => void>();
  let resolveInitial: (s: UpdateState | null) => void = () => undefined;
  const bridge: UpdatesBridge = {
    onState: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    state: () => new Promise((resolve) => (resolveInitial = resolve)),
    check: async () => undefined,
    install: async () => undefined,
  };
  return {
    bridge,
    listeners,
    push: (s: UpdateState) => listeners.forEach((l) => l(s)),
    resolve: () => resolveInitial(initial),
  };
}

describe('watchUpdates', () => {
  it('does not let the initial read overwrite a state pushed before it resolved', async () => {
    const fake = fakeBridge({ kind: 'idle' });
    const seen = vi.fn();
    watchUpdates(fake.bridge, seen);
    fake.push({ kind: 'available', version: '1.0.0' });
    fake.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.mock.calls).toEqual([[{ kind: 'available', version: '1.0.0' }]]);
  });

  it('unsubscribes on dispose and ignores a late initial read', async () => {
    const fake = fakeBridge({ kind: 'idle' });
    const seen = vi.fn();
    const stop = watchUpdates(fake.bridge, seen);
    expect(fake.listeners.size).toBe(1);
    stop();
    expect(fake.listeners.size).toBe(0);
    fake.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).not.toHaveBeenCalled();
  });
});
