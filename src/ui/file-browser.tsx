import {useEffect,useRef,useState} from 'react';
import type {BrowserEntry,FilePreview} from '../core/file-references.js';
import {FileTree,FileRow} from './file-tree.js';
import {FileReview} from './file-review.js';
import {FileContentPreview} from './file-content-preview.js';
import type {LanguageSettings} from '../core/language-settings.js';
import type {SessionClient} from './session-client.js';
export const FILE_DRAG_TYPE='application/x-session-file';
export function FileBrowser({client,onPreview,onClose,revealedFile=''}:{revealedFile?:string;client:SessionClient;onPreview(path:string):void;onClose():void}) {
 const [query,setQuery]=useState('');const [mode,setMode]=useState<'name'|'content'>('name');
 const [entries,setEntries]=useState<BrowserEntry[]>([]);const [status,setStatus]=useState('');const [guidance,setGuidance]=useState('');const [selected,setSelected]=useState('');
 useEffect(()=>{
  if(!query)return;
  const controller=new AbortController();setStatus('Searching...');setEntries([]);setGuidance('');
  const timer=setTimeout(()=>{void client.findFiles(query,mode,controller.signal).then(found=>{
   if(controller.signal.aborted)return;setEntries(found.entries.map(entry=>({...entry,kind:'file'})));setGuidance(found.limited?found.guidance:'');setStatus(found.limited?'Partial results':found.entries.length?'':'No matching files');
  }).catch(error=>{if(!controller.signal.aborted)setStatus(error instanceof Error?error.message:'Search unavailable');});},150);
  return()=>{controller.abort();clearTimeout(timer);};
 },[client,query,mode]);
 return <aside className="file-sidebar compact-file-sidebar" aria-label="Session files" dir="ltr"><div className="file-toolbar"><strong>Files</strong><button type="button" onClick={onClose} aria-label="Close files" title="Close files">×</button></div>
  {revealedFile&&<div className="revealed-file file-entries"><small>Opened file</small><FileRow entry={{name:revealedFile.split('/').at(-1)!,relativePath:revealedFile,kind:'file'}} sessionId={client.sessionId} selected onActivate={()=>onPreview(revealedFile)}/><small title={revealedFile}>{revealedFile.includes('/')?revealedFile.slice(0,revealedFile.lastIndexOf('/')):'Session root'}</small></div>}
  <div className="file-search-controls"><input aria-label="Search files" placeholder="Search files…" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Search mode" title="Search mode" value={mode} onChange={e=>setMode(e.target.value as 'name'|'content')}><option value="name">Name</option><option value="content">Content</option></select></div>
  <div className="file-tree-container" hidden={Boolean(query)}><FileTree key={client.sessionId} client={client} onPreview={onPreview}/></div>
  {query&&<><div className="file-entries file-search-results">{entries.map(entry=><div key={entry.relativePath}><FileRow entry={entry} sessionId={client.sessionId} selected={selected===entry.relativePath} onActivate={()=>{setSelected(entry.relativePath);onPreview(entry.relativePath);}}/>{entry.relativePath.includes('/')&&<small className="file-search-parent">{entry.relativePath.slice(0,entry.relativePath.lastIndexOf('/'))}</small>}</div>)}</div>{status&&<p role="status">{status}</p>}{guidance&&<small>{guidance}</small>}</>}
 </aside>;
}
export function FilePreviewDialog({languageSettings,client,path,busy,attachError,attached,onAttach,onClose}:{client:SessionClient;path:string;busy:boolean;attachError:string;attached:string;onAttach():void;onClose():void;languageSettings:LanguageSettings}) {
 const dialog=useRef<HTMLDialogElement>(null);const [preview,setPreview]=useState<FilePreview|null>(null);const [error,setError]=useState('');
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 useEffect(()=>{const controller=new AbortController();setPreview(null);setError('');void client.previewFile(path,controller.signal).then(value=>{if(!controller.signal.aborted)setPreview(value);}).catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Preview unavailable');});return()=>controller.abort();},[client,path]);
 return <dialog ref={dialog} aria-label="File preview" className="file-preview" dir="ltr" onCancel={onClose}><div className="file-toolbar"><strong>{preview?.name??path.split('/').at(-1)}</strong><button type="button" onClick={onClose}>Close preview</button></div><p className="preview-path">{path}</p>{error?<div className="preview-content"><p role="alert">Preview unavailable: {error}</p></div>:!preview?<div className="preview-content"><p role="status">Loading preview...</p></div>:<FileReview key={client.sessionId+':'+path+':'+(preview.version??preview.text??'')} client={client} preview={preview} languageSettings={languageSettings}><FileContentPreview preview={preview} client={client}/></FileReview>}
 {attached&&<p role="status">{attached}</p>}{attachError&&<p role="alert">{attachError}</p>}<div className="file-toolbar"><span>Read-only preview</span><button type="button" disabled={!preview||busy} onClick={onAttach}>Attach file</button></div></dialog>;
}
