import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Pixels from the bottom that still count as reading the newest message. */
const BOTTOM_SLACK_PX = 24;

/**
 * History reads like a chat: it opens at the newest message, follows new ones while the reader is at the
 * bottom, and keeps the reader's place when earlier messages are loaded above. `content` must change only
 * when the shown messages change. Returns the call to make just before asking for earlier messages.
 */
export function useHistoryScroll(
  container: RefObject<HTMLElement | null>,
  active: boolean,
  content: string,
): () => void {
  const atBottom = useRef(true);
  const keepFromBottom = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !active) return;
    element.scrollTop = element.scrollHeight;
    atBottom.current = true;
    keepFromBottom.current = undefined;
    const track = () => {
      atBottom.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK_PX;
    };
    element.addEventListener('scroll', track);
    return () => element.removeEventListener('scroll', track);
  }, [container, active]);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !active) return;
    const fromBottom = keepFromBottom.current;
    keepFromBottom.current = undefined;
    if (fromBottom !== undefined) element.scrollTop = element.scrollHeight - fromBottom;
    else if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [container, active, content]);
  return () => {
    const element = container.current;
    if (element) keepFromBottom.current = element.scrollHeight - element.scrollTop;
  };
}
