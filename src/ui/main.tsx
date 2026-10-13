import React, { useEffect, useState, useRef, useId } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConversationSnapshot, AgentMessage } from '../core/contracts.js';
import type { Action } from '../runtime/protocol.js';
import { recentMessages } from './history.js';
import './styles.css';
import { ImageAttachments, ReferenceImages, ImageSessionContext } from './image-attachments.js';
import { FileBrowser, FilePreviewDialog, FILE_DRAG_TYPE } from './file-browser.js';
import { FilePicker, type FilePickerHandle } from './file-picker.js';
import type { CardReference } from './attachment-cards.js';
import type { FileReference } from '../core/file-references.js';
import { MovableWorkspace } from './movable-workspace.js';
import { useDisplayPreferences, pruneDisplayPreferences, type AssistantMode } from './display-preferences.js';
import { SelectionDialog, ReplaceInstructionDialog, ResetInstructionDialog, PanelDialog } from './composer-dialogs.js';
import { InstructionReviewDialog, type InstructionReview } from './instruction-review.js';
import { FileLinkContext, localFilePath } from './file-links.js';
import { RichText } from './rich-text.js';
import { SummarizableResponse } from './response-summary.js';
import { ReadingPane } from './reading-pane.js';
import { REFERENCE_MARK, SessionClient, sessionRequest, forgetFolder, type SessionEnvelope } from './session-client.js';
import { useWorkspace, workspaceFor } from './use-workspace.js';
import { useSessionCatalog } from './use-session-catalog.js';
import { SessionsSidebar as SessionSwitcher } from './sessions-sidebar.js';
import { TerminalPopup } from './terminal-popup.js';
import { usePopupMode, useAutoOpenTerminal, useAutoOpenWaitingLaunch, useKeystrokeTracker, lastKeystrokeAt, noteKeystroke, retryLaunch } from './launch-controls.js';
import { SessionTabs } from './session-tabs.js';
import { NewSessionDialog } from './new-session-dialog.js';
import { useProjects } from './use-projects.js';
import { CreateWorktreeDialog, DeleteWorktreeDialog, InitGitDialog, defaultWorktreeLocation, type WorktreeProject } from './worktree-dialogs.js';
import { activityLabel, sessionTitle, buildProjectTree, mergeSavedRecords, visibleProjectTree, applySidebarSettings, removableSessions, chooseSessionForFolder, folderKeyFor, folderInside, reorderVisible, type FolderNode, type ProjectNode } from './session-navigation.js';
import type { CatalogEntry } from '../core/session-catalog.js';
import { terminalDestinationLabel } from './provider-label.js';
import type { SessionRecord } from '../core/session-contracts.js';
import type { CreatedWorktree, WorktreeRemoval } from '../runtime/application.js';
import { SessionLanguageControl } from './language-controls.js';
import { languageDirection, legacyLanguageSettings, needsReplyTranslation } from '../core/language-settings.js';
import { ClaudeConnection, useClaudeConnection } from './claude-connection.js';
import { canSendWhileWorking, isChannelAwaitingReply, isDeliverySubmitted } from '../core/contracts.js';
window.addEventListener('hashchange', () => window.location.reload());
const token = new URLSearchParams(location.hash.slice(1)).get('capability');
const headers = token ? { Authorization: 'Bearer ' + token, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
function Message({ message, original, replyLanguage, assist, client, onTranslate }: { message: AgentMessage; original: boolean; replyLanguage: string; assist: string; client:SessionClient; onTranslate?: () => void }) {
 const status = message.translationStatus;
 const body = original ? <RichText language="auto" text={message.text} /> : <RichText language={status === 'complete' ? replyLanguage : 'auto'} text={status === 'complete' ? (message.translatedText ?? message.text) : status === 'error' ? 'Translation failed. Original available below.' : status === 'pending' || (status === undefined && !message.complete) ? 'Translating…' : message.text} />;
 return <article data-source-id={message.sourceId} data-sequence={message.revision} data-translation-status={original ? 'original' : status ?? 'none'} className={'message ' + message.role}><small>{message.role === 'assistant' ? (original ? 'Coding agent · original' : 'Coding agent · translated') : 'Coding agent · original user message'}</small><SummarizableResponse client={client} kind="coding" messageId={message.sourceId} text={message.text} complete={message.role==='assistant'&&message.complete===true} assist={assist}>{body}</SummarizableResponse>{!original && status === undefined && message.role === 'assistant' && message.complete && onTranslate && <button type="button" className="translate-one" onClick={onTranslate}>Translate</button>}{!original && <details><summary>Original</summary><pre dir="ltr">{message.text}</pre></details>}</article>;
}
function SessionWorkspace({ initial, record, entry }: { initial: SessionEnvelope; record: SessionRecord; entry?: CatalogEntry | undefined }) {
  const client = useRef(new SessionClient(record.id)).current;
  const isClaude = record.target.agent === 'claude';
  const channelStatus = useClaudeConnection(client, isClaude);
  const channelReady = !isClaude || channelStatus.state === 'connected';
  const workspace = useWorkspace(record.id);
  const popupMode = usePopupMode(); const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalTitle = record.sessionTitle ?? (record.target.agent === 'claude' ? 'Claude' : 'Codex');
  useAutoOpenTerminal(entry, record.id, popupMode, lastKeystrokeAt, () => setTerminalOpen(true));
  const [preferences,setPreferences] = useDisplayPreferences();
  const assistantMode = preferences.assistantModes[record.id] ?? 'compact';
  const setAssistantMode = (mode:AssistantMode) => setPreferences(value=>({...value,assistantModes:{...value.assistantModes,[record.id]:mode}}));
  const data = workspace.record.data;
  const call = (action: Action) => client.action(action);

  const snapshot = workspace.envelope?.snapshot ?? initial.snapshot; const languageSettings = snapshot.languageSettings ?? legacyLanguageSettings(snapshot.language); const text = data.composer; const [error, setError] = useState('');
  const [liveHistory, setLiveHistory] = useState(false);
  const [assistantHistory, setAssistantHistory] = useState(false);
  const selected = data.selectedDiscussion;
  const review: InstructionReview | null = snapshot.currentDraft && data.review?.draftId === snapshot.currentDraft.id && data.review.revision === snapshot.currentDraft.revision ? { draft: snapshot.currentDraft, localizedText: data.review.localizedText } : null;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [reviewError, setReviewError] = useState('');

  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [imageMetadata, setImages] = useState<CardReference[]>([]);
  const images = data.attachmentIds.map(id => imageMetadata.find(image => image.id === id) ?? {id,name:'Loading reference',mime:'',size:0,status:'Loading metadata…'});
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [composerSending, setComposerSending] = useState(false);
  const composerAttempt = data.composerAttempt;
  const unsupportedFiles = images.some(file=>'kind' in file&&file.kind==='file') && !snapshot.capabilities?.fileReferences;
  const setComposerText = (value: React.SetStateAction<string>) => workspace.update(data => { data.composer = typeof value === 'function' ? value(data.composer) : value; });
  useEffect(() => {
    let active = true;
    void Promise.all(data.attachmentIds.map(id => client.fileMetadata(id).catch(() => ({ id, name: 'Unavailable reference', mime: '', size: 0, status: 'File unavailable or unreadable' })))).then(next => { if (active) setImages(next); });
    return () => { active = false; };
  }, [data.attachmentIds.join(','), client]);
  const addReference = async (file: FileReference): Promise<void> => {
    const ids=workspace.record.data.attachmentIds;
    if(ids.includes(file.id))return;
    if(ids.length>=10)throw new Error('Attach at most 10 files');
    if(file.kind==='image') {
      const existing=await Promise.all(ids.map(id=>client.fileMetadata(id)));
      if(JSON.stringify(ids)!==JSON.stringify(workspace.record.data.attachmentIds))return addReference(file);
      if(existing.filter(item=>item.kind==='image').length>=4)throw new Error('Attach at most 4 images');
    }
    workspace.update(data=>{if(!data.attachmentIds.includes(file.id))data.attachmentIds.push(file.id);});
    setImages(previous=>[...previous.filter(item=>item.id!==file.id),file]);
  };
  const textarea=useRef<HTMLTextAreaElement>(null);
  const picker=useRef<FilePickerHandle>(null);
  const pickerId=useId();
  const [activeOption,setActiveOption]=useState<string|undefined>();
  const [mention,setMention]=useState<{start:number;end:number;query:string}|null>(null);
  const detectMention=(value:string,caret:number)=>{const match=/(?:^|\s)@([^\s@]*)$/.exec(value.slice(0,caret));setMention(match?{start:caret-match[1]!.length-1,end:caret,query:match[1]!}:null);};
  const [filesOpen,setFilesOpen]=useState(false);
  const [revealedFile,setRevealedFile]=useState('');
  const [preview,setPreview]=useState<{path:string;token:typeof mention;attached?:string}|null>(null);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const openPreview=(path:string,token:typeof mention=null)=>{setError('');setPreview({path,token});setMention(null);};
  const openFileLink=(href:string,basePath='')=>{try {const path=localFilePath(href,record.canonicalRoot,basePath);setFilesOpen(true);setRevealedFile(path);openPreview(path);} catch(error) {setError(error instanceof Error?error.message:'File unavailable');}};
  const attachPath=async(path:string,token:typeof mention=null)=>{
    if(uploadLock.current)return;
    uploadLock.current=true;setUploading(true);setError('');
    setPreview(current=>current?.path===path?{...current,attached:''}:current);
    try {
      const file=await client.referenceFile(path);
      if(file.sessionId!==client.sessionId)throw new Error('Attachment does not belong to this session');
      await addReference(file);
      workspace.update(data=>{
        const reference=`@${file.kind==='image'?'Image':'File'} ${file.index}`;
        if(new RegExp(reference+'(?![0-9])').test(data.composer))return;
        if(token && data.composer.slice(token.start,token.end)==='@'+token.query && !/[^\s]/.test(data.composer[token.end]??''))data.composer=data.composer.slice(0,token.start)+REFERENCE_MARK+reference+' '+data.composer.slice(token.end);
        else data.composer+=(data.composer && !/\s$/.test(data.composer)?' ':'')+REFERENCE_MARK+reference+' ';
      });
      if(mounted.current){setMention(null);setPreview(current=>current?.path===path?{...current,attached:`Attached as ${file.kind==='image'?'Image':'File'} ${file.index}`}:current);}
    } catch(e) {if(mounted.current)setError(e instanceof Error?e.message:'File unavailable');}
    finally {uploadLock.current=false;if(mounted.current)setUploading(false);}
  };
  const addImages = async (files: File[]) => {
    if(uploadLock.current) { setError('Wait for the current files to finish attaching'); return; }
    if(files.length+workspace.record.data.attachmentIds.length>10) {setError('Attach at most 10 files');return;}
    uploadLock.current=true;setUploading(true);setError('');
    try {
      for(const file of files) {
        if(file.size>10*1024*1024) throw new Error('Use files up to 10 MB');
        const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.onerror=()=>reject(new Error('Could not read file'));reader.readAsDataURL(file);});
        const image = await client.uploadFile({name:file.name||'Screenshot',data,mime:file.type});
        await addReference(image);

      }
    } catch(e) {setError(e instanceof Error?e.message:'File upload failed; existing attachments preserved');}
    finally {uploadLock.current=false;setUploading(false);}
  };
  const removeImage = (id: string) => workspace.update(data => { data.attachmentIds = data.attachmentIds.filter(value => value !== id); });
  const composerSendBlocked = (transport: 'channel' | 'peer') => unsupportedFiles || (!text.trim() && !images.length) || uploading || composerSending || (snapshot.codingState !== 'idle' && !(snapshot.codingState === 'working' && canSendWhileWorking(snapshot.capabilities, isClaude ? transport : undefined)));
  const composerSendDisabled = composerSendBlocked('channel');
  const sendComposer = async (transport: 'channel' | 'peer' = 'channel') => {
    if (composerSendBlocked(transport) || (isClaude && transport === 'channel' && !channelReady)) return;
    const prior = composerAttempt && snapshot.deliveries.find(d => d.draftId === `composer-${composerAttempt.requestId}`);
    const attempt = composerAttempt && prior?.state !== 'failed' && (prior || (composerAttempt.text === text && JSON.stringify(composerAttempt.attachmentIds??[])===JSON.stringify(images.map(i=>i.id)))) ? composerAttempt : { requestId: crypto.randomUUID(), text, attachmentIds:images.map(i=>i.id) };
    workspace.update(data => { data.composerAttempt = attempt; });
    setComposerSending(true); setError('');
    try { const result = await call({ type: 'send-composer', ...attempt, ...(isClaude ? { transport } : {}) }); apply(result); }
    catch (e) { setError(e instanceof Error ? e.message : 'Delivery uncertain; text preserved'); }
    finally { setComposerSending(false); }
  };
  const composerDelivery = composerAttempt && snapshot.deliveries.find(d => d.draftId === `composer-${composerAttempt.requestId}`);
  const awaitingClaudeReplies = snapshot.deliveries.filter(isChannelAwaitingReply).length;
  const releaseComposer = async () => {
    if (!composerAttempt || !window.confirm('The previous message may still arrive. Release the composer without resending? Sending the same text again could duplicate it.')) return;
    const requestId = composerAttempt.requestId;
    try {
      await workspace.releaseComposer(requestId, async () => {
        const result = await call({ type: 'release-composer', requestId });
        apply(result);
      });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not release composer'); }
  };
  useEffect(() => {
    if (!composerAttempt) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await call({ type: 'check-composer', requestId: composerAttempt.requestId });
        apply(result);
      } catch { /* Keep text and retry only the read-only status check. */ }
      if (!cancelled) timer = setTimeout(() => void check(), 2000);
    };
    timer = setTimeout(() => void check(), 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [composerAttempt?.requestId, snapshot.id]);
  const clearSelection = () => workspace.update(data => { data.selectedDiscussion = []; });
  const toggleSelection = (index: number) => workspace.update(data => { data.selectedDiscussion = (data.selectedDiscussion.includes(index) ? data.selectedDiscussion.filter(i => i !== index) : [...data.selectedDiscussion, index]).sort((a,b) => a-b); });
  const saveReview = (next: InstructionReview | null) => workspace.update(data => { data.review = next ? {draftId:next.draft.id, revision:next.draft.revision, localizedText:next.localizedText} : null; });
  const {liveSize, discussionSize} = data.layout;
  const setLiveSize = (value: number) => workspace.update(data => { data.layout.liveSize = value; });
  const setDiscussionSize = (value: number) => workspace.update(data => { data.layout.discussionSize = value; });
  const feed = useRef<HTMLElement>(null);
  const pendingInputClear = useRef(new Map<string, string>());
  const belongsHere = (value: SessionEnvelope) => value.sessionId === client.sessionId && value.snapshot.id === client.sessionId;
  const acknowledgeComposer = (value: SessionEnvelope) => {
    if (!belongsHere(value)) return;
    workspace.update(data => {
      const attempt = data.composerAttempt;
      if (attempt && value.snapshot.deliveries.some(d => d.draftId === `composer-${attempt.requestId}` && isDeliverySubmitted(d))) {
        if (data.composer === attempt.text) data.composer = '';
        data.attachmentIds = data.attachmentIds.filter(id => !attempt.attachmentIds.includes(id));
        data.composerAttempt = null;
      }
    });
  };
  const apply = (value: SessionEnvelope, authoritativeConnection = false) => {
    acknowledgeComposer(value);
    const previous = workspace.envelope?.snapshot ?? initial.snapshot;
    if (!workspace.acceptEnvelope(value, authoritativeConnection)) return false;
    const next = value.snapshot;
    workspace.update(data => {
      const saved = data.review;
      if (saved && next.deliveries.some(d => d.draftId === saved.draftId && d.revision >= saved.revision && isDeliverySubmitted(d)) && next.currentDraft?.id !== saved.draftId) {
        const indices = previous.currentDraft?.id === saved.draftId ? previous.currentDraft.selectedDiscussion ?? [] : [];
        data.selectedDiscussion = data.selectedDiscussion.filter(i => !indices.includes(i));
        data.review = null;
      }
      for (const delivery of next.deliveries) {
        const key = [...pendingInputClear.current.keys()].find(key => key.startsWith(`${delivery.draftId}:`));
        if (isDeliverySubmitted(delivery) && key) {
          if (!next.currentDraft && data.composer === pendingInputClear.current.get(key)) data.composer = '';
          pendingInputClear.current.delete(key);
        }
      }
    });
    workspace.reconcileReview(next);
    if (next.currentDraft && !workspace.record.data.review) saveReview({draft:next.currentDraft, localizedText:next.currentDraft.localizedText});
    return true;
  };
  useEffect(() => {
    const controller = new AbortController();
    apply(initial, true);
    void client.subscribe(value => apply(value, true), controller.signal);
    return () => controller.abort();
  }, [client]);
  const run = async (action: Action) => { if (action.type === 'send' || action.type === 'send-review') pendingInputClear.current.set(`${action.draftId}:${action.revision}`, text); setError(''); try { const value = await call(action); if (!belongsHere(value)) return false; apply(value); return true; } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); return false; } };
  const discussing = useRef(false);
  const submit = () => {
    if(discussing.current || uploading || (!text.trim() && !images.length))return;
    setAssistantMode('full');
    const value=text;const ids=images.map(image=>image.id);
    discussing.current=true;
    void run({type:'discuss',text:value,...(ids.length?{attachmentIds:ids}:{})}).then(ok=>{
      if(ok) workspace.update(data => { if(data.composer === value)data.composer=''; data.attachmentIds=data.attachmentIds.filter(id=>!ids.includes(id)); });
    }).finally(()=>{discussing.current=false;});
  };
  const draft = snapshot.currentDraft; const delivery = review && snapshot.deliveries.find(item => item.draftId === review.draft.id && item.revision === review.draft.revision); const ordered = recentMessages(snapshot.codingMessages, snapshot.codingMessages.length, snapshot.target?.agent);
  const latestReply = [...ordered].reverse().find(message => message.role === 'assistant') ?? ordered.at(-1);
  const visibleMessages = liveHistory ? ordered : latestReply ? [latestReply] : [];
  const indexedDiscussion = snapshot.discussion.map((m, index) => ({ ...m, index }));
  const visibleDiscussion = assistantHistory ? indexedDiscussion : indexedDiscussion.slice(-1);
  const target = snapshot.target ?? draft?.target;
  const prepareSelected = async (replaceConfirmed = false) => {
    if (!selected.length || preparing) return;
    if ((review || draft) && !replaceConfirmed) { setReplaceOpen(true); return; }
    setReplaceOpen(false); setReviewOpen(false);
    setPreparing(true); setReviewError(''); setError('');
    const expected = draft ? { id: draft.id, revision: draft.revision } : undefined;
    try {
      const result = await call({ type: 'prepare', indices: selected, ...(expected ? { expected } : {}) });
      if (apply(result) && result.review) {
        saveReview({ draft: result.review, localizedText: result.review.localizedText });
        setReviewOpen(true);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Preparation failed'); }
    finally { setPreparing(false); }
  };
  const resetInstruction = async () => {
    const current = snapshot.currentDraft;
    if (preparing) return;
    if (!current) { saveReview(null); setReviewOpen(false); setReplaceOpen(false); setResetOpen(false); setReviewError(''); setResetError(''); return; }
    setPreparing(true); setResetError('');
    try {
      const result = await call({ type: 'reset-instruction', draftId: current.id, revision: current.revision });
      for (const key of pendingInputClear.current.keys()) if (key.startsWith(`${current.id}:`)) pendingInputClear.current.delete(key);
      if (!apply(result)) return;
      saveReview(null); setReviewOpen(false); setReplaceOpen(false); setResetOpen(false); setReviewError(''); setError('');
    } catch (e) { setResetError(e instanceof Error ? e.message : 'Reset failed; instruction preserved'); }
    finally { setPreparing(false); }
  };
  const sendReview = async (transport: 'channel' | 'peer' = 'channel') => {
    if (!review || preparing || (isClaude && transport === 'channel' && !channelReady)) return;
    setPreparing(true); setReviewError('');
    pendingInputClear.current.set(`${review.draft.id}:${review.draft.revision}`, text);
    try {
      const result = await call({ type: 'send-review', draftId: review.draft.id, revision: review.draft.revision, localizedText: review.localizedText, ...(isClaude ? { transport } : {}) });
      if (!belongsHere(result)) return;
      const accepted = apply(result);
      const sent = result.snapshot.deliveries.some(d => d.draftId === review.draft.id && d.revision >= review.draft.revision && isDeliverySubmitted(d));
      if (sent) workspace.update(data => {
        if (data.review?.draftId === review.draft.id && data.review.revision <= review.draft.revision) {
          data.selectedDiscussion = data.selectedDiscussion.filter(index => !review.draft.selectedDiscussion?.includes(index));
          data.review = null;
        }
        if (!workspace.envelope?.snapshot.currentDraft && data.composer === text) data.composer = '';
      });
      else if (accepted) setReviewOpen(true);
    } catch (e) { setReviewError(e instanceof Error ? e.message : 'Delivery failed'); setReviewOpen(true); }
    finally { setPreparing(false); }
  };
  useEffect(() => {
    if (liveHistory) return;
    const container = feed.current;
    const replies = container?.querySelectorAll<HTMLElement>('.message.assistant');
    const reply = replies?.item(replies.length - 1);
    if (container && reply) container.scrollTop += reply.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
  }, [snapshot.sourceRevision, latestReply?.translationStatus, liveHistory]);
  const livePanel = <ReadingPane title="Live Conversation" name="live" history={liveHistory} onHistory={() => setLiveHistory(value => !value)}><section ref={feed} className="feed" aria-label="Live Hebrew conversation">{visibleMessages.length === 0 && <p className="discussion-empty">Waiting for the next assistant response.</p>}{visibleMessages.map(m => <Message key={m.sourceId} message={m} client={client} replyLanguage={languageSettings.reply} assist={languageSettings.assist} original={m.role === 'assistant' && !needsReplyTranslation(languageSettings)} onTranslate={() => void call({ type: 'translate-message', sourceId: m.sourceId }).catch(e => setError(e instanceof Error ? e.message : 'Translation failed'))} />)}{liveHistory && snapshot.historyCursor && <button onClick={() => void run({ type: 'older-history' })}>Load earlier messages</button>}</section></ReadingPane>;
  const assistantPanel = <ReadingPane title="Language Assistant" name="assistant" history={assistantHistory} onHistory={() => setAssistantHistory(value => !value)}><section className="discussion" aria-label="Language discussion">{snapshot.discussion.length === 0 && <p className="discussion-empty">כתבו כאן בעברית כדי לדון ולחדד את הבקשה.</p>}{visibleDiscussion.map(m => <article key={m.index} data-discussion-index={m.index} className={'message language ' + m.role + (selected.includes(m.index) ? ' selected-message' : '')}><small>{m.role === 'user' ? 'You · language assistant' : 'Language assistant · Hebrew reply'}</small><SummarizableResponse client={client} kind="discussion" messageId={m.id??`${snapshot.id}:legacy:${m.index}`} text={m.text} complete={m.role==='assistant'&&(m.complete??!!m.text.trim())} assist={languageSettings.assist}><RichText language={m.role === 'assistant' ? snapshot.language : 'auto'} text={m.text || (m.attachments?.length?'':'…')} /></SummarizableResponse><ReferenceImages images={m.attachments} client={client} /><button type="button" className="select-answer" aria-pressed={selected.includes(m.index)} disabled={!m.text.trim() && !m.attachments?.length} onClick={() => toggleSelection(m.index)}>{selected.includes(m.index) ? 'Selected · Remove from answer' : 'Add to answer'}</button></article>)}{snapshot.sourceGaps?.filter(g => g !== 'Live replay starts in a bounded tail; older messages are available through history.').map(g => <p className="notice" key={g}>History gap: {g}</p>)}</section><div className="preparation-controls"><button type="button" className="selection-count" onClick={() => setSelectionOpen(true)}>{selected.length} selected</button><button className="primary" disabled={!selected.length || preparing} onClick={() => void prepareSelected()}>{preparing ? 'Preparing…' : 'Prepare instruction'}</button>{review && <><button onClick={() => setReviewOpen(true)}>Resume review</button><button disabled={preparing} onClick={() => { setResetError(''); setResetOpen(true); }}>Reset instruction</button></>}</div></ReadingPane>;
  const composerPanel = <ReadingPane title="Chat with the Language Assistant" name="composer">{isClaude && <ClaudeConnection client={client} status={channelStatus} />}{awaitingClaudeReplies > 0 && <p role="status">Waiting for Claude’s response{awaitingClaudeReplies > 1 ? ` (${awaitingClaudeReplies} messages)` : ''}</p>}{composerDelivery && !isChannelAwaitingReply(composerDelivery) && <div role="status"><span>{composerDelivery.state === 'unconfirmed' ? (isClaude ? 'Awaiting Claude confirmation' : 'Delivery uncertain') : composerDelivery.state === 'queued' ? 'Queued' : composerDelivery.state === 'sending' ? 'Sending' : composerDelivery.state === 'failed' ? 'Failed' : 'Delivered'}{composerDelivery.reason ? ': ' + composerDelivery.reason : ''}</span>{['unconfirmed', 'queued'].includes(composerDelivery.state) && <><button type="button" onClick={() => void call({type:'check-composer',requestId:composerAttempt!.requestId}).then(apply).catch(e=>setError(String(e)))}>Check delivery</button><button type="button" onClick={() => void releaseComposer()}>Release composer</button><small>The previous message may still arrive. Releasing does not resend it.</small></>}</div>}<form className="composer" onDragOver={e=>{if(e.dataTransfer.types.includes('Files')||e.dataTransfer.types.includes(FILE_DRAG_TYPE))e.preventDefault();}} onDrop={e=>{const internal=e.dataTransfer.getData(FILE_DRAG_TYPE);if(internal){e.preventDefault();try{const value=JSON.parse(internal);if(value.sessionId!==client.sessionId||typeof value.relativePath!=='string')throw new Error('Drop a file from this session');void attachPath(value.relativePath);}catch(error){setError(error instanceof Error?error.message:'Invalid file drop');}return;}if(e.dataTransfer.files.length){e.preventDefault();if(Array.from(e.dataTransfer.items).some(item=>item.webkitGetAsEntry?.()?.isDirectory)){setError('Directories are not supported; attach individual files');return;}void addImages(Array.from(e.dataTransfer.files));}}} onSubmit={e => { e.preventDefault(); void sendComposer(); }}><label htmlFor="composer">שוחח עם עוזר השפה</label><textarea aria-autocomplete="list" aria-controls={mention?pickerId:undefined} aria-activedescendant={mention?activeOption:undefined} ref={textarea} onClick={e=>detectMention(e.currentTarget.value,e.currentTarget.selectionStart)} onKeyUp={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key))detectMention(e.currentTarget.value,e.currentTarget.selectionStart);}} onPaste={e=>{const files=Array.from(e.clipboardData.files).filter(file=>file.type.startsWith('image/'));if(files.length){e.preventDefault();void addImages(files);}}} id="composer" aria-label="Discuss with language assistant" value={text} onChange={e => {setComposerText(e.target.value);detectMention(e.target.value,e.target.selectionStart);}} onKeyDown={e => { noteKeystroke(); if (e.key === 'Enter' && e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const input = e.currentTarget;
      const start = input.selectionStart;
      const next = input.value.slice(0, start) + '\n' + input.value.slice(input.selectionEnd);
      setComposerText(next);
      detectMention(next, start + 1);
      requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
      return;
    } if(!e.nativeEvent.isComposing && !(e.key==='Enter'&&(e.shiftKey||e.altKey)) && mention && picker.current?.key(e.key)){e.preventDefault();return;} if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendComposer(); } }} dir={languageDirection(languageSettings.write)} placeholder={languageSettings.write === 'he' ? 'כתוב בעברית…' : 'Write in English…'} />{mention&&<FilePicker key={client.sessionId+':'+mention.start} ref={picker} listboxId={pickerId} onActiveOption={setActiveOption} sessionId={client.sessionId} query={mention.query} onChoose={path=>openPreview(path,mention)} onClose={()=>setMention(null)}/>}<ImageAttachments client={client} images={images} headers={headers} busy={uploading} add={files=>void addImages(files)} remove={removeImage}><div className="composer-actions"><button type="button" disabled={uploading || (!text.trim() && !images.length)} onClick={submit}>Discuss first</button><button type="button" title={unsupportedFiles?'This coding agent does not support file references':undefined} disabled={composerSendDisabled || !channelReady} aria-label={terminalDestinationLabel()} onClick={() => void sendComposer()}>Send to agent</button>{isClaude && <button type="button" disabled={composerSendBlocked('peer')} onClick={() => void sendComposer('peer')}>Send as peer — approval may be required</button>}</div></ImageAttachments><small>Enter sends to agent · Option+Enter or Shift+Enter adds a line</small></form></ReadingPane>;
  return <FileLinkContext.Provider value={{root:record.canonicalRoot,open:openFileLink}}><ImageSessionContext.Provider value={client}><div className="session-header" dir="ltr"><b>{record.projectName} / {(record.worktreePath ?? record.target.projectId).split('/').filter(Boolean).at(-1)}</b><span>{record.target.agent === 'claude' ? 'Claude' : 'Codex'}</span><span>{entry && !(entry.key.startsWith('saved:') && entry.availability === 'available') ? activityLabel(entry) : snapshot.codingState === 'approval-required' ? 'Approval required' : snapshot.codingState[0]!.toUpperCase() + snapshot.codingState.slice(1)}</span>{entry?.launchId && <span className="launch-terminal"><button type="button" onClick={() => setTerminalOpen(true)}>Show terminal</button>{entry.attentionNotice && <small>{entry.attentionNotice}</small>}</span>}<SessionLanguageControl client={client} settings={languageSettings} /></div>{entry?.launchId && <TerminalPopup launchId={entry.launchId} title={terminalTitle} open={terminalOpen} onClose={() => setTerminalOpen(false)} />}<div className="file-workspace">{filesOpen&&<FileBrowser client={client} revealedFile={revealedFile} onPreview={path=>openPreview(path)} onClose={()=>setFilesOpen(false)}/>}<main className="app" dir="rtl"><MovableWorkspace assistantMode={assistantMode} toolbar={<><button type="button" onClick={()=>setAssistantMode(assistantMode==='full'?'compact':'full')}>{assistantMode==='full'?'Minimize Assistant':'Show full Assistant'}</button><button type="button" className="files-toggle" aria-expanded={filesOpen} onClick={()=>setFilesOpen(value=>!value)}>Files</button></>} layout={data.layout} onLayout={layout => workspace.update(data => { data.layout = layout; })} panels={{live:livePanel,assistant:assistantPanel,composer:composerPanel}} liveSize={liveSize} discussionSize={discussionSize} setLiveSize={setLiveSize} setDiscussionSize={setDiscussionSize} />{snapshot.codingState === 'disconnected' && <p className="notice">This saved session is unavailable. Your workspace is preserved. Reconnect same target to try again.</p>}{workspace.conflict && <aside className="workspace-notice" role="alert"><strong>Workspace changed in another tab</strong><p>Your local content is preserved until you choose.</p><details><summary>Saved content</summary><pre>{workspace.conflict.data.composer}</pre></details><button onClick={() => workspace.resolveUseSaved()}>Use saved</button><button onClick={() => void workspace.resolveKeepLocal()}>Keep local</button></aside>}{workspace.error && <p role="alert">{workspace.error}<button onClick={() => void workspace.flush()}>Retry save</button></p>}{error && <p role="alert" className="error">{error}</p>}{review && <InstructionReviewDialog review={review} open={reviewOpen} busy={preparing} channelReady={channelReady} {...(isClaude ? { onPeerSend: () => void sendReview('peer') } : {})} blocked={snapshot.codingState !== 'idle' && !(snapshot.codingState === 'working' && canSendWhileWorking(snapshot.capabilities, isClaude ? 'channel' : undefined))} {...(isClaude ? { peerBlocked: snapshot.codingState !== 'idle' && !(snapshot.codingState === 'working' && canSendWhileWorking(snapshot.capabilities, 'peer')) } : {})} {...(delivery ? { delivery } : {})} error={reviewError} onChange={value => saveReview({ ...review, localizedText: value })} onClose={() => setReviewOpen(false)} onSend={() => void sendReview()} onReset={() => { setResetError(''); setResetOpen(true); }} />}<ResetInstructionDialog open={resetOpen} pending={Boolean(delivery && ['sending', 'queued', 'unconfirmed'].includes(delivery.state))} busy={preparing} error={resetError} close={() => setResetOpen(false)} reset={() => void resetInstruction()} /><ReplaceInstructionDialog language={snapshot.language} open={replaceOpen} text={indexedDiscussion.filter(m => selected.includes(m.index)).map(m => m.text).join('\n\n---\n\n')} close={() => setReplaceOpen(false)} keep={() => { setReplaceOpen(false); setReviewOpen(true); }} replace={() => void prepareSelected(true)} /><SelectionDialog language={snapshot.language} open={selectionOpen} messages={indexedDiscussion.filter(m => selected.includes(m.index))} close={() => setSelectionOpen(false)} remove={toggleSelection} clear={clearSelection} />{preview&&<FilePreviewDialog languageSettings={languageSettings} client={client} path={preview.path} busy={uploading} attachError={error} attached={preview.attached??''} onAttach={()=>void attachPath(preview.path,preview.token)} onClose={()=>setPreview(null)}/>}</main></div></ImageSessionContext.Provider></FileLinkContext.Provider>;
}
function App() {
  const {catalog, error:catalogError} = useSessionCatalog();
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [selected, setSelected] = useState(() => { try { return sessionStorage.getItem('selected-session') ?? ''; } catch { return ''; } });
  const [launch, setLaunch] = useState('');
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [initial, setInitial] = useState<SessionEnvelope | null>(null);
  const [error, setError] = useState('');
  const [selectionError, setSelectionError] = useState(''); const selectionRequest = useRef(0);
  const [retry, setRetry] = useState(0);
  const [removal, setRemoval] = useState<{ entries: CatalogEntry[]; folderName?: string } | null>(null); const [removeError, setRemoveError] = useState(''); const [removeBusy, setRemoveBusy] = useState(false);
  const requestRemoval = (entries: CatalogEntry[], folderName?: string) => { if (!entries.length) return; setRemoveError(''); setRemoval({ entries, ...(folderName ? { folderName } : {}) }); };
  const confirmRemoval = async () => {
    if (!removal) return; setRemoveBusy(true); setRemoveError('');
    const failed: CatalogEntry[] = []; const done: string[] = []; let message = '';
    for (const entry of removal.entries) {
      try { await sessionRequest(`/api/sessions/${encodeURIComponent(entry.sessionId!)}`, { method: 'DELETE' }); done.push(entry.sessionId!); }
      catch (e) { failed.push(entry); message = e instanceof Error ? e.message : 'Could not remove from history'; }
    }
    if (done.length) {
      setRecords(previous => previous.filter(record => !done.includes(record.id)));
      if (done.includes(selected)) { try { sessionStorage.removeItem('selected-session'); } catch { /* local only */ } selectionRequest.current++; setSelected(''); setInitial(null); }
    }
    setRemoveBusy(false);
    if (failed.length) { setRemoval({ entries: failed, ...(removal.folderName ? { folderName: removal.folderName } : {}) }); setRemoveError(failed.length === removal.entries.length ? message : `${done.length} removed; ${failed.length} could not be removed: ${message}`); }
    else setRemoval(null);
  };
  const [newOpen, setNewOpen] = useState(false); const [launchTerminal, setLaunchTerminal] = useState<{ launchId: string; title: string } | null>(null); const [ending, setEnding] = useState<CatalogEntry | null>(null); const [endError, setEndError] = useState(''); const [endBusy, setEndBusy] = useState(false);
  const [waitingLaunchId, setWaitingLaunchId] = useState<string | undefined>(); 
  useKeystrokeTracker();
  const popupMode = usePopupMode(); const [dismissedToasts, setDismissedToasts] = useState<string[]>([]);
  const [displayPrefs, updateDisplayPrefs] = useDisplayPreferences();
  const allEntries = mergeSavedRecords(catalog?.entries ?? [], records);
  // One dismissible line in the sidebar: create/delete results, failed sidebar writes, a hidden project kept for its session.
  const [notice, setNotice] = useState('');
  const catalogProjects = [...new Map(allEntries.map(e => [e.projectKey, { key: e.projectKey, name: e.projectName }])).values()];
  const projects = useProjects(catalog?.sequence, catalogProjects, setNotice);
  const tree = buildProjectTree(allEntries, displayPrefs.tabOrder, projects.sources);
  const folders = tree.flatMap(project => project.folders);
  const selectedEntry = allEntries.find(e => e.sessionId === selected);
  const selectedTarget = records.find(r => r.id === selected)?.target;
  // Folder of the selection, also when the catalog lists its target under no (or another) session id.
  const selectedFolderEntry = selectedEntry ?? (selectedTarget ? allEntries.find(e => e.target.agent === selectedTarget.agent && e.target.sessionRef === selectedTarget.sessionRef) : undefined);
  const lastActiveFolder = useRef<string | undefined>(undefined);
  const [folderKey, setFolderKey] = useState<string | undefined>();
  const shownTree = visibleProjectTree(tree, selectedFolderEntry ? folderKeyFor(selectedFolderEntry) : undefined);
  const activeFolderKey = folderKey ?? (selectedFolderEntry ? folderKeyFor(selectedFolderEntry) : undefined) ?? (folders.some(f => f.key === lastActiveFolder.current) ? lastActiveFolder.current : applySidebarSettings(shownTree, projects.settings).visible[0]?.folders[0]?.key);
  // The project holding the selection is never hidden, so the open folder always stays reachable.
  const selectedProjectKey = tree.find(project => project.folders.some(f => f.key === activeFolderKey))?.key;
  const sidebarTree = applySidebarSettings(shownTree, projects.settings, selectedProjectKey);
  lastActiveFolder.current = activeFolderKey;
  const activeFolder: FolderNode | undefined = folders.find(f => f.key === activeFolderKey);
  useEffect(() => {
    const missing = folders.filter(f => f.open.some(e => !(displayPrefs.tabOrder[f.key] ?? []).includes(e.key)));
    if (missing.length) updateDisplayPrefs(p => ({ ...p, tabOrder: { ...p.tabOrder, ...Object.fromEntries(missing.map(f => [f.key, [...(p.tabOrder[f.key] ?? []), ...f.open.map(e => e.key).filter(k => !(p.tabOrder[f.key] ?? []).includes(k))]])) } }));
  }, [catalog?.sequence]);
  const presentSignature = JSON.stringify(folders.map(f => [f.key, [...f.open, ...f.saved].map(e => [e.key, e.sessionId])]));
  useEffect(() => {
    if (!catalog || !bootstrapReady) return;
    const present = Object.fromEntries(folders.map(f => [f.key, { keys: [...f.open, ...f.saved].map(e => e.key), ids: [...f.open, ...f.saved].flatMap(e => e.sessionId ? [e.sessionId] : []) }]));
    updateDisplayPrefs(p => pruneDisplayPreferences(p, present));
  }, [presentSignature, !!catalog, bootstrapReady]);
  const [bootstrapRetry, setBootstrapRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void (async () => {
      if (!token) throw new Error('Open the authenticated panel link printed by the server.');
      const list = await sessionRequest<SessionRecord[]>('/api/sessions');
      const legacy = await sessionRequest<{snapshot:ConversationSnapshot}>('/api/snapshot');
      if (!active) return;
      const id = list.some(r => r.id === legacy.snapshot.id) ? legacy.snapshot.id : '';
      // Publish the fixed launch ID with the list so restored tab selection cannot
      // hydrate before launch-only legacy layout migration has its destination.
      setRecords(list); setLaunch(id); setBootstrapReady(true);
      setSelected(current => list.some(r => r.id === current) ? current : id);
    })().catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [bootstrapRetry]);
  const missingCatalogIds = (catalog?.entries ?? []).flatMap(entry => entry.sessionId && !records.some(record => record.id === entry.sessionId) ? [entry.sessionId] : []).sort().join(',');
  useEffect(() => {
    if (!missingCatalogIds) return;
    let active = true;
    void sessionRequest<SessionRecord[]>('/api/sessions').then(list => {
      if (active) setRecords(previous => [...previous, ...list.filter(record => !previous.some(existing => existing.id === record.id))]);
    }).catch(() => { /* A later catalog frame retries discovery of complete records. */ });
    return () => { active = false; };
  }, [missingCatalogIds, catalog?.sequence]);
  const selectedExists = records.some(record => record.id === selected);
  useEffect(() => {
    if (!bootstrapReady || !selected || !selectedExists) return;
    let active = true; setInitial(null); setError(''); try { sessionStorage.setItem('selected-session', selected); } catch { /* Selection remains local to this document. */ }
    void (async () => { const value = await new SessionClient(selected).snapshot(); await workspaceFor(selected).hydrate(value.snapshot, launch); if(active)setInitial(value); })().catch(e => {if(active)setError(e.message);});
    return () => { active = false; void workspaceFor(selected).flush(); };
  }, [selected, selectedExists, bootstrapReady, launch, retry]);
  const selectSession = async (id: string) => {
    const request = ++selectionRequest.current; setSelectionError('');
    if (!records.some(record => record.id === id)) {
      const list = await sessionRequest<SessionRecord[]>('/api/sessions');
      if (request !== selectionRequest.current) return;
      if (!list.some(record => record.id === id)) throw new Error('Session is not available yet');
      setRecords(previous => [...previous, ...list.filter(record => !previous.some(existing => existing.id === record.id))]);
    }
    setSelected(id);
    const entry = allEntries.find(e => e.sessionId === id);
    setFolderKey(undefined);
    if (entry) { updateDisplayPrefs(p => ({ ...p, lastByFolder: { ...p.lastByFolder, [folderKeyFor(entry)]: id } })); }
  };
  const chooseSession = (id: string) => { const pending = selectSession(id); const request = selectionRequest.current; void pending.catch(e => { if (request === selectionRequest.current) setSelectionError(e instanceof Error ? e.message : 'Could not select session'); }); };
  const selectFolder = (key: string) => {
    setFolderKey(key);
    const folder = folders.find(f => f.key === key);
    const id = folder && chooseSessionForFolder(folder, key === activeFolderKey && selected ? selected : displayPrefs.lastByFolder[key]);
    if (id) chooseSession(id);
    else { selectionRequest.current++; setSelectionError(''); setSelected(''); }
  };
  // Create, delete and Initialize Git dialogs, opened from the sidebar's project menu and folder rows.
  const [worktreeDialog, setWorktreeDialog] = useState<{ kind: 'create' | 'init'; project: WorktreeProject } | { kind: 'delete'; project: WorktreeProject; folder: FolderNode } | null>(null);
  const worktreeProject = (project: ProjectNode): WorktreeProject => ({ key: project.key, name: project.name, path: project.path, hasCommits: projects.sources.find(s => s.key === project.key)?.hasCommits });
  const worktreeCreated = async (project: WorktreeProject, created: CreatedWorktree) => {
    setWorktreeDialog(null);
    const name = created.path.split('/').filter(Boolean).at(-1) ?? created.path;
    setNotice(created.ignore?.added ? `Created ${name} · Added ${created.ignore.line} to .gitignore` : '');
    // The server remembered the location; only collapse state is the client's to change here.
    projects.saveSettings(s => s.collapsed.includes(project.key) ? { ...s, collapsed: s.collapsed.filter(k => k !== project.key) } : s);
    await Promise.all([projects.refreshProjects(), projects.reloadWorktreeLocations()]);
    selectFolder(created.path);
  };
  // The shown session's folder is never deleted from under it: when it lives in the worktree, the client moves to the main checkout.
  const shownInside = (folder: FolderNode) => selectedEntry !== undefined && folderInside(folderKeyFor(selectedEntry), folder.path);
  const worktreeDeleted = async (project: WorktreeProject, folder: FolderNode, removal: WorktreeRemoval, removedConversations: boolean) => {
    setWorktreeDialog(null);
    setNotice(removal.skipped > 0 ? `Deleted ${folder.name} · ${removal.skipped === 1 ? '1 conversation kept because its session is open' : `${removal.skipped} conversations kept because their sessions are open`}` : '');
    if (shownInside(folder)) selectFolder(project.path);
    else if (folderKey === folder.key) setFolderKey(undefined);
    if (lastActiveFolder.current === folder.key) lastActiveFolder.current = undefined;
    await projects.refreshProjects();
    if (removedConversations) { try { setRecords(await sessionRequest<SessionRecord[]>('/api/sessions')); } catch { /* the next catalog frame catches up */ } }
  };
  const gitInitialized = async (project: WorktreeProject, key: string | undefined) => {
    setWorktreeDialog(null);
    // The project's key changes from its path to its .git directory; carry its sidebar settings over.
    if (key && key !== project.key) { const swap = (keys: string[]) => keys.map(k => k === project.key ? key : k); projects.saveSettings(s => ({ ...s, order: swap(s.order), hidden: swap(s.hidden), collapsed: swap(s.collapsed) })); }
    await projects.refreshProjects();
  };
  // A missing connected folder offers its newest saved session (records are listed oldest first).
  const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith('/') ? folder : folder + '/');
  const missingFolders = projects.folders.filter(f => f.missing).map(f => ({ ...f, newestSessionId: records.findLast(r => inside(r.worktreePath ?? r.target.projectId, f.path))?.id }));
  const waitingEntry = waitingLaunchId ? allEntries.find(e => e.launchId === waitingLaunchId) : undefined;
  useAutoOpenWaitingLaunch(waitingEntry, selected, popupMode, lastKeystrokeAt, e => setLaunchTerminal({ launchId: e.launchId!, title: e.sessionTitle ?? `${e.projectName} (${e.target.agent === 'claude' ? 'Claude' : 'Codex'})` }));
  const closeLaunchTerminal = () => {
    const id = launchTerminal?.launchId; setLaunchTerminal(null);
    const e = id ? allEntries.find(x => x.launchId === id) : undefined;
    if (id && e && !e.sessionId) void retryLaunch(id).catch(err => setSelectionError(err instanceof Error ? err.message : 'Could not retry the connection'));
  };
  const approvalToasts = popupMode === 'auto' ? allEntries.filter(e => e.launchId && e.activity === 'approval-required' && e.sessionId && e.sessionId !== selected && !dismissedToasts.includes(e.launchId)) : [];
  const waitingLaunches = allEntries.filter(e => e.launchId && e.activity === 'approval-required').map(e => e.launchId!).join(',');
  useEffect(() => { setDismissedToasts(list => { const keep = list.filter(id => waitingLaunches.split(',').includes(id)); return keep.length === list.length ? list : keep; }); }, [waitingLaunches]);
  return <><div className="session-brand" dir="ltr">Gloss</div><SessionSwitcher catalog={catalog} catalogError={catalogError} tree={sidebarTree.visible} hidden={sidebarTree.hidden} missingFolders={missingFolders}
    settings={projects.settings}
    onToggleCollapse={key => projects.saveSettings(s => ({ ...s, collapsed: s.collapsed.includes(key) ? s.collapsed.filter(k => k !== key) : [...s.collapsed, key] }))}
    onReorder={keys => projects.saveSettings(s => ({ ...s, order: reorderVisible(s.order, keys) }))}
    onHide={key => { projects.saveSettings(s => ({ ...s, hidden: s.hidden.includes(key) ? s.hidden : [...s.hidden, key] })); if (key === selectedProjectKey) setNotice(`${tree.find(p => p.key === key)?.name ?? 'This project'} is hidden — shown while its session is open`); }}
    onRestore={key => projects.saveSettings(s => ({ ...s, hidden: s.hidden.filter(k => k !== key) }))}
    onForget={path => forgetFolder(path).then(() => projects.refreshProjects())}
    onShowSessions={chooseSession}
    notice={notice} onDismissNotice={() => setNotice('')}
    onConnected={folder => {
      projects.addFolder(folder);
      projects.saveSettings(s => s.hidden.includes(folder.projectKey) || s.collapsed.includes(folder.projectKey) ? { ...s, hidden: s.hidden.filter(k => k !== folder.projectKey), collapsed: s.collapsed.filter(k => k !== folder.projectKey) } : s);
      selectFolder(folder.path);
    }}
    onCreateWorktree={project => setWorktreeDialog({ kind: 'create', project: worktreeProject(project) })}
    onInitGit={project => setWorktreeDialog({ kind: 'init', project: worktreeProject(project) })}
    onDeleteWorktree={(folder, project) => setWorktreeDialog({ kind: 'delete', project: worktreeProject(project), folder })}
    onRemoveClosed={folder => requestRemoval(removableSessions(folder), folder.name)} selectedFolderKey={activeFolderKey} selectedEntry={selectedEntry} onSelectFolder={selectFolder} onRegister={async target => {
    const value = await sessionRequest<SessionEnvelope>('/api/sessions', {method:'POST',body:JSON.stringify({target})});
    setRecords(await sessionRequest<SessionRecord[]>('/api/sessions')); selectionRequest.current++; setSelectionError(''); setSelected(value.sessionId); setFolderKey(undefined); setRetry(value=>value+1);
  }} /><div className="session-column"><SessionTabs folder={activeFolder} selectedId={selected} onSelect={chooseSession} onNewSession={() => setNewOpen(true)} onEnd={id => { setEndError(''); setEnding(allEntries.find(e => e.launchId === id) ?? null); }} onShowTerminal={(launchId, title) => setLaunchTerminal({ launchId, title })} onRemove={requestRemoval} onRetry={launchId => { setSelectionError(''); void retryLaunch(launchId).catch(e => setSelectionError(e instanceof Error ? e.message : 'Could not retry the connection')); }} /><PanelDialog title="Remove from history" open={!!removal} close={() => { if (!removeBusy) setRemoval(null); }}><div className="review-body"><p>{removal ? (removal.entries.length === 1 ? `Remove “${sessionTitle(removal.entries[0]!)}” from Gloss's history?` : `Remove ${removal.entries.length} closed sessions${removal.folderName ? ` in ${removal.folderName}` : ''} from Gloss's history?`) : ''}</p><p>This deletes only the saved Gloss conversation, drafts and settings for {removal && removal.entries.length === 1 ? 'this session' : 'these sessions'}. The agent's own transcript in Claude Code or Codex is not touched, and a session reappears here if you open it again.</p>{removeError && <p role="alert" className="error">{removeError}</p>}</div><div className="review-actions"><button type="button" disabled={removeBusy} onClick={() => setRemoval(null)}>Cancel</button><button type="button" className="primary" disabled={removeBusy} onClick={() => void confirmRemoval()}>{removeBusy ? 'Removing…' : 'Remove from history'}</button></div></PanelDialog>{worktreeDialog?.kind === 'create' && <CreateWorktreeDialog key={'create:' + worktreeDialog.project.key} project={worktreeDialog.project} defaultLocation={projects.settings.worktreeLocation[worktreeDialog.project.key] ?? defaultWorktreeLocation(worktreeDialog.project)} close={() => setWorktreeDialog(null)} onCreated={created => void worktreeCreated(worktreeDialog.project, created)} />}{worktreeDialog?.kind === 'delete' && <DeleteWorktreeDialog key={'delete:' + worktreeDialog.folder.key} project={worktreeDialog.project} folder={worktreeDialog.folder} currentSessionId={shownInside(worktreeDialog.folder) ? undefined : selected || undefined} close={() => setWorktreeDialog(null)} onDeleted={(removal, removed) => void worktreeDeleted(worktreeDialog.project, worktreeDialog.folder, removal, removed)} />}{worktreeDialog?.kind === 'init' && <InitGitDialog key={'init:' + worktreeDialog.project.key} project={worktreeDialog.project} close={() => setWorktreeDialog(null)} onInitialized={key => void gitInitialized(worktreeDialog.project, key)} />}{launchTerminal && <TerminalPopup launchId={launchTerminal.launchId} title={launchTerminal.title} open onClose={closeLaunchTerminal} />}<NewSessionDialog open={newOpen} folders={folders.map(f => ({ key: f.key, name: f.name }))} defaultFolder={activeFolderKey} onClose={() => setNewOpen(false)} onLaunched={(id, launchId) => { setWaitingLaunchId(launchId); if (id) chooseSession(id); }} /><PanelDialog title="End session" open={!!ending} close={() => setEnding(null)}><div className="review-body"><p>{ending ? `${ending.target.agent === 'claude' ? 'Claude' : 'Codex'} will be asked to exit. If it may be waiting for an answer, or does not exit within 10 seconds, the session is closed.` : ''}</p>{endError && <p role="alert">{endError}</p>}</div><div className="review-actions"><button type="button" onClick={() => setEnding(null)}>Cancel</button><button type="button" className="primary" disabled={endBusy} onClick={() => { const launchId = ending?.launchId; if (!launchId) return; setEndBusy(true); setEndError(''); void sessionRequest(`/api/launches/${encodeURIComponent(launchId)}/end`, { method: 'POST', body: '{}' }).then(() => setEnding(null), e => setEndError(e instanceof Error ? e.message : 'Could not end session')).finally(() => setEndBusy(false)); }}>End session</button></div></PanelDialog>{approvalToasts.map(e => { const name = e.sessionTitle ?? `${e.projectName} (${e.target.agent === 'claude' ? 'Claude' : 'Codex'})`; return <div key={e.launchId} role="status" className="approval-toast"><span>{name} needs approval</span><button type="button" aria-label={`Show ${name}`} onClick={() => chooseSession(e.sessionId!)}>Show</button><button type="button" aria-label={`Dismiss ${name}`} onClick={() => setDismissedToasts(l => [...l, e.launchId!])}>×</button></div>; })}{selectionError && <p role="alert" className="error">{selectionError}</p>}{error && <p role="alert">{error}<button onClick={() => { if (!bootstrapReady) setBootstrapRetry(value=>value+1); else setRetry(value=>value+1); }}>Retry connection</button></p>}{initial?.sessionId === selected && initial && records.find(r=>r.id===selected) ? <SessionWorkspace key={selected} initial={initial} record={records.find(r=>r.id===selected)!} entry={selectedEntry} /> : selected && !error ? <p role="status">Loading workspace…</p> : null}</div></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
