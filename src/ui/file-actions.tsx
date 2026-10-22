import { useEffect, useRef, useState } from 'react';
import { PopupMenu, type PopupMenuItem } from './popup-menu.js';
import { hostPlatform, type HostPlatform } from './host-platform.js';
import { errorMessage } from './error-message.js';
import type { SessionClient } from './session-client.js';

const NOTE_MS = 2500;
/** Opening the computer's file manager needs the desktop app's bridge; the browser build hides the action. */
export const canRevealFiles = () => !!window.gloss?.revealPath;
export const revealLabel = (platform: HostPlatform = hostPlatform()) =>
  platform === 'darwin' ? 'Open in Finder' : 'Open in file manager';
/** Reveals a file or opens a folder; the desktop shell resolves the path inside the session folder. */
async function revealEntry(client: SessionClient, relativePath: string): Promise<string> {
  const result = await window.gloss?.revealPath?.(client.sessionId, relativePath);
  return result && 'error' in result ? `Could not open: ${result.error}` : '';
}
/** Copies the entry's absolute path, as the server resolved it inside the session folder. */
async function copyEntryPath(client: SessionClient, relativePath: string): Promise<string> {
  try {
    const { path } = await client.locateFile(relativePath);
    await navigator.clipboard.writeText(path);
    return 'Path copied';
  } catch (error) {
    return `Could not copy the path: ${errorMessage(error, 'clipboard unavailable')}`;
  }
}
/** "Open in Finder" (desktop only) and "Copy path" for one entry, as menu items or buttons. */
function locationActions(
  client: SessionClient,
  relativePath: string,
  report: (note: string) => void,
): PopupMenuItem[] {
  return [
    ...(canRevealFiles()
      ? [
          {
            key: 'reveal',
            content: revealLabel(),
            onChoose: () => void revealEntry(client, relativePath).then(report),
          },
        ]
      : []),
    {
      key: 'copy-path',
      content: 'Copy path',
      onChoose: () => void copyEntryPath(client, relativePath).then(report),
    },
  ];
}
/** A short-lived status line; a newer note replaces the older one. */
function useNote() {
  const [note, setNote] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const report = (text: string) => {
    clearTimeout(timer.current);
    setNote(text);
    if (text) timer.current = setTimeout(() => setNote(''), NOTE_MS);
  };
  return [note, report] as const;
}
/** The context menu of a Files row, opened by right-click, the Menu key or Shift+F10. */
export function useFileEntryMenu(client: SessionClient, relativePath: string, name: string) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [note, report] = useNote();
  const row = useRef<HTMLButtonElement>(null);
  const openAt = (x: number, y: number) => setAt({ x, y });
  const triggers = {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      openAt(e.clientX, e.clientY);
    },
    onMenuKey: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return false;
      e.preventDefault();
      const box = e.currentTarget.getBoundingClientRect();
      openAt(box.left + 24, box.bottom);
      return true;
    },
  };
  const menu = (
    <>
      {at && (
        <div className="folder-context" style={{ left: at.x, top: at.y }}>
          <PopupMenu
            controlled={{
              open: true,
              onOpenChange: (open) => {
                if (!open) setAt(null);
              },
              restoreFocus: () => {
                setAt(null);
                row.current?.focus();
              },
            }}
            label={`Actions for ${name}`}
            menuLabel={`Actions for ${name}`}
            menuClassName="session-saved-menu session-context-menu"
            items={locationActions(client, relativePath, report)}
          />
        </div>
      )}
      {note && (
        <span className="file-row-note" role="status">
          {note}
        </span>
      )}
    </>
  );
  return { row, triggers, menu };
}
/** The preview header's buttons for the previewed file. */
export function FileLocationButtons({
  client,
  relativePath,
}: {
  client: SessionClient;
  relativePath: string;
}) {
  const [note, report] = useNote();
  return (
    <div className="file-location-actions">
      {locationActions(client, relativePath, report).map((action) => (
        <button key={action.key} type="button" onClick={action.onChoose}>
          {action.content}
        </button>
      ))}
      {note && <span role="status">{note}</span>}
    </div>
  );
}
