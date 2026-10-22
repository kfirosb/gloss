import { useState } from 'react';
import { clearDraft } from './file-edit-drafts.js';
import type { DiscardEditsQuestion } from './file-editor.js';

/**
 * Guards the file preview's unsaved edits: closing the popup or opening another file first asks, in the preview
 * itself, whether to discard them. Nothing is dropped without that answer.
 */
export function useFileEditGuard(sessionId: string, path: string | undefined) {
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ discardLabel: string; run(): void } | null>(null);
  /** Runs `run` now, or once the user agrees to discard the open file's unsaved edits. */
  const leave = (discardLabel: string, run: () => void) => {
    if (!dirty || !path) {
      run();
      return;
    }
    setPending({ discardLabel, run });
  };
  const leavePrompt: DiscardEditsQuestion | null =
    pending && path
      ? {
          message: `You have unsaved edits to ${path}. Discard them?`,
          discardLabel: pending.discardLabel,
          onKeep: () => setPending(null),
          onDiscard: () => {
            clearDraft(sessionId, path);
            setDirty(false);
            setPending(null);
            pending.run();
          },
        }
      : null;
  const onDirtyChange = (next: boolean) => {
    setDirty(next);
    if (!next) setPending(null);
  };
  return { leave, leavePrompt, onDirtyChange };
}
