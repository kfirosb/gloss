import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './error-message.js';
import { listPastSessions } from './past-sessions.js';
import type { PastSessionsList } from './session-tabs.js';

/**
 * The Saved sessions rows of the shown folder, fetched per folder path. Each fetch takes the folder's next
 * request number; an answer that is not the folder's latest, or arrives after another folder was chosen,
 * is dropped. A refetch keeps the earlier rows visible until its answer replaces them. The list is fetched
 * when the folder is shown and again whenever `changes` (the folder's catalog keys) differs.
 */
export function usePastSessions(folderPath: string | undefined, changes: string) {
  const [lists, setLists] = useState<Record<string, PastSessionsList>>({});
  const requests = useRef(new Map<string, number>());
  const shown = useRef(folderPath);
  shown.current = folderPath;
  const refresh = (folder: string | undefined = shown.current) => {
    if (!folder) return;
    const request = (requests.current.get(folder) ?? 0) + 1;
    requests.current.set(folder, request);
    const current = () => requests.current.get(folder) === request && shown.current === folder;
    setLists((previous) =>
      previous[folder] ? previous : { ...previous, [folder]: { entries: [], loading: true } },
    );
    void listPastSessions(folder).then(
      (response) => {
        if (current())
          setLists((previous) => ({
            ...previous,
            [folder]: {
              entries: response.entries,
              loading: false,
              folderMissing: response.folderMissing === true,
            },
          }));
      },
      (e: unknown) => {
        if (current())
          setLists((previous) => ({
            ...previous,
            [folder]: {
              entries: previous[folder]?.entries ?? [],
              loading: false,
              folderMissing: previous[folder]?.folderMissing,
              error: errorMessage(e, 'unknown error'),
            },
          }));
      },
    );
  };
  useEffect(() => refresh(folderPath), [folderPath, changes]);
  return { list: folderPath ? lists[folderPath] : undefined, refresh };
}
