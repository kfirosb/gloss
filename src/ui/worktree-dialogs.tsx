import {useEffect,useRef,useState} from 'react';
import type {CreatedWorktree,WorktreeDeletePreview,WorktreeRemoval} from '../runtime/application.js';
import type {FolderNode} from './session-navigation.js';
import {PanelDialog} from './composer-dialogs.js';
import {RichText} from './rich-text.js';
import {createWorktree,initGit,inspectWorktree,removeWorktree,summarizeWorktreeChanges} from './session-client.js';
/** The project a dialog acts on: its key, display name and main checkout. */
export interface WorktreeProject {key:string;name:string;path:string;hasCommits?:boolean|undefined}
/** Mirrors the server's WORKTREE_NAME so the common mistake is caught before a request. */
const WORKTREE_NAME=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const message=(e:unknown,fallback:string)=>e instanceof Error?e.message:fallback;
const trimSlashes=(path:string)=>path.trim().replace(/(.)\/+$/,'$1');
export const defaultWorktreeLocation=(project:WorktreeProject)=>project.path+'/.worktrees';
function ignoreNote(project:WorktreeProject,location:string){
 if(location===defaultWorktreeLocation(project))return <>Adds <code>/.worktrees/</code> to the project’s root <code>.gitignore</code> if missing. Existing entries stay intact.</>;
 if(location.startsWith(project.path+'/'))return <>This directory is inside the project. Its relative path will be added to the root <code>.gitignore</code>.</>;
 return <>This directory is outside the project; no ignore entry is needed.</>;
}
/** Names a new worktree (and its branch), shows where it lands, and creates it. */
export function CreateWorktreeDialog({project,defaultLocation,close,onCreated}:{project:WorktreeProject;defaultLocation:string;close():void;onCreated(created:CreatedWorktree):void}){
 const [name,setName]=useState('');const [location,setLocation]=useState(defaultLocation);const [changing,setChanging]=useState(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const input=useRef<HTMLInputElement>(null),locationInput=useRef<HTMLInputElement>(null);
 useEffect(()=>{requestAnimationFrame(()=>input.current?.focus());},[]);
 const noCommits=project.hasCommits===false;
 const where=trimSlashes(location);
 async function create(){
  const value=name.trim();
  if(!WORKTREE_NAME.test(value)){setError('Use letters, numbers, hyphens or underscores for this folder name.');return;}
  if(!where.startsWith('/')&&!where.startsWith('~/')){setError('Choose an absolute directory or a path beginning with ~/.');return;}
  setBusy(true);setError('');
  try{
   // Always the location shown: the server would otherwise fall back to the remembered one.
   onCreated(await createWorktree(project.key,{name:value,location:where}));
  }catch(e){setError(message(e,'Could not create this worktree'));}
  finally{setBusy(false);}
 }
 return <PanelDialog title="Create a worktree" className="sidebar-panel-dialog" dir="ltr" open close={()=>{if(!busy)close();}}><form className="review-body sidebar-dialog worktree-dialog" onSubmit={e=>{e.preventDefault();if(!busy&&!noCommits)void create();}}>
  <p className="review-hint">A separate checkout for a new task, kept inside <strong>{project.name}</strong>.</p>
  {noCommits&&<p role="status" className="notice warning">Make a first commit in this project, then create a worktree.</p>}
  <label className="field">Worktree & branch name<input ref={input} aria-label="Worktree & branch name" placeholder="e.g. improve-search" autoComplete="off" spellCheck={false} disabled={noCommits} value={name} onChange={e=>{setName(e.target.value);setError('');}}/><small>A new branch will start from the main checkout’s current branch.</small></label>
  <div className="destination"><div className="destination-row"><span>Create in</span><button type="button" className="link-button" aria-expanded={changing} onClick={()=>{setChanging(v=>!v);if(!changing)requestAnimationFrame(()=>locationInput.current?.focus());}}>Change location</button></div>
   <div className="destination-path">{where+'/'+(name.trim()||'worktree-name')}</div>
   {changing&&<label className="field">Worktrees directory<input ref={locationInput} aria-label="Worktrees directory" autoComplete="off" spellCheck={false} value={location} onChange={e=>{setLocation(e.target.value);setError('');}}/><small>Remembered for this project after creation.</small></label>}
  </div>
  <p className="notice worktree-note">{ignoreNote(project,where)}</p>
  <details className="worktree-help"><summary>What is a worktree?</summary><p>A worktree is another checkout of the same Git repository, on its own branch. You can work on two tasks at once. The folders share Git history but have separate files.</p></details>
  {error&&<p role="alert" className="error">{error}</p>}
  <button type="submit" hidden tabIndex={-1}/>
 </form><div className="review-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy||noCommits} onClick={()=>void create()}>{busy?'Creating…':'Create & open'}</button></div></PanelDialog>;
}
const day=(ms:number)=>new Date(ms).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
const plural=(n:number,one:string,many:string)=>`${n} ${n===1?one:many}`;
/** Shows what deleting a worktree would discard and deletes it on confirm; never blocked by unsaved work. */
export function DeleteWorktreeDialog({project,folder,currentSessionId,close,onDeleted}:{project:WorktreeProject;folder:FolderNode;currentSessionId?:string|undefined;close():void;onDeleted(removal:WorktreeRemoval,removeConversations:boolean):void}){
 type Loaded={state:'loading'}|{state:'ready';info:WorktreeDeletePreview}|{state:'error';message:string};
 const [inspection,setInspection]=useState<Loaded>({state:'loading'});
 const [summary,setSummary]=useState<{state:'idle'}|{state:'asking'}|{state:'done';text:string}|{state:'error';message:string}>({state:'idle'});
 const [removeConversations,setRemoveConversations]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 useEffect(()=>{let active=true;inspectWorktree(project.key,folder.path).then(info=>{if(active)setInspection({state:'ready',info});},e=>{if(active)setInspection({state:'error',message:message(e,'Could not check this worktree')});});return()=>{active=false;};},[project.key,folder.path]);
 const ask=()=>{setSummary({state:'asking'});summarizeWorktreeChanges(project.key,folder.path).then(v=>setSummary({state:'done',text:v.text}),e=>setSummary({state:'error',message:message(e,'The agent could not summarize these changes')}));};
 async function remove(){
  setBusy(true);setError('');
  try{const removal=await removeWorktree(project.key,folder.path,removeConversations,currentSessionId);onDeleted(removal,removeConversations);}
  catch(e){setError(message(e,'Could not delete this worktree'));}
  finally{setBusy(false);}
 }
 const info=inspection.state==='ready'?inspection.info:undefined;
 const changed=!!info&&(info.modified>0||info.untracked>0);
 return <PanelDialog title="Delete worktree?" className="sidebar-panel-dialog" dir="ltr" open close={()=>{if(!busy)close();}}><div className="review-body sidebar-dialog worktree-dialog">
  <p><strong>{folder.name}</strong>{folder.branch&&<small className="worktree-branch"> · {folder.branch}</small>}</p>
  <div className="destination"><div className="destination-path">{folder.path}</div></div>
  <p className="review-hint">Removes this checkout from disk and Git’s worktree list. The branch is kept.</p>
  {inspection.state==='loading'&&<p role="status" className="search-state"><span className="spinner" aria-hidden="true"/> Checking for unsaved changes…</p>}
  {inspection.state==='error'&&<p role="alert" className="notice warning">{inspection.message}</p>}
  {info&&<div className={'notice worktree-counts'+(changed||info.unmergedCommits>0||info.launchedSessions>0||info.launchedTerminals>0||info.otherOpenSessions>0?' warning':'')}>
   <p>{changed?<>{info.modified} modified, {info.untracked} untracked{info.oldestChange!==undefined&&<> · oldest {day(info.oldestChange)}</>}{info.newestChange!==undefined&&<> · newest {day(info.newestChange)}</>}</>:'No uncommitted changes.'}</p>
   {info.unmergedCommits>0&&<p>{plural(info.unmergedCommits,'commit','commits')} only on this branch — the branch is kept.</p>}
   {info.launchedSessions>0&&<p>{plural(info.launchedSessions,'session','sessions')} started from Gloss will be ended.</p>}
   {info.launchedTerminals>0&&<p>{plural(info.launchedTerminals,'terminal','terminals')} started from Gloss will be closed.</p>}
   {info.otherOpenSessions>0&&<p>{info.otherOpenSessions===1?'1 other open session in this folder was not started here and keeps running; its folder will be removed from under it.':`${info.otherOpenSessions} other open sessions in this folder were not started here and keep running; their folder will be removed from under them.`}</p>}
   {changed&&info.changedFiles.length>0&&<ul className="worktree-files">{info.changedFiles.map(f=><li key={f.path}><code>{f.status}</code> {f.path}</li>)}{info.truncated&&<li>…and more</li>}</ul>}
  </div>}
  {info&&(changed||info.unmergedCommits>0)&&<div className="worktree-summary">
   {summary.state!=='done'&&<button type="button" disabled={summary.state==='asking'} onClick={ask}>{summary.state==='asking'?'Asking the agent…':'Ask the agent about these changes'}</button>}
   {summary.state==='done'&&<div className="worktree-summary-text"><RichText text={summary.text}/></div>}
   {summary.state==='error'&&<p role="alert" className="error">{summary.message}</p>}
  </div>}
  <label className="checkbox-field"><input type="checkbox" checked={removeConversations} onChange={e=>setRemoveConversations(e.target.checked)}/> Also remove its conversations from history</label>
  {error&&<p role="alert" className="error">{error}</p>}
 </div><div className="review-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="button" className="danger" disabled={busy||inspection.state==='loading'} onClick={()=>void remove()}>{busy?'Deleting…':'Delete worktree'}</button></div></PanelDialog>;
}
/** Turns a plain connected folder into a Git repository. */
export function InitGitDialog({project,close,onInitialized}:{project:WorktreeProject;close():void;onInitialized(projectKey:string|undefined):void}){
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 async function init(){
  setBusy(true);setError('');
  try{const result=await initGit(project.key);onInitialized(typeof result?.projectKey==='string'?result.projectKey:undefined);}
  catch(e){setError(message(e,'Could not initialize Git here'));}
  finally{setBusy(false);}
 }
 return <PanelDialog title="Initialize Git repository?" className="sidebar-panel-dialog" dir="ltr" open close={()=>{if(!busy)close();}}><div className="review-body sidebar-dialog">
  <p><strong>{project.name}</strong> currently works as a regular folder. You can keep using it without Git.</p>
  <p className="review-hint">Initializing Git here enables branches and worktrees. Existing files remain in place; nothing is committed automatically.</p>
  {error&&<p role="alert" className="error">{error}</p>}
 </div><div className="review-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={()=>void init()}>{busy?'Initializing…':'Initialize Git'}</button></div></PanelDialog>;
}
