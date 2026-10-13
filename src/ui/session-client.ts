import type { BrowserPage, BrowserSearch, FilePreview, FileReference } from '../core/file-references.js';
import type { Action } from '../runtime/protocol.js';
import type { ConversationSnapshot, Draft } from '../core/contracts.js';
import { WorkspaceConflict, type WorkspaceData, type WorkspaceRecord } from '../core/session-contracts.js';
export interface FileContentStatus { state: 'readable' | 'unreadable'; reason?: string }
export type SessionFileMetadata = FileReference & {contentStatus?: FileContentStatus};
export interface SessionImage { id: string; name: string; mime: string; size: number }
export interface SessionEnvelope { epoch?: string; sessionId: string; sequence: number; snapshot: ConversationSnapshot; review?: Draft }
/** Keeps inserted @File/@Image references left-to-right in the RTL composer; never delivered. */
export const REFERENCE_MARK = '\u200E';
const outgoing = (action: Action): Action => (action.type === 'discuss' || action.type === 'send-composer') ? { ...action, text: action.text.replaceAll(REFERENCE_MARK, '') } : action;
export const authHeaders = () => ({ 'content-type': 'application/json', Authorization: 'Bearer ' + new URLSearchParams(location.hash.slice(1)).get('capability') });
export async function sessionRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
 const response = await fetch(url, { ...init, headers: authHeaders() });
 const body = await response.json();
 if (response.status === 409 && body.code === 'workspace-conflict') throw new WorkspaceConflict(body.current);
 if (!response.ok) throw new Error(body.error ?? 'Request failed');
 return body as T;
}
export class SessionClient {
 readonly base: string;
 constructor(readonly sessionId: string) { this.base = '/api/sessions/' + encodeURIComponent(sessionId); }
 claudeChannelStatus(signal?: AbortSignal) { return sessionRequest<import('../agents/claude/channel-types.js').ChannelStatus>(this.base + '/claude-channel', signal ? { signal } : {}); }
 prepareClaudeChannel() { return sessionRequest<import('../runtime/claude-channel-setup.js').ChannelSetup>(this.base + '/claude-channel', { method: 'POST' }); }
 language() { return sessionRequest<import('./language-controls.js').SessionLanguage>(this.base + '/language'); }
 setLanguage(override: import('../core/language-settings.js').LanguageOverride) { return sessionRequest<import('./language-controls.js').SessionLanguage>(this.base + '/language', { method: 'PUT', body: JSON.stringify(override) }); }
 resetLanguage() { return sessionRequest<import('./language-controls.js').SessionLanguage>(this.base + '/language', { method: 'DELETE' }); }
 summarizeResponse(source:import('../core/summary-contracts.js').SummarySource){return sessionRequest<import('../core/summary-contracts.js').ResponseSummary>(this.base+'/summaries',{method:'POST',body:JSON.stringify(source)});}
 uploadFile(file: {name:string;data:string;mime?:string}) { return sessionRequest<FileReference>(this.base+'/files',{method:'POST',body:JSON.stringify(file)}); }
 fileMetadata(id:string,signal?:AbortSignal) { return sessionRequest<SessionFileMetadata>(this.base+'/files/'+encodeURIComponent(id)+'/metadata',signal?{signal}:{}); }
 fileUrl(id:string) { return this.base+'/files/'+encodeURIComponent(id)+'/content'; }
 searchFiles(query:string,signal:AbortSignal) { return sessionRequest<{name:string;relativePath:string}[]>(this.base+'/files/search?q='+encodeURIComponent(query),{signal}); }
 browseFiles(relativePath:string,offset:number,signal:AbortSignal) { return sessionRequest<BrowserPage>(this.base+'/files/browse?path='+encodeURIComponent(relativePath)+'&offset='+offset,{signal}); }
 reviewFile(path:string,mode:'summary'|'translation',version:string|undefined,signal:AbortSignal) { return sessionRequest<{path:string;mode:'summary'|'translation';text:string}>(this.base+'/files/review',{method:'POST',body:JSON.stringify({path,mode,version}),signal}); }
 previewFile(relativePath:string,signal:AbortSignal) { return sessionRequest<FilePreview>(this.base+'/files/preview?path='+encodeURIComponent(relativePath),{signal}); }
 async previewMedia(relativePath:string,signal:AbortSignal,maxBytes=128*1024*1024) {
  const response=await fetch(this.base+'/files/media?path='+encodeURIComponent(relativePath),{headers:authHeaders(),signal});
  if(!response.ok){const body=await response.json();throw new Error(body.error??'Media unavailable');}
  if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new Error('Combined local media exceeds the 128 MiB preview limit');}
  const reader=response.body?.getReader();if(!reader)throw new Error('Media unavailable');
  const chunks:BlobPart[]=[];let size=0;
  try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)throw new Error('Combined local media exceeds the 128 MiB preview limit');chunks.push(part.value);}}
  finally {await reader.cancel().catch(()=>{});}
  return new Blob(chunks,{type:response.headers.get('content-type')??'application/octet-stream'});
 }
 findFiles(query:string,mode:'name'|'content',signal:AbortSignal) { return sessionRequest<BrowserSearch>(this.base+'/files/find?q='+encodeURIComponent(query)+'&mode='+mode,{signal}); }
 referenceFile(relativePath:string) { return sessionRequest<FileReference>(this.base+'/files/reference',{method:'POST',body:JSON.stringify({relativePath})}); }
 uploadImage(image: { name: string; data: string }) { return sessionRequest<SessionImage>(this.base + '/attachments', { method: 'POST', body: JSON.stringify(image) }); }
 imageMetadata(imageId: string) { return sessionRequest<SessionImage>(this.base + '/attachments/' + encodeURIComponent(imageId) + '/metadata'); }
 imageUrl(imageId: string) { return this.base + '/attachments/' + encodeURIComponent(imageId); }
 action(action: Action) { return sessionRequest<SessionEnvelope>(this.base + '/actions', { method: 'POST', body: JSON.stringify(outgoing(action)) }); }
 snapshot() { return sessionRequest<SessionEnvelope>(this.base + '/snapshot'); }
 loadWorkspace() { return sessionRequest<WorkspaceRecord>(this.base + '/workspace'); }
 saveWorkspace(expectedRevision: number, data: WorkspaceData) { return sessionRequest<WorkspaceRecord>(this.base + '/workspace', { method: 'PUT', body: JSON.stringify({ expectedRevision, data }) }); }
 async subscribe(listener: (value: SessionEnvelope) => void, signal: AbortSignal) {
  while (!signal.aborted) {
   try {
    const response = await fetch(this.base + '/events', { headers: authHeaders(), signal });
    if (!response.ok || !response.body) throw new Error('Live connection unavailable');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try { while (!signal.aborted) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const chunks = buffer.split('\n\n'); buffer = chunks.pop() ?? ''; for (const chunk of chunks) { const line = chunk.split('\n').find(v => v.startsWith('data: ')); if (line) { const value = JSON.parse(line.slice(6)) as SessionEnvelope; if (value.sessionId === this.sessionId && value.snapshot.id === this.sessionId) listener(value); } } } }
    finally { await reader.cancel().catch(() => {}); }
   } catch { if (signal.aborted) return; }
   if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
  }
 }
}
export const readLanguageDefaults = () => sessionRequest<import('../core/language-settings.js').LanguageSettings>('/api/settings/language');
export const writeLanguageDefaults = (settings: import('../core/language-settings.js').LanguageSettings) => sessionRequest<import('../core/language-settings.js').LanguageSettings>('/api/settings/language', { method: 'PUT', body: JSON.stringify(settings) });

const enc=encodeURIComponent;const json=(method:string,body?:unknown)=>({method,...(body===undefined?{}:{body:JSON.stringify(body)})});
const projectBase=(key:string)=>'/api/projects/'+enc(key);
export const readAbout=()=>sessionRequest<import('../runtime/application.js').AboutInfo>('/api/about');
export const listFolders=()=>sessionRequest<import('../runtime/application.js').FolderListing[]>('/api/folders');
export const connectFolder=(path:string)=>sessionRequest<import('../runtime/application.js').FolderListing>('/api/folders',json('POST',{path}));
export const forgetFolder=(path:string)=>sessionRequest<unknown>('/api/folders?path='+enc(path),json('DELETE'));
export const searchFolders=(q:string,signal?:AbortSignal)=>sessionRequest<import('../runtime/folder-search.js').FolderSearchResult>('/api/folders/search?q='+enc(q),signal?{signal}:{});
export const readSidebarSettings=()=>sessionRequest<import('../runtime/connected-folders.js').SidebarSettings>('/api/settings/sidebar');
export const writeSidebarSettings=(settings:import('../runtime/connected-folders.js').SidebarSettings)=>sessionRequest<import('../runtime/connected-folders.js').SidebarSettings>('/api/settings/sidebar',json('PUT',settings));
export const listWorktrees=(key:string)=>sessionRequest<import('../runtime/application.js').WorktreeListing>(projectBase(key)+'/worktrees');
export const inspectWorktree=(key:string,path:string)=>sessionRequest<import('../runtime/application.js').WorktreeDeletePreview>(projectBase(key)+'/worktrees/inspect?path='+enc(path));
export const createWorktree=(key:string,body:{name:string;location:string})=>sessionRequest<import('../runtime/application.js').CreatedWorktree>(projectBase(key)+'/worktrees',json('POST',body));
export const removeWorktree=(key:string,path:string,removeConversations:boolean,currentSessionId?:string)=>sessionRequest<import('../runtime/application.js').WorktreeRemoval>(projectBase(key)+'/worktrees?path='+enc(path)+'&removeConversations='+removeConversations+(currentSessionId?'&current='+enc(currentSessionId):''),json('DELETE'));
export const initGit=(key:string)=>sessionRequest<{projectKey:string}>(projectBase(key)+'/git-init',json('POST'));
export const summarizeWorktreeChanges=(key:string,path:string)=>sessionRequest<{text:string}>(projectBase(key)+'/worktrees/summary',json('POST',{path}));
