import { describe, expect, it } from 'vitest';
import {
  LIVE_VIEWS,
  approvalSwitch,
  historyView,
  selectView,
  showsTerminal,
  toggleTerminal,
} from '../../src/ui/live-view.js';

describe('live view rules', () => {
  it('lists the four views in switch order', () => {
    expect(LIVE_VIEWS).toEqual(['translated', 'original', 'split', 'terminal']);
  });

  it('shows the terminal only in split and terminal', () => {
    expect(LIVE_VIEWS.filter(showsTerminal)).toEqual(['split', 'terminal']);
  });

  it('toggles between the conversation side and split', () => {
    expect(toggleTerminal('translated', 'original')).toBe('split');
    expect(toggleTerminal('original', 'original')).toBe('split');
    expect(toggleTerminal('split', 'original')).toBe('original');
    expect(toggleTerminal('terminal', 'translated')).toBe('translated');
  });

  it('switches to split for an approval and remembers where to return', () => {
    expect(approvalSwitch('original')).toEqual({ view: 'split', returnTo: 'original' });
    expect(approvalSwitch('translated')).toEqual({ view: 'split', returnTo: 'translated' });
    expect(approvalSwitch('split')).toEqual({ view: 'split', returnTo: null });
    expect(approvalSwitch('terminal')).toEqual({ view: 'terminal', returnTo: null });
  });

  it('shows history beside the terminal instead of hiding it', () => {
    expect(historyView('terminal')).toBe('split');
    expect(historyView('original')).toBe('original');
    expect(historyView('split')).toBe('split');
  });

  it('remembers only a picked conversation side', () => {
    expect(selectView('split', 'original')).toBe('original');
    expect(selectView('terminal', 'translated')).toBe('translated');
    expect(selectView('translated', 'original')).toBe('translated');
    expect(selectView('original', 'translated')).toBe('original');
  });
});
