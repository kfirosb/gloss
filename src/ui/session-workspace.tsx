import { hostPlatform } from './host-platform.js';
import {
  MAX_ATTACHMENTS,
  MAX_IMAGES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  ATTACHMENT_LIMIT_MESSAGE,
  IMAGE_LIMIT_MESSAGE,
} from '../core/content-policy.js';
import React, {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useId,
  type CSSProperties,
  type ReactNode,
} from 'react';

import type { AgentMessage, Delivery } from '../core/contracts.js';
import type { Action } from '../runtime/protocol.js';
import { recentMessages } from './history.js';
import { useHistoryScroll } from './history-scroll.js';
import { ImageAttachments, ReferenceImages, ImageSessionContext } from './image-attachments.js';
import { FileBrowser, FILE_DRAG_TYPE } from './file-browser.js';
import { FilesWindow } from './files-window.js';
import { FilePicker, type FilePickerHandle } from './file-picker.js';
import { InventoryPicker, detectInvocation, type InvocationMention } from './inventory-picker.js';
import type { CardReference } from './attachment-cards.js';
import type { FileReference } from '../core/file-references.js';
import { MovableWorkspace } from './movable-workspace.js';
import {
  DEFAULT_LIVE_LAYOUT,
  useDisplayPreferences,
  type AssistantMode,
  type LiveLayout,
} from './display-preferences.js';
import {
  SelectionDialog,
  ReplaceInstructionDialog,
  ResetInstructionDialog,
} from './composer-dialogs.js';
import { InstructionReviewDialog, type InstructionReview } from './instruction-review.js';
import { FileLinkContext, localFilePath } from './file-links.js';
import { RichText } from './rich-text.js';
import { SummarizableResponse } from './response-summary.js';
import { ReadingPane } from './reading-pane.js';
import {
  REFERENCE_MARK,
  SessionClient,
  markSessionSeen,
  type SessionEnvelope,
} from './session-client.js';
import { useWorkspace } from './use-workspace.js';

import { ActivityView } from './activity-view.js';
import { LiveTerminal } from './live-terminal.js';
import { ViewRadios } from './live-view-switch.js';
import { PaneDivider, useWideLayout } from './pane-divider.js';
import {
  CONVERSATION_VIEWS,
  LIVE_VIEWS,
  LIVE_VIEW_LABELS,
  NO_ACTIVITY_TOOLTIP,
  NO_TERMINAL_TOOLTIP,
  approvalSwitch,
  historyView,
  selectView,
  showsTerminal,
  toggleTerminal,
  type ConversationView,
  type LiveView,
} from './live-view.js';
import {
  usePopupMode,
  useAutoOpenTerminal,
  lastKeystrokeAt,
  noteKeystroke,
  typedRecently,
  AUTO_OPEN_POLL_MS,
} from './launch-controls.js';

import { RunCommandContext } from './run-command.js';

import { activityLabel } from './session-navigation.js';
import type { CatalogEntry } from '../core/session-catalog.js';
import type { UsageSnapshot } from '../core/usage.js';
import { QuotaBreakDialog, UsageReadout } from './usage-dialogs.js';
import { terminalDestinationLabel } from './provider-label.js';
import { clampLayoutSize, type SessionRecord } from '../core/session-contracts.js';

import { SessionLanguageControl } from './language-controls.js';
import {
  languageDirection,
  legacyLanguageSettings,
  needsReplyTranslation,
} from '../core/language-settings.js';
import { isHebrew } from '../core/language-style.js';
import { ClaudeConnection, useClaudeConnection } from './claude-connection.js';
import { useMoveNotice, useMoveShown } from './claude-move-watch.js';
import { MoveSessionHere } from './claude-move.js';
import {
  DIALOG_OPEN_REASON,
  isChannelAwaitingReply,
  isDeliverySubmitted,
  isDeliveryUnresolved,
  isFailedUntyped,
  sendGate,
} from '../core/contracts.js';
import { RouteLine, useDeliveryRoute } from './delivery-route.js';
import { fencedOutput } from './output-fence.js';
import { useDictation } from './use-dictation.js';
import { appendDictation, dictationShortcutLabel, isDictationShortcut } from './dictation-state.js';
import { DictationButton } from './dictation-button.js';
import { errorMessage } from './error-message.js';

function Message({
  message,
  original,
  replyLanguage,
  assist,
  client,
  onTranslate,
}: {
  message: AgentMessage;
  original: boolean;
  replyLanguage: string;
  assist: string;
  client: SessionClient;
  onTranslate?: () => void;
}) {
  const status = message.translationStatus;
  const body = original ? (
    <RichText language="auto" text={message.text} />
  ) : (
    <RichText
      language={status === 'complete' ? replyLanguage : 'auto'}
      text={
        status === 'complete'
          ? (message.translatedText ?? message.text)
          : status === 'error'
            ? 'Translation failed. Original available below.'
            : status === 'pending' || (status === undefined && !message.complete)
              ? 'Translating…'
              : message.text
      }
    />
  );
  return (
    <article
      data-source-id={message.sourceId}
      data-sequence={message.revision}
      data-translation-status={original ? 'original' : (status ?? 'none')}
      className={'message ' + message.role}
    >
      <small>
        {message.role === 'assistant'
          ? !original && status === 'complete'
            ? 'Coding agent · translated'
            : 'Coding agent · original'
          : 'Coding agent · original user message'}
      </small>
      <SummarizableResponse
        client={client}
        kind="coding"
        messageId={message.sourceId}
        text={message.text}
        complete={message.role === 'assistant' && message.complete === true}
        assist={assist}
      >
        {body}
      </SummarizableResponse>
      {!original &&
        status === undefined &&
        message.role === 'assistant' &&
        message.complete &&
        onTranslate && (
          <button type="button" className="translate-one" onClick={onTranslate}>
            Translate
          </button>
        )}
      {!original && (
        <details>
          <summary>Original</summary>
          <pre dir="ltr">{message.text}</pre>
        </details>
      )}
    </article>
  );
}
// Keys already posted in this page; module-level so remounting the workspace (tab switches) never re-posts the same sequence.
const postedSeen = new Set<string>();
/** What to do after a declined terminal Send; the message stays in Gloss. */
const TERMINAL_NOTICE_GUIDANCE =
  'Your message is still in Gloss; press Send again when the terminal is ready.';
/** Marks the shown session seen once per response sequence, only while the page is visible and the window focused. Approval attention is cleared by the attention monitor, never here. */
function useMarkSeen(entry: CatalogEntry | undefined) {
  const sessionId = entry?.sessionId;
  const attention = entry?.attention;
  const sequence = entry?.latestResponseSequence;
  useEffect(() => {
    if (!sessionId || attention !== 'response' || sequence === undefined) return;
    const key = sessionId + ':' + sequence;
    const attempt = () => {
      if (postedSeen.has(key) || document.visibilityState !== 'visible' || !document.hasFocus())
        return;
      postedSeen.add(key);
      void markSessionSeen(sessionId, sequence).catch(() => {
        postedSeen.delete(key);
      });
    };
    attempt();
    window.addEventListener('focus', attempt);
    document.addEventListener('visibilitychange', attempt);
    return () => {
      window.removeEventListener('focus', attempt);
      document.removeEventListener('visibilitychange', attempt);
    };
  }, [sessionId, attention, sequence]);
}
type StripState =
  'waiting' | 'queued' | 'sending' | 'unconfirmed' | 'failed' | 'delivered' | 'received';
/** Flashes "Response received" when the number of answered channel deliveries grows, i.e. only when a reply lands. */
function useReceivedFlash(replied: number): boolean {
  const previous = useRef(replied);
  const [flash, setFlash] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (replied > previous.current) {
      setFlash(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setFlash(false);
      }, 4600);
    }
    previous.current = replied;
  }, [replied]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return flash;
}
/** Marks the strip as fading 4 s after a completed state appears; the text stays in the DOM for assistive technology. */
function useFading(state: StripState | undefined): boolean {
  const [fading, setFading] = useState(false);
  useEffect(() => {
    setFading(false);
    if (state !== 'delivered' && state !== 'received') return undefined;
    const timer = setTimeout(() => setFading(true), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return fading;
}
function ComposerStatus({
  state,
  text,
  fading,
  children,
}: {
  state: StripState;
  text: string;
  fading: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        'status-strip' + (state === 'delivered' || state === 'received' ? ' attn-flash' : '')
      }
      role="status"
      data-state={state}
      {...(fading ? { 'data-fading': 'true' } : {})}
    >
      {state === 'waiting' && <span className="attn-spinner" aria-hidden="true" />}
      {state === 'failed' && <span aria-hidden="true">✕</span>}
      {(state === 'delivered' || state === 'received') && <span aria-hidden="true">✓</span>}
      <span dir="auto">{text}</span>
      {children}
    </div>
  );
}
export function SessionWorkspace({
  initial,
  record,
  entry,
  usage,
  onRun,
  composerInsert,
  onComposerInserted,
}: {
  initial: SessionEnvelope;
  record: SessionRecord;
  entry?: CatalogEntry | undefined;
  usage?: UsageSnapshot | undefined;
  onRun(command: string): Promise<void>;
  composerInsert: { text: string; nonce: number } | null;
  onComposerInserted(): void;
}) {
  const client = useRef(new SessionClient(record.id)).current;
  useMarkSeen(entry);
  const isClaude = record.target.agent === 'claude';
  const channelStatus = useClaudeConnection(client, isClaude);
  const route = useDeliveryRoute(client, isClaude);
  /** Claude needs a route before Send is offered; Codex always sends through its own queue. */
  const routeTransport = isClaude ? (route?.transport ?? undefined) : undefined;
  const routeReady = !isClaude || !!routeTransport;
  const workspace = useWorkspace(record.id);
  const popupMode = usePopupMode();
  const [preferences, setPreferences] = useDisplayPreferences();
  const assistantMode = preferences.assistantModes[record.id] ?? 'compact';
  const setAssistantMode = (mode: AssistantMode) =>
    setPreferences((value) => ({
      ...value,
      assistantModes: { ...value.assistantModes, [record.id]: mode },
    }));
  const launchId = entry?.launchId;
  const wideLayout = useWideLayout();
  const approval = entry?.activity === 'approval-required';
  const liveLayout = preferences.liveViews[record.id] ?? DEFAULT_LIVE_LAYOUT;
  // An approval shows the terminal without saving it: the remembered view is what returns when it ends.
  // A manual choice saves itself and drops this override.
  const [approvalView, setApprovalView] = useState<LiveView | null>(null);
  // A remembered terminal view falls back to its conversation side while there is no terminal to show,
  // and a remembered Activity view does the same for an agent that has no activity to show.
  const savedView =
    !isClaude && liveLayout.view === 'activity' ? liveLayout.conversation : liveLayout.view;
  const liveView: LiveView =
    (launchId && approvalView) ||
    (launchId || !showsTerminal(savedView) ? savedView : liveLayout.conversation);
  const conversationView = selectView(liveView, liveLayout.conversation);
  const setLiveLayout = (change: Partial<LiveLayout>) =>
    setPreferences((value) => ({
      ...value,
      liveViews: {
        ...value.liveViews,
        [record.id]: { ...(value.liveViews[record.id] ?? DEFAULT_LIVE_LAYOUT), ...change },
      },
    }));
  const [terminalFocus, setTerminalFocus] = useState(true);
  /** Why the terminal was shown for a declined Send; cleared when the user picks a view or sends again. */
  const [terminalNotice, setTerminalNotice] = useState<string>();
  /** How a Move to Gloss ended when no dialog was open to show it (I6); cleared when the user picks a view. */
  const [moveNotice, setMoveNotice] = useState<string>();
  useMoveNotice(record.id, setMoveNotice);
  // I6: the connect dialog that started a move stays until the move has an outcome, even once the route is tmux.
  const moveShown = useMoveShown(record.id);
  const chooseLiveView = (view: LiveView) => {
    setTerminalNotice(undefined);
    setMoveNotice(undefined);
    setApprovalView(null);
    setTerminalFocus(true);
    setLiveLayout({ view, conversation: selectView(view, liveLayout.conversation) });
  };
  const chooseConversation = (conversation: ConversationView) => {
    // During an approval only the side is saved; the approval's Split stays temporary and still restores.
    setLiveLayout(approvalView ? { conversation } : { view: liveView, conversation });
  };
  // The approval poll keeps its first callback, so it reads the current view through a ref.
  const liveViewNow = useRef(liveView);
  liveViewNow.current = liveView;
  /**
   * The server did not type a terminal message because the terminal needs the user (spec 2.1): show it, with what to
   * do. The notice says why too unless the status strip already does (`stripShowsReason`, the composer's sends).
   * Returns whether the terminal was shown.
   */
  const showTerminalFor = (delivery: Delivery | undefined, stripShowsReason = false): boolean => {
    if (!delivery?.openTerminal || !launchId) return false;
    if (!showsTerminal(liveViewNow.current)) chooseLiveView('split');
    else setTerminalFocus(true);
    setTerminalNotice(
      stripShowsReason
        ? TERMINAL_NOTICE_GUIDANCE
        : `Not sent: ${delivery.reason ?? 'the terminal needs you'}. ${TERMINAL_NOTICE_GUIDANCE}`,
    );
    return true;
  };
  useAutoOpenTerminal(entry, record.id, popupMode, lastKeystrokeAt, () => {
    const { view, returnTo } = approvalSwitch(liveViewNow.current);
    if (!returnTo) return;
    setTerminalFocus(false);
    setApprovalView(view);
  });
  const terminalDraft = useRef(false);
  // Restore once the approval is over and the user has left the terminal: not while typing, focused there or
  // holding unsent Hebrew-line text. An approval that comes back first simply keeps the terminal.
  useEffect(() => {
    if (approval || !approvalView) return;
    const tick = () => {
      if (typedRecently(lastKeystrokeAt(), Date.now()) || terminalDraft.current) return;
      if (document.activeElement?.closest('.live-terminal')) return;
      setApprovalView(null);
    };
    tick();
    const timer = setInterval(tick, AUTO_OPEN_POLL_MS);
    return () => clearInterval(timer);
  }, [approval, approvalView]);
  useEffect(() => {
    if (!launchId) return;
    // Capture phase: the terminal's own textarea would otherwise take the key first.
    const toggle = (event: KeyboardEvent) => {
      // Ctrl+` too on the Mac, where the system may keep ⌘` for switching windows.
      if (event.key !== '`' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      chooseLiveView(toggleTerminal(liveViewNow.current, liveLayout.conversation));
    };
    window.addEventListener('keydown', toggle, true);
    return () => window.removeEventListener('keydown', toggle, true);
  }, [launchId, liveLayout.conversation]);
  const data = workspace.record.data;
  const call = (action: Action) => client.action(action);

  const snapshot = workspace.envelope?.snapshot ?? initial.snapshot;
  const languageSettings = snapshot.languageSettings ?? legacyLanguageSettings(snapshot.language);
  const text = data.composer;
  const [error, setError] = useState('');
  const [liveHistory, setLiveHistory] = useState(false);
  const [assistantHistory, setAssistantHistory] = useState(false);
  const selected = data.selectedDiscussion;
  const review: InstructionReview | null =
    snapshot.currentDraft &&
    data.review?.draftId === snapshot.currentDraft.id &&
    data.review.revision === snapshot.currentDraft.revision
      ? { draft: snapshot.currentDraft, localizedText: data.review.localizedText }
      : null;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [reviewError, setReviewError] = useState('');

  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [imageMetadata, setImages] = useState<CardReference[]>([]);
  const images = data.attachmentIds.map(
    (id) =>
      imageMetadata.find((image) => image.id === id) ?? {
        id,
        name: 'Loading reference',
        mime: '',
        size: 0,
        status: 'Loading metadata…',
      },
  );
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [composerSending, setComposerSending] = useState(false);
  const composerAttempt = data.composerAttempt;
  const unsupportedFiles =
    images.some((file) => 'kind' in file && file.kind === 'file') &&
    !snapshot.capabilities?.fileReferences;
  const setComposerText = (value: React.SetStateAction<string>) =>
    workspace.update((data) => {
      data.composer = typeof value === 'function' ? value(data.composer) : value;
    });
  // Send output from a terminal: appended to the composer as a fenced block; nothing is sent until the user does.
  const appliedInsert = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!composerInsert || appliedInsert.current === composerInsert.nonce) return;
    appliedInsert.current = composerInsert.nonce;
    setComposerText(
      (v) =>
        (v.trim() ? v.replace(/\s*$/, '') + '\n\n' : '') +
        fencedOutput(composerInsert.text.replace(/\s+$/, '')),
    );
    onComposerInserted();
  }, [composerInsert?.nonce]);
  const dictationLanguage = isHebrew(languageSettings.write) ? 'he' : 'en';
  // A send pressed while recording waits for the last segment; the hook's sendNow bumps a counter so the send runs after
  // the render that holds the appended text, never with a stale composer value.
  const pendingAction = useRef<'send' | 'discuss'>('send');
  const [dictationSend, setDictationSend] = useState(0);
  const dictation = useDictation({
    sessionId: client.sessionId,
    language: dictationLanguage,
    enabled: true,
    appendText: (segment) => setComposerText((prev) => appendDictation(prev, segment)),
    sendNow: () => setDictationSend((n) => n + 1),
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  useEffect(() => {
    let active = true;
    void Promise.all(
      data.attachmentIds.map((id) =>
        client.fileMetadata(id).catch(() => ({
          id,
          name: 'Unavailable reference',
          mime: '',
          size: 0,
          status: 'File unavailable or unreadable',
        })),
      ),
    ).then((next) => {
      if (active) setImages(next);
    });
    return () => {
      active = false;
    };
  }, [data.attachmentIds.join(','), client]);
  const addReference = async (file: FileReference): Promise<void> => {
    const ids = workspace.record.data.attachmentIds;
    if (ids.includes(file.id)) return;
    if (ids.length >= MAX_ATTACHMENTS) throw new Error(ATTACHMENT_LIMIT_MESSAGE);
    if (file.kind === 'image') {
      const existing = await Promise.all(ids.map((id) => client.fileMetadata(id)));
      if (JSON.stringify(ids) !== JSON.stringify(workspace.record.data.attachmentIds))
        return addReference(file);
      if (existing.filter((item) => item.kind === 'image').length >= MAX_IMAGES)
        throw new Error(IMAGE_LIMIT_MESSAGE);
    }
    workspace.update((data) => {
      if (!data.attachmentIds.includes(file.id)) data.attachmentIds.push(file.id);
    });
    setImages((previous) => [...previous.filter((item) => item.id !== file.id), file]);
  };
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | undefined>(undefined);
  // Apply insertion cursors with the committed value, before another input event.
  // An animation-frame callback can otherwise overwrite a subsequent selection.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    pendingCaret.current = undefined;
    if (caret === undefined) return;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(caret, caret);
  }, [text]);
  // Dictated text lands at the end of the composer: keep the newest words in view.
  useEffect(() => {
    const el = textarea.current;
    if (el && dictation.state.lastSequence) el.scrollTop = el.scrollHeight;
  }, [dictation.state.lastSequence]);
  const picker = useRef<FilePickerHandle>(null);
  const pickerId = useId();
  const [activeOption, setActiveOption] = useState<string | undefined>();
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(
    null,
  );
  const [invocation, setInvocation] = useState<InvocationMention | null>(null);
  const detectMention = (value: string, caret: number) => {
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setMention(
      match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]! } : null,
    );
    setInvocation(match ? null : detectInvocation(value, caret));
  };
  const insertInvocation = (name: string) => {
    const token = invocation;
    setInvocation(null);
    if (!token) return;
    const sigil = token.kind === 'skill' ? '/' : '$';
    workspace.update((data) => {
      if (data.composer.slice(token.start, token.end) !== sigil + token.query) return;
      const before = data.composer.slice(0, token.start);
      const insert = (before.endsWith(REFERENCE_MARK) ? '' : REFERENCE_MARK) + sigil + name + ' ';
      data.composer = before + insert + data.composer.slice(token.end);
      pendingCaret.current = before.length + insert.length;
    });
  };
  // The docked column is the only file list; the popup shows the chosen file. They open and close separately, and
  // closing the column closes both. Choosing a file while the popup is open only swaps its path.
  const [filesOpen, setFilesOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const filesToggle = useRef<HTMLButtonElement>(null);
  const filesSideToggle = useRef<HTMLButtonElement>(null);
  const refocusFilesSide = useRef(false);
  useLayoutEffect(() => {
    if (!refocusFilesSide.current) return;
    refocusFilesSide.current = false;
    filesSideToggle.current?.focus();
  }, [preferences.filesSide]);
  // Focus returns here when the popup closes: the column row, the composer for @-mentions, or the link.
  const filesOpener = useRef<HTMLElement | null>(null);
  const showPreview = () => {
    // Only the first opener is kept: swapping files from the column must not move it, so closing returns focus
    // to where the user started.
    if (!previewOpen)
      filesOpener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPreviewOpen(true);
  };
  const closePreview = () => {
    setPreviewOpen(false);
    // A reopened popup starts without the last attach's outcome.
    setPreview((current) => current && { ...current, attached: '' });
    setAttachError('');
    const opener = filesOpener.current;
    filesOpener.current = null;
    (opener?.isConnected ? opener : filesToggle.current)?.focus();
  };
  /** `returnFocus` is false for the Files button, which keeps its own focus. */
  const closeFiles = (returnFocus = true) => {
    setFilesOpen(false);
    setPreviewOpen(false);
    setPreview(null);
    setAttachError('');
    filesOpener.current = null;
    if (returnFocus) filesToggle.current?.focus();
  };
  const [revealedFile, setRevealedFile] = useState('');
  // Attach failures from the preview pane, kept apart from the workspace-wide error.
  const [attachError, setAttachError] = useState('');
  const [preview, setPreview] = useState<{
    path: string;
    token: typeof mention;
    attached?: string;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openPreview = (path: string, token: typeof mention = null) => {
    setError('');
    setAttachError('');
    showPreview();
    setPreview({ path, token });
    setMention(null);
  };
  const openFileLink = (href: string, basePath = '') => {
    try {
      const path = localFilePath(href, record.canonicalRoot, basePath);
      setFilesOpen(true);
      setRevealedFile(path);
      openPreview(path);
    } catch (error) {
      setError(errorMessage(error, 'File unavailable'));
    }
  };
  /** `fromPreview` reports failure in the preview pane; drops report it in the workspace. */
  const attachPath = async (path: string, token: typeof mention = null, fromPreview = false) => {
    if (uploadLock.current) return;
    uploadLock.current = true;
    setUploading(true);
    setError('');
    setAttachError('');
    setPreview((current) => (current?.path === path ? { ...current, attached: '' } : current));
    try {
      const file = await client.referenceFile(path);
      if (file.sessionId !== client.sessionId)
        throw new Error('Attachment does not belong to this session');
      await addReference(file);
      workspace.update((data) => {
        const reference = `@${file.kind === 'image' ? 'Image' : 'File'} ${file.index}`;
        if (new RegExp(reference + '(?![0-9])').test(data.composer)) return;
        if (
          token &&
          data.composer.slice(token.start, token.end) === '@' + token.query &&
          !/[^\s]/.test(data.composer[token.end] ?? '')
        )
          data.composer =
            data.composer.slice(0, token.start) +
            REFERENCE_MARK +
            reference +
            ' ' +
            data.composer.slice(token.end);
        else
          data.composer +=
            (data.composer && !/\s$/.test(data.composer) ? ' ' : '') +
            REFERENCE_MARK +
            reference +
            ' ';
      });
      if (mounted.current) {
        setMention(null);
        setPreview((current) =>
          current?.path === path
            ? {
                ...current,
                attached: `Attached as ${file.kind === 'image' ? 'Image' : 'File'} ${file.index}`,
              }
            : current,
        );
      }
    } catch (e) {
      if (mounted.current)
        (fromPreview ? setAttachError : setError)(errorMessage(e, 'File unavailable'));
    } finally {
      uploadLock.current = false;
      if (mounted.current) setUploading(false);
    }
  };
  const addImages = async (files: File[]) => {
    if (uploadLock.current) {
      setError('Wait for the current files to finish attaching');
      return;
    }
    if (files.length + workspace.record.data.attachmentIds.length > MAX_ATTACHMENTS) {
      setError(ATTACHMENT_LIMIT_MESSAGE);
      return;
    }
    uploadLock.current = true;
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(`Use files up to ${MAX_UPLOAD_LABEL}`);
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = () => reject(new Error('Could not read file'));
          reader.readAsDataURL(file);
        });
        const image = await client.uploadFile({
          name: file.name || 'Screenshot',
          data,
          mime: file.type,
        });
        await addReference(image);
      }
    } catch (e) {
      setError(errorMessage(e, 'File upload failed; existing attachments preserved'));
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  };
  const removeImage = (id: string) =>
    workspace.update((data) => {
      data.attachmentIds = data.attachmentIds.filter((value) => value !== id);
    });
  const composerDelivery =
    composerAttempt &&
    snapshot.deliveries.find((d) => d.draftId === `composer-${composerAttempt.requestId}`);
  const composerSendBlocked =
    unsupportedFiles ||
    (!text.trim() && !images.length) ||
    uploading ||
    composerSending ||
    !routeReady ||
    sendGate(snapshot.codingState, snapshot.capabilities, routeTransport) === 'block';
  const sendComposer = async () => {
    if (dictation.requestSend()) {
      pendingAction.current = 'send';
      return;
    }
    await sendComposerNow();
  };
  const sendComposerNow = async () => {
    if (composerSendBlocked) return;
    setTerminalNotice(undefined);
    const prior =
      composerAttempt &&
      snapshot.deliveries.find((d) => d.draftId === `composer-${composerAttempt.requestId}`);
    const attempt =
      composerAttempt &&
      prior?.state !== 'failed' &&
      (prior ||
        (composerAttempt.text === text &&
          JSON.stringify(composerAttempt.attachmentIds ?? []) ===
            JSON.stringify(images.map((i) => i.id))))
        ? composerAttempt
        : { requestId: crypto.randomUUID(), text, attachmentIds: images.map((i) => i.id) };
    workspace.update((data) => {
      data.composerAttempt = attempt;
    });
    setComposerSending(true);
    setError('');
    try {
      // The server picks the route; the client never names a transport.
      const result = await call({ type: 'send-composer', ...attempt });
      apply(result);
      showTerminalFor(
        result.snapshot.deliveries.find((d) => d.draftId === `composer-${attempt.requestId}`),
        true,
      );
    } catch (e) {
      setError(errorMessage(e, 'Delivery uncertain; text preserved'));
    } finally {
      setComposerSending(false);
    }
  };
  const awaitingClaudeReplies = snapshot.deliveries.filter(isChannelAwaitingReply).length;
  const received = useReceivedFlash(
    snapshot.deliveries.filter((d) => d.transport === 'channel' && d.state === 'sent').length,
  );
  const newerSendBlocks =
    !!composerDelivery &&
    !isChannelAwaitingReply(composerDelivery) &&
    ['failed', 'unconfirmed', 'queued', 'sending'].includes(composerDelivery.state);
  const stripState: StripState | undefined =
    awaitingClaudeReplies > 0 && !newerSendBlocks
      ? 'waiting'
      : composerDelivery && !isChannelAwaitingReply(composerDelivery)
        ? composerDelivery.transport === 'channel' && composerDelivery.state === 'sent'
          ? received
            ? 'received'
            : undefined
          : composerDelivery.state === 'unconfirmed'
            ? 'unconfirmed'
            : composerDelivery.state === 'queued'
              ? 'queued'
              : composerDelivery.state === 'sending'
                ? 'sending'
                : composerDelivery.state === 'failed'
                  ? 'failed'
                  : received
                    ? 'received'
                    : 'delivered'
        : received
          ? 'received'
          : undefined;
  const stripReason = composerDelivery?.reason ? ': ' + composerDelivery.reason : '';
  const waitingText = `Waiting for Claude’s response${awaitingClaudeReplies > 1 ? ` (${awaitingClaudeReplies} messages)` : ''}`;
  const stripText =
    stripState === 'waiting'
      ? waitingText
      : stripState === 'unconfirmed'
        ? (isClaude ? 'Awaiting Claude confirmation' : 'Delivery uncertain') + stripReason
        : stripState === 'queued'
          ? 'Queued' + stripReason
          : stripState === 'sending'
            ? 'Sending' + stripReason
            : stripState === 'failed'
              ? (composerDelivery && isFailedUntyped(composerDelivery) ? 'Not sent' : 'Failed') +
                stripReason
              : stripState === 'received'
                ? 'Response received'
                : 'Delivered' + stripReason;
  const stripFading = useFading(stripState);
  const releaseComposer = async () => {
    if (
      !composerAttempt ||
      !window.confirm(
        'The previous message may still arrive. Release the composer without resending? Sending the same text again could duplicate it.',
      )
    )
      return;
    const requestId = composerAttempt.requestId;
    try {
      await workspace.releaseComposer(requestId, async () => {
        const result = await call({ type: 'release-composer', requestId });
        apply(result);
      });
    } catch (e) {
      setError(errorMessage(e, 'Could not release composer'));
    }
  };
  useEffect(() => {
    if (!composerAttempt) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await call({ type: 'check-composer', requestId: composerAttempt.requestId });
        apply(result);
      } catch {
        /* Keep text and retry only the read-only status check. */
      }
      if (!cancelled) timer = setTimeout(() => void check(), 2000);
    };
    timer = setTimeout(() => void check(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [composerAttempt?.requestId, snapshot.id]);
  const clearSelection = () =>
    workspace.update((data) => {
      data.selectedDiscussion = [];
    });
  const toggleSelection = (index: number) =>
    workspace.update((data) => {
      data.selectedDiscussion = (
        data.selectedDiscussion.includes(index)
          ? data.selectedDiscussion.filter((i) => i !== index)
          : [...data.selectedDiscussion, index]
      ).sort((a, b) => a - b);
    });
  const saveReview = (next: InstructionReview | null) =>
    workspace.update((data) => {
      data.review = next
        ? {
            draftId: next.draft.id,
            revision: next.draft.revision,
            localizedText: next.localizedText,
          }
        : null;
    });
  const { liveSize, discussionSize } = data.layout;
  const setLiveSize = (value: number) =>
    workspace.update((data) => {
      data.layout.liveSize = value;
    });
  const setDiscussionSize = (value: number) =>
    workspace.update((data) => {
      data.layout.discussionSize = value;
    });
  const feed = useRef<HTMLElement>(null);
  const discussionFeed = useRef<HTMLElement>(null);
  const pendingInputClear = useRef(new Map<string, string>());
  const belongsHere = (value: SessionEnvelope) =>
    value.sessionId === client.sessionId && value.snapshot.id === client.sessionId;
  const acknowledgeComposer = (value: SessionEnvelope) => {
    if (!belongsHere(value)) return;
    workspace.update((data) => {
      const attempt = data.composerAttempt;
      if (
        attempt &&
        value.snapshot.deliveries.some(
          (d) => d.draftId === `composer-${attempt.requestId}` && isDeliverySubmitted(d),
        )
      ) {
        if (data.composer === attempt.text) data.composer = '';
        data.attachmentIds = data.attachmentIds.filter((id) => !attempt.attachmentIds.includes(id));
        data.composerAttempt = null;
      }
    });
  };
  const apply = (value: SessionEnvelope, authoritativeConnection = false) => {
    acknowledgeComposer(value);
    const previous = workspace.envelope?.snapshot ?? initial.snapshot;
    if (!workspace.acceptEnvelope(value, authoritativeConnection)) return false;
    const next = value.snapshot;
    workspace.update((data) => {
      const saved = data.review;
      if (
        saved &&
        next.deliveries.some(
          (d) =>
            d.draftId === saved.draftId && d.revision >= saved.revision && isDeliverySubmitted(d),
        ) &&
        next.currentDraft?.id !== saved.draftId
      ) {
        const indices =
          previous.currentDraft?.id === saved.draftId
            ? (previous.currentDraft.selectedDiscussion ?? [])
            : [];
        data.selectedDiscussion = data.selectedDiscussion.filter((i) => !indices.includes(i));
        data.review = null;
      }
      for (const delivery of next.deliveries) {
        const key = [...pendingInputClear.current.keys()].find((key) =>
          key.startsWith(`${delivery.draftId}:`),
        );
        if (isDeliverySubmitted(delivery) && key) {
          if (!next.currentDraft && data.composer === pendingInputClear.current.get(key))
            data.composer = '';
          pendingInputClear.current.delete(key);
        }
      }
    });
    workspace.reconcileReview(next);
    if (next.currentDraft && !workspace.record.data.review)
      saveReview({ draft: next.currentDraft, localizedText: next.currentDraft.localizedText });
    return true;
  };
  useEffect(() => {
    const controller = new AbortController();
    apply(initial, true);
    void client.subscribe((value) => apply(value, true), controller.signal);
    return () => controller.abort();
  }, [client]);
  const run = async (action: Action) => {
    if (action.type === 'send' || action.type === 'send-review')
      pendingInputClear.current.set(`${action.draftId}:${action.revision}`, text);
    setError('');
    try {
      const value = await call(action);
      if (!belongsHere(value)) return false;
      apply(value);
      return true;
    } catch (e) {
      setError(errorMessage(e, 'Action failed'));
      return false;
    }
  };
  const discussing = useRef(false);
  const submit = () => {
    if (dictation.requestSend()) {
      pendingAction.current = 'discuss';
      return;
    }
    discussNow();
  };
  const discussNow = () => {
    if (discussing.current || uploading || (!text.trim() && !images.length)) return;
    setAssistantMode('full');
    const value = text;
    const ids = images.map((image) => image.id);
    discussing.current = true;
    void run({ type: 'discuss', text: value, ...(ids.length ? { attachmentIds: ids } : {}) })
      .then((ok) => {
        if (ok)
          workspace.update((data) => {
            if (data.composer === value) data.composer = '';
            data.attachmentIds = data.attachmentIds.filter((id) => !ids.includes(id));
          });
      })
      .finally(() => {
        discussing.current = false;
      });
  };
  useEffect(() => {
    if (!dictationSend) return;
    const action = pendingAction.current;
    pendingAction.current = 'send';
    if (action === 'discuss') discussNow();
    else void sendComposerNow();
  }, [dictationSend]);
  // Cmd/Ctrl+Shift+M anywhere toggles dictation, except while typing in another field or with a modal dialog open
  // that does not hold the composer (the composer's own keydown handles it first and prevents the default).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isDictationShortcut(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      const dialog = document.querySelector('dialog[open]');
      if (
        target &&
        target !== textarea.current &&
        target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      )
        return;
      if (dialog && !(textarea.current && dialog.contains(textarea.current))) return;
      e.preventDefault();
      dictationRef.current.press();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const draft = snapshot.currentDraft;
  const delivery =
    review &&
    snapshot.deliveries.find(
      (item) => item.draftId === review.draft.id && item.revision === review.draft.revision,
    );
  const ordered = recentMessages(
    snapshot.codingMessages,
    snapshot.codingMessages.length,
    snapshot.target?.agent,
  );
  const latestReply =
    [...ordered].reverse().find((message) => message.role === 'assistant') ?? ordered.at(-1);
  const visibleMessages = liveHistory ? ordered : latestReply ? [latestReply] : [];
  const indexedDiscussion = snapshot.discussion.map((m, index) => ({ ...m, index }));
  const visibleDiscussion = assistantHistory ? indexedDiscussion : indexedDiscussion.slice(-1);
  const beforeEarlierMessages = useHistoryScroll(
    feed,
    liveHistory,
    visibleMessages.map((m) => `${m.sourceId}:${m.revision}:${m.translationStatus ?? ''}`).join(),
  );
  useHistoryScroll(
    discussionFeed,
    assistantHistory,
    `${visibleDiscussion.length}:${snapshot.discussion.at(-1)?.text.length ?? 0}`,
  );
  const prepareSelected = async (replaceConfirmed = false) => {
    if (!selected.length || preparing) return;
    if ((review || draft) && !replaceConfirmed) {
      setReplaceOpen(true);
      return;
    }
    setReplaceOpen(false);
    setReviewOpen(false);
    setPreparing(true);
    setReviewError('');
    setError('');
    const expected = draft ? { id: draft.id, revision: draft.revision } : undefined;
    try {
      const result = await call({
        type: 'prepare',
        indices: selected,
        ...(expected ? { expected } : {}),
      });
      if (apply(result) && result.review) {
        saveReview({ draft: result.review, localizedText: result.review.localizedText });
        setReviewOpen(true);
      }
    } catch (e) {
      setError(errorMessage(e, 'Preparation failed'));
    } finally {
      setPreparing(false);
    }
  };
  const resetInstruction = async () => {
    const current = snapshot.currentDraft;
    if (preparing) return;
    if (!current) {
      saveReview(null);
      setReviewOpen(false);
      setReplaceOpen(false);
      setResetOpen(false);
      setReviewError('');
      setResetError('');
      return;
    }
    setPreparing(true);
    setResetError('');
    try {
      const result = await call({
        type: 'reset-instruction',
        draftId: current.id,
        revision: current.revision,
      });
      for (const key of pendingInputClear.current.keys())
        if (key.startsWith(`${current.id}:`)) pendingInputClear.current.delete(key);
      if (!apply(result)) return;
      saveReview(null);
      setReviewOpen(false);
      setReplaceOpen(false);
      setResetOpen(false);
      setReviewError('');
      setError('');
    } catch (e) {
      setResetError(errorMessage(e, 'Reset failed; instruction preserved'));
    } finally {
      setPreparing(false);
    }
  };
  const sendReview = async () => {
    if (!review || preparing || !routeReady) return;
    setTerminalNotice(undefined);
    setPreparing(true);
    setReviewError('');
    pendingInputClear.current.set(`${review.draft.id}:${review.draft.revision}`, text);
    try {
      const result = await call({
        type: 'send-review',
        draftId: review.draft.id,
        revision: review.draft.revision,
        localizedText: review.localizedText,
      });
      if (!belongsHere(result)) return;
      const accepted = apply(result);
      // Newest first: a retry claims a later revision, and an older declined delivery keeps its in-memory flag.
      const terminalShown = showTerminalFor(
        result.snapshot.deliveries.findLast(
          (d) => d.draftId === review.draft.id && d.revision >= review.draft.revision,
        ),
      );
      const sent = result.snapshot.deliveries.some(
        (d) =>
          d.draftId === review.draft.id &&
          d.revision >= review.draft.revision &&
          isDeliverySubmitted(d),
      );
      if (sent)
        workspace.update((data) => {
          if (
            data.review?.draftId === review.draft.id &&
            data.review.revision <= review.draft.revision
          ) {
            data.selectedDiscussion = data.selectedDiscussion.filter(
              (index) => !review.draft.selectedDiscussion?.includes(index),
            );
            data.review = null;
          }
          if (!workspace.envelope?.snapshot.currentDraft && data.composer === text)
            data.composer = '';
        });
      // The modal review would cover the terminal just shown; the review stays saved for Resume review.
      else if (terminalShown) setReviewOpen(false);
      else if (accepted) setReviewOpen(true);
    } catch (e) {
      setReviewError(errorMessage(e, 'Delivery failed'));
      setReviewOpen(true);
    } finally {
      setPreparing(false);
    }
  };
  useEffect(() => {
    if (liveHistory) return;
    const container = feed.current;
    const replies = container?.querySelectorAll<HTMLElement>('.message.assistant');
    const reply = replies?.item(replies.length - 1);
    if (container && reply)
      container.scrollTop +=
        reply.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
  }, [snapshot.sourceRevision, latestReply?.translationStatus, liveHistory]);
  const newestAssistant = [...snapshot.codingMessages]
    .filter((m) => m.role === 'assistant')
    .sort((a, b) => b.revision - a.revision)[0];
  const liveState: 'arriving' | 'translating' | undefined =
    newestAssistant && !newestAssistant.complete && snapshot.codingState === 'working'
      ? 'arriving'
      : newestAssistant?.translationStatus === 'pending'
        ? 'translating'
        : undefined;
  const newestReply = snapshot.discussion.filter((t) => t.role === 'assistant').at(-1);
  const assistantState: 'arriving' | undefined =
    newestReply && newestReply.complete === false ? 'arriving' : undefined;
  // Spec 5: an outside Claude session has no terminal to show, so Split and Terminal give way to Move to Gloss.
  const offerMove = isClaude && !launchId;
  const liveSwitch = (
    <>
      <ViewRadios
        label="Live Conversation view"
        value={liveView}
        onChange={chooseLiveView}
        options={LIVE_VIEWS.filter((view) => !(offerMove && showsTerminal(view))).map((view) => {
          if (view === 'activity') {
            const running = snapshot.codingState !== 'disconnected' && snapshot.activity?.running;
            return {
              value: view,
              label: LIVE_VIEW_LABELS[view],
              disabled: !isClaude,
              title: isClaude ? undefined : NO_ACTIVITY_TOOLTIP,
              badge: running ? <span className="live-view-count">{running}</span> : undefined,
            };
          }
          const unavailable = showsTerminal(view) && !launchId;
          return {
            value: view,
            label: LIVE_VIEW_LABELS[view],
            disabled: unavailable,
            title: unavailable ? NO_TERMINAL_TOOLTIP : undefined,
            badge: view === 'terminal' && approval && (
              <span className="live-view-dot" aria-hidden="true" />
            ),
          };
        })}
      />
      {offerMove && <MoveSessionHere client={client} />}
      {launchId && entry?.attentionNotice && (
        <small className="live-attention-notice" dir="auto">
          {entry.attentionNotice}
        </small>
      )}
      {launchId && terminalNotice && (
        <small className="live-attention-notice" role="status" dir="auto">
          {terminalNotice}
        </small>
      )}
      {moveNotice && (
        <small className="live-attention-notice" role="status" dir="auto">
          {moveNotice}
        </small>
      )}
    </>
  );
  const liveFeed = (
    <section ref={feed} className="feed" aria-label="Live Hebrew conversation">
      {liveHistory && snapshot.historyCursor && (
        <button
          onClick={() => {
            beforeEarlierMessages();
            void run({ type: 'older-history' });
          }}
        >
          Load earlier messages
        </button>
      )}
      {visibleMessages.length === 0 && (
        <p className="discussion-empty">Waiting for the next assistant response.</p>
      )}
      {visibleMessages.map((m) => (
        <Message
          key={m.sourceId}
          message={m}
          client={client}
          replyLanguage={languageSettings.reply}
          assist={languageSettings.assist}
          original={
            m.role === 'assistant' &&
            (conversationView === 'original' || !needsReplyTranslation(languageSettings))
          }
          onTranslate={() =>
            void call({ type: 'translate-message', sourceId: m.sourceId }).catch((e) =>
              setError(errorMessage(e, 'Translation failed')),
            )
          }
        />
      ))}
    </section>
  );
  const terminalShown = launchId !== undefined && showsTerminal(liveView);
  // Children keep fixed slots so the terminal stays one mounted connection across Split and Terminal.
  const livePanel = (
    <ReadingPane
      title="Live Conversation"
      name="live"
      liveState={liveState}
      history={liveHistory}
      controls={liveSwitch}
      onHistory={() => {
        if (liveView === 'terminal') {
          chooseLiveView(historyView(liveView));
          setLiveHistory(true);
        } else setLiveHistory((value) => !value);
      }}
    >
      <div
        className="live-body"
        data-view={liveView}
        dir="ltr"
        style={
          {
            '--terminal-share': liveLayout.split,
            '--conversation-share': 100 - liveLayout.split,
          } as CSSProperties
        }
      >
        {terminalShown && (
          <LiveTerminal
            launchId={launchId}
            client={client}
            attention={approval}
            autoFocus={terminalFocus}
            onDraft={(hasDraft) => {
              terminalDraft.current = hasDraft;
            }}
          />
        )}
        {liveView === 'split' && (
          <PaneDivider
            name="Resize terminal"
            responsive
            // The divider measures the right (or, stacked, the top) pane; the terminal is left and on top.
            value={wideLayout ? 100 - liveLayout.split : liveLayout.split}
            change={(value) =>
              setLiveLayout({ split: clampLayoutSize(wideLayout ? 100 - value : value) })
            }
          />
        )}
        {liveView === 'activity' && (
          <ActivityView
            client={client}
            activity={snapshot.activity}
            codingState={snapshot.codingState}
            agentIsClaude={isClaude}
          />
        )}
        {liveView !== 'terminal' && liveView !== 'activity' && (
          <div className="live-conversation">
            {liveView === 'split' && (
              <ViewRadios
                label="Conversation side"
                value={liveLayout.conversation}
                onChange={chooseConversation}
                options={CONVERSATION_VIEWS.map((view) => ({
                  value: view,
                  label: LIVE_VIEW_LABELS[view],
                }))}
              />
            )}
            {liveFeed}
          </div>
        )}
      </div>
    </ReadingPane>
  );
  const assistantPanel = (
    <ReadingPane
      title="Language Assistant"
      name="assistant"
      liveState={assistantState}
      history={assistantHistory}
      onHistory={() => setAssistantHistory((value) => !value)}
    >
      <section ref={discussionFeed} className="discussion" aria-label="Language discussion">
        {snapshot.discussion.length === 0 && (
          <p className="discussion-empty">כתבו כאן בעברית כדי לדון ולחדד את הבקשה.</p>
        )}
        {visibleDiscussion.map((m) => (
          <article
            key={m.index}
            data-discussion-index={m.index}
            className={
              'message language ' + m.role + (selected.includes(m.index) ? ' selected-message' : '')
            }
          >
            <small>
              {m.role === 'user' ? 'You · language assistant' : 'Language assistant · Hebrew reply'}
            </small>
            <SummarizableResponse
              client={client}
              kind="discussion"
              messageId={m.id ?? `${snapshot.id}:legacy:${m.index}`}
              text={m.text}
              complete={m.role === 'assistant' && (m.complete ?? !!m.text.trim())}
              assist={languageSettings.assist}
            >
              <RichText
                language={m.role === 'assistant' ? snapshot.language : 'auto'}
                text={m.text || (m.attachments?.length ? '' : '…')}
              />
            </SummarizableResponse>
            <ReferenceImages images={m.attachments} client={client} />
            <button
              type="button"
              className="select-answer"
              aria-pressed={selected.includes(m.index)}
              disabled={!m.text.trim() && !m.attachments?.length}
              onClick={() => toggleSelection(m.index)}
            >
              {selected.includes(m.index) ? 'Selected · Remove from answer' : 'Add to answer'}
            </button>
          </article>
        ))}
        {snapshot.sourceGaps
          ?.filter(
            (g) =>
              g !==
              'Live replay starts in a bounded tail; older messages are available through history.',
          )
          .map((g) => (
            <p className="notice" key={g}>
              History gap: {g}
            </p>
          ))}
      </section>
      <div className="preparation-controls">
        <button type="button" className="selection-count" onClick={() => setSelectionOpen(true)}>
          {selected.length} selected
        </button>
        <button
          className="primary"
          disabled={!selected.length || preparing}
          onClick={() => void prepareSelected()}
        >
          {preparing ? 'Preparing…' : 'Prepare instruction'}
        </button>
        {review && (
          <>
            <button onClick={() => setReviewOpen(true)}>Resume review</button>
            <button
              disabled={preparing}
              onClick={() => {
                setResetError('');
                setResetOpen(true);
              }}
            >
              Reset instruction
            </button>
          </>
        )}
      </div>
    </ReadingPane>
  );
  const composerPanel = (
    <ReadingPane title="Chat with the Language Assistant" name="composer">
      {isClaude && route && (route.transport !== 'tmux' || moveShown) && (
        <ClaudeConnection client={client} status={channelStatus} />
      )}
      {stripState && (
        <ComposerStatus state={stripState} text={stripText} fading={stripFading}>
          {stripState !== 'waiting' && awaitingClaudeReplies > 0 && (
            <small className="status-strip-waiting" dir="auto">
              {waitingText}
            </small>
          )}
          {composerDelivery &&
            ['unconfirmed', 'queued'].includes(composerDelivery.state) &&
            !isChannelAwaitingReply(composerDelivery) && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    void call({ type: 'check-composer', requestId: composerAttempt!.requestId })
                      .then(apply)
                      .catch((e) => setError(String(e)))
                  }
                >
                  Check delivery
                </button>
                <button type="button" onClick={() => void releaseComposer()}>
                  Release composer
                </button>
                <small>The previous message may still arrive. Releasing does not resend it.</small>
              </>
            )}
        </ComposerStatus>
      )}
      <form
        className={
          'composer' +
          (['recording', 'starting', 'downloading'].includes(dictation.state.phase)
            ? ' composer-recording'
            : '') +
          (awaitingClaudeReplies > 0 ? ' attn-ring' : '')
        }
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes('Files') ||
            e.dataTransfer.types.includes(FILE_DRAG_TYPE)
          )
            e.preventDefault();
        }}
        onDrop={(e) => {
          const internal = e.dataTransfer.getData(FILE_DRAG_TYPE);
          if (internal) {
            e.preventDefault();
            try {
              const value = JSON.parse(internal);
              if (value.sessionId !== client.sessionId || typeof value.relativePath !== 'string')
                throw new Error('Drop a file from this session');
              void attachPath(value.relativePath);
            } catch (error) {
              setError(errorMessage(error, 'Invalid file drop'));
            }
            return;
          }
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            if (
              Array.from(e.dataTransfer.items).some(
                (item) => item.webkitGetAsEntry?.()?.isDirectory,
              )
            ) {
              setError('Directories are not supported; attach individual files');
              return;
            }
            void addImages(Array.from(e.dataTransfer.files));
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void sendComposer();
        }}
      >
        <label htmlFor="composer">שוחח עם עוזר השפה</label>
        <div className="composer-input" dir={languageDirection(languageSettings.write)}>
          <textarea
            aria-autocomplete="list"
            aria-controls={mention || invocation ? pickerId : undefined}
            aria-activedescendant={mention || invocation ? activeOption : undefined}
            ref={textarea}
            onClick={(e) => detectMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                detectMention(e.currentTarget.value, e.currentTarget.selectionStart);
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((file) =>
                file.type.startsWith('image/'),
              );
              if (files.length) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            id="composer"
            aria-label="Discuss with language assistant"
            value={text}
            onChange={(e) => {
              setComposerText(e.target.value);
              detectMention(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={(e) => {
              noteKeystroke();
              if (e.key === 'Escape' && dictation.escape()) {
                e.preventDefault();
                return;
              }
              if (isDictationShortcut(e)) {
                e.preventDefault();
                dictation.press();
                return;
              }
              if (e.key === 'Enter' && e.altKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const input = e.currentTarget;
                const start = input.selectionStart;
                const next =
                  input.value.slice(0, start) + '\n' + input.value.slice(input.selectionEnd);
                if (next === input.value) {
                  // No text update means the layout effect will not run.
                  pendingCaret.current = undefined;
                  input.setSelectionRange(start + 1, start + 1);
                } else {
                  pendingCaret.current = start + 1;
                  setComposerText(next);
                }
                detectMention(next, start + 1);
                return;
              }
              if (
                !e.nativeEvent.isComposing &&
                !(e.key === 'Enter' && (e.shiftKey || e.altKey)) &&
                (mention || invocation) &&
                picker.current?.key(e.key)
              ) {
                e.preventDefault();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void sendComposer();
              }
            }}
            dir={languageDirection(languageSettings.write)}
            placeholder={languageSettings.write === 'he' ? 'כתוב בעברית…' : 'Write in English…'}
          />
          <span className="dictation-control">
            <DictationButton dictation={dictation} language={dictationLanguage} />
          </span>
        </div>
        {mention && (
          <FilePicker
            key={client.sessionId + ':' + mention.start}
            ref={picker}
            listboxId={pickerId}
            onActiveOption={setActiveOption}
            sessionId={client.sessionId}
            query={mention.query}
            onChoose={(path) => openPreview(path, mention)}
            onClose={() => setMention(null)}
          />
        )}
        {invocation && !mention && (
          <InventoryPicker
            key={client.sessionId + ':' + invocation.kind + ':' + invocation.start}
            ref={picker}
            listboxId={pickerId}
            onActiveOption={setActiveOption}
            sessionId={client.sessionId}
            kind={invocation.kind}
            query={invocation.query}
            onChoose={insertInvocation}
            onClose={() => setInvocation(null)}
          />
        )}
        <ImageAttachments
          client={client}
          images={images}
          busy={uploading}
          add={(files) => void addImages(files)}
          remove={removeImage}
        >
          <div className="composer-actions">
            <button
              type="button"
              disabled={uploading || (!text.trim() && !images.length)}
              onClick={submit}
            >
              Discuss first
            </button>
            <button
              type="button"
              title={
                unsupportedFiles ? 'This coding agent does not support file references' : undefined
              }
              disabled={composerSendBlocked}
              aria-label={terminalDestinationLabel()}
              onClick={() => void sendComposer()}
            >
              Send to agent
            </button>
            {isClaude && <RouteLine client={client} route={route} />}
          </div>
        </ImageAttachments>
        <small>
          Enter sends to agent · {hostPlatform() === 'darwin' ? 'Option' : 'Alt'}+Enter or
          Shift+Enter adds a line · {dictationShortcutLabel()} dictates
        </small>
      </form>
    </ReadingPane>
  );
  // The column comes before or after the workspace in the DOM, so Tab order matches its side. Flipping the side
  // remounts the column (the workspace itself never moves), so the side button is refocused after the flip.
  const filesColumn = filesOpen && (
    <FileBrowser
      client={client}
      revealedFile={revealedFile}
      onPreview={(path) => openPreview(path)}
      column={{
        side: preferences.filesSide,
        sideButton: filesSideToggle,
        onSide: (filesSide) => {
          refocusFilesSide.current = true;
          setPreferences((value) => ({ ...value, filesSide }));
        },
        onClose: () => closeFiles(),
      }}
    />
  );
  return (
    <FileLinkContext.Provider value={{ root: record.canonicalRoot, open: openFileLink }}>
      <RunCommandContext.Provider value={{ run: onRun }}>
        <ImageSessionContext.Provider value={client}>
          <div className="session-header" dir="ltr">
            <b>
              {record.projectName} /{' '}
              {(record.worktreePath ?? record.target.projectId).split('/').filter(Boolean).at(-1)}
            </b>
            <span>{record.target.agent === 'claude' ? 'Claude' : 'Codex'}</span>
            <span>
              {entry && !(entry.key.startsWith('saved:') && entry.availability === 'available')
                ? activityLabel(entry)
                : snapshot.codingState === 'approval-required'
                  ? 'Approval required'
                  : snapshot.codingState === 'dialog-open'
                    ? DIALOG_OPEN_REASON
                    : snapshot.codingState[0]!.toUpperCase() + snapshot.codingState.slice(1)}
            </span>
            <UsageReadout
              sessionId={record.id}
              provider={record.target.agent}
              usage={usage?.[record.target.agent]}
            />
            <SessionLanguageControl client={client} settings={languageSettings} />
          </div>
          <QuotaBreakDialog provider={record.target.agent} usage={usage?.[record.target.agent]} />
          <div className="file-workspace" data-side={preferences.filesSide}>
            {preferences.filesSide === 'left' && filesColumn}
            <main className="app" dir="rtl">
              <MovableWorkspace
                assistantMode={assistantMode}
                toolbar={
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setAssistantMode(assistantMode === 'full' ? 'compact' : 'full')
                      }
                    >
                      {assistantMode === 'full' ? 'Minimize Assistant' : 'Show full Assistant'}
                    </button>
                    <button
                      ref={filesToggle}
                      type="button"
                      className="files-toggle"
                      aria-expanded={filesOpen}
                      onClick={() => (filesOpen ? closeFiles(false) : setFilesOpen(true))}
                    >
                      Files
                    </button>
                  </>
                }
                layout={data.layout}
                onLayout={(layout) =>
                  workspace.update((data) => {
                    data.layout = layout;
                  })
                }
                panels={{ live: livePanel, assistant: assistantPanel, composer: composerPanel }}
                liveSize={liveSize}
                discussionSize={discussionSize}
                setLiveSize={setLiveSize}
                setDiscussionSize={setDiscussionSize}
              />
              {snapshot.codingState === 'disconnected' && (
                <p className="notice">
                  This saved session is unavailable. Your workspace is preserved. Reconnect same
                  target to try again.
                </p>
              )}
              {workspace.conflict && (
                <aside className="workspace-notice" role="alert">
                  <strong>Workspace changed in another tab</strong>
                  <p>Your local content is preserved until you choose.</p>
                  <details>
                    <summary>Saved content</summary>
                    <pre>{workspace.conflict.data.composer}</pre>
                  </details>
                  <button onClick={() => workspace.resolveUseSaved()}>Use saved</button>
                  <button onClick={() => void workspace.resolveKeepLocal()}>Keep local</button>
                </aside>
              )}
              {workspace.error && (
                <p role="alert">
                  {workspace.error}
                  <button onClick={() => void workspace.flush()}>Retry save</button>
                </p>
              )}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              {review && (
                <InstructionReviewDialog
                  review={review}
                  open={reviewOpen}
                  busy={preparing}
                  routeReady={routeReady}
                  blocked={
                    sendGate(snapshot.codingState, snapshot.capabilities, routeTransport) ===
                    'block'
                  }
                  {...(delivery ? { delivery } : {})}
                  error={reviewError}
                  onChange={(value) => saveReview({ ...review, localizedText: value })}
                  onClose={() => setReviewOpen(false)}
                  onSend={() => void sendReview()}
                  onReset={() => {
                    setResetError('');
                    setResetOpen(true);
                  }}
                />
              )}
              <ResetInstructionDialog
                open={resetOpen}
                pending={Boolean(delivery && isDeliveryUnresolved(delivery))}
                busy={preparing}
                error={resetError}
                close={() => setResetOpen(false)}
                reset={() => void resetInstruction()}
              />
              <ReplaceInstructionDialog
                language={snapshot.language}
                open={replaceOpen}
                text={indexedDiscussion
                  .filter((m) => selected.includes(m.index))
                  .map((m) => m.text)
                  .join('\n\n---\n\n')}
                close={() => setReplaceOpen(false)}
                keep={() => {
                  setReplaceOpen(false);
                  setReviewOpen(true);
                }}
                replace={() => void prepareSelected(true)}
              />
              <SelectionDialog
                language={snapshot.language}
                open={selectionOpen}
                messages={indexedDiscussion.filter((m) => selected.includes(m.index))}
                close={() => setSelectionOpen(false)}
                remove={toggleSelection}
                clear={clearSelection}
              />
            </main>
            {preferences.filesSide === 'right' && filesColumn}
          </div>
          {previewOpen && preview && (
            <FilesWindow
              client={client}
              languageSettings={languageSettings}
              path={preview.path}
              onClose={closePreview}
              busy={uploading}
              attachError={attachError}
              attached={preview.attached ?? ''}
              onAttach={() => void attachPath(preview.path, preview.token, true)}
              geometry={preferences.filesWindow}
              onGeometry={(next) => setPreferences((value) => ({ ...value, filesWindow: next }))}
            />
          )}
        </ImageSessionContext.Provider>
      </RunCommandContext.Provider>
    </FileLinkContext.Provider>
  );
}
