import type {CatalogEntry} from '../core/session-catalog.js';
import type {SessionRecord} from '../core/session-contracts.js';
import type {SidebarSettings} from '../runtime/connected-folders.js';
export const agentName=(entry:CatalogEntry)=>entry.target.agent==='claude'?'Claude Code':'Codex';
export const shortSessionId=(id:string)=>id.length>8?id.slice(0,8)+'…':id;
export const sessionTitle=(entry:CatalogEntry)=>entry.sessionTitle || `${agentName(entry)} · ${shortSessionId(entry.target.sessionRef)}`;
export const sessionIdentity=(entry:CatalogEntry)=>`${agentName(entry)} session: ${entry.target.sessionRef}; Project: ${entry.target.projectId}; Worktree: ${entry.worktreePath??entry.target.projectId}${entry.branch?`; Branch: ${entry.branch}`:''}${entry.reason?`; ${entry.reason}`:''}`;
export interface FolderNode {key:string;name:string;path:string;open:CatalogEntry[];saved:CatalogEntry[];branch?:string;main:boolean;git:boolean;missing:boolean;/** Listed by `git worktree list` for its project (only these can be deleted as worktrees). */worktree?:boolean}
export interface ProjectSource {key:string;name:string;path:string;git:boolean;main:string;/** From the worktree listing; undefined until it arrives or for plain folders. */hasCommits?:boolean;folders:{path:string;name:string;branch?:string;main:boolean;missing?:boolean;worktree?:boolean}[]}
export interface ProjectNode {key:string;name:string;path:string;folders:FolderNode[]}
export const folderKeyFor=(entry:CatalogEntry)=>entry.worktreePath??entry.target.projectId;
const lastSegment=(path:string)=>path.split('/').filter(Boolean).at(-1)??path;
/** True when `candidate` is `root` or a path below it (string comparison on the client's canonical keys). */
export const folderInside=(candidate:string,root:string)=>candidate===root||candidate.startsWith(root.endsWith('/')?root:root+'/');
const CODEX_WORKTREE=/\/\.codex\/worktrees\/([^/]+)/;
function distinguishingLabel(path:string,project:ProjectNode):string{
 if(path===project.path)return 'main';
 const codex=CODEX_WORKTREE.exec(path);if(codex)return `codex · ${codex[1]}`;
 const parts=path.split('/').filter(Boolean);const last=parts.at(-1)??path;
 return parts.length>1?(last===project.name?parts.at(-2)!:`${parts.at(-2)}/${last}`):last;
}
function labelFolders(project:ProjectNode){
 if(project.folders.length<2)return;
 const counts=new Map<string,number>();
 for(const f of project.folders)counts.set(f.name,(counts.get(f.name)??0)+1);
 for(const f of project.folders)if(f.name===project.name||(counts.get(f.name)??0)>1)f.name=distinguishingLabel(f.key,project);
}
export function orderFolderTabs(folderKey:string,keys:string[],tabOrder:Record<string,string[]>){
 const known=tabOrder[folderKey]??[];const order=[...known,...keys.filter(key=>!known.includes(key))];
 return {ordered:order.filter(key=>keys.includes(key)),tabOrder:order.length===known.length?tabOrder:{...tabOrder,[folderKey]:order}};
}
export function buildProjectTree(entries:CatalogEntry[],tabOrder:Record<string,string[]>={},sources:ProjectSource[]=[]):ProjectNode[]{
 const projects=new Map<string,ProjectNode>();
 for(const source of sources){
  const project:ProjectNode={key:source.key,name:source.name,path:source.path,folders:[]};projects.set(source.key,project);
  for(const f of source.folders)project.folders.push({key:f.path,name:f.name,path:f.path,open:[],saved:[],...(f.branch?{branch:f.branch}:{}),main:f.main,git:source.git,missing:f.missing===true,...(f.worktree?{worktree:true}:{})});
 }
 for(const entry of entries){
  let project=projects.get(entry.projectKey);
  if(!project){const path=entry.projectKey.replace(/\/\.git$/,'');project={key:entry.projectKey,name:entry.projectName,path,folders:[]};projects.set(entry.projectKey,project);}
  const key=folderKeyFor(entry);let folder=project.folders.find(f=>f.key===key);
  if(!folder){folder={key,name:lastSegment(key),path:key,open:[],saved:[],...(entry.branch?{branch:entry.branch}:{}),main:key===project.path,git:entry.projectKey.endsWith('/.git'),missing:false};project.folders.push(folder);}
  else if(!folder.branch&&entry.branch)folder.branch=entry.branch;
  folder[entry.open?'open':'saved'].push(entry);
 }
 for(const project of projects.values()){
  for(const folder of project.folders){const all=[...folder.open,...folder.saved];if(all.length&&all.every(e=>e.folderMissing))folder.missing=true;}
  labelFolders(project);
  project.folders.sort((a,b)=>a.key===project.path?-1:b.key===project.path?1:a.name.localeCompare(b.name)||a.key.localeCompare(b.key));
  for(const folder of project.folders){
   const {ordered}=orderFolderTabs(folder.key,folder.open.map(e=>e.key),tabOrder);
   folder.open.sort((a,b)=>ordered.indexOf(a.key)-ordered.indexOf(b.key));
   folder.saved.sort((a,b)=>sessionTitle(a).localeCompare(sessionTitle(b))||a.key.localeCompare(b.key));
  }
 }
 return [...projects.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.key.localeCompare(b.key));
}
export const folderLabel=(folder:FolderNode,project:ProjectNode)=>project.folders.length>1&&folder.key===project.path?'main':folder.name;
/** Orders by settings.order (unknown keys after, by name) and splits off hidden projects, except the one holding the selection. */
export function applySidebarSettings(tree:ProjectNode[],settings:SidebarSettings,keepKey?:string):{visible:ProjectNode[];hidden:ProjectNode[]}{
 const rank=(key:string)=>{const i=settings.order.indexOf(key);return i<0?Infinity:i;};
 const sorted=[...tree].sort((a,b)=>{const ra=rank(a.key),rb=rank(b.key);return ra===rb?a.name.localeCompare(b.name)||a.key.localeCompare(b.key):ra<rb?-1:1;});
 const isHidden=(p:ProjectNode)=>settings.hidden.includes(p.key)&&p.key!==keepKey;
 return {visible:sorted.filter(p=>!isHidden(p)),hidden:sorted.filter(isHidden)};
}
/** New settings.order after the visible projects were reordered to `visible`: their slots are rewritten in the new order, hidden and unknown keys keep their places, and visible keys new to the order are appended. */
export function reorderVisible(order:string[],visible:string[]):string[]{
 const shown=new Set(visible);const queue=[...visible];
 const next=order.map(key=>shown.has(key)?queue.shift()!:key);
 return [...next,...queue];
}
/** Hides folders missing from disk (except the selected one); folders that exist stay listed even with no open sessions. */
export function visibleProjectTree(tree:ProjectNode[],selectedFolderKey?:string):ProjectNode[]{
 const result:ProjectNode[]=[];
 for(const project of tree){
  const folders=project.folders.filter(folder=>folder.key===selectedFolderKey||!folder.missing);
  if(folders.length)result.push({...project,folders});
 }
 return result;
}
/** Closed sessions of a folder that can be removed from history (they have a saved panel record and no running launch). */
export const removableSessions=(folder:FolderNode)=>folder.saved.filter(e=>e.sessionId&&!e.open&&(!e.launchState||e.launchState==='ended'));
export function chooseSessionForFolder(folder:FolderNode,lastSelected?:string){
 const all=[...folder.open,...folder.saved];
 if(lastSelected&&all.some(e=>e.sessionId===lastSelected))return lastSelected;
 return folder.open.find(e=>e.sessionId)?.sessionId;
}
export function activityLabel(entry:CatalogEntry){
 if(entry.activity==='connecting'||entry.activity==='unknown')return entry.activity==='connecting'?'Connecting':'Unknown';
 const label=entry.activity==='approval-required'?'Approval required':entry.activity[0]!.toUpperCase()+entry.activity.slice(1);
 return entry.availability==='unavailable'&&entry.activity!=='disconnected'?`${label} · Unavailable`:label;
}
export function mergeSavedRecords(entries:CatalogEntry[],records:SessionRecord[]):CatalogEntry[]{
 const merged=[...entries];
 for(const record of records)if(!merged.some(e=>e.sessionId===record.id||(e.target.agent===record.target.agent&&e.target.sessionRef===record.target.sessionRef))){
  const folder=record.worktreePath??record.target.projectId;const sibling=merged.find(e=>folderKeyFor(e)===folder)??(record.projectKey?merged.find(e=>e.projectKey===record.projectKey):undefined);
  merged.push({key:'saved:'+record.id,sessionId:record.id,target:record.target,projectKey:sibling?.projectKey??record.projectKey??record.canonicalRoot,projectName:sibling?.projectName??record.projectName,...(record.sessionTitle?{sessionTitle:record.sessionTitle}:{}),...(record.branch?{branch:record.branch}:{}),...(record.worktreePath?{worktreePath:record.worktreePath}:{}),open:false,activity:record.enabled?'unknown':'disconnected',availability:record.enabled?'available':'unavailable',...(record.folderMissing||(sibling&&folderKeyFor(sibling)===folder&&sibling.folderMissing)?{folderMissing:true}:{})});}
 return merged;
}
export interface AttentionSummary {waiting:number;responses:number;approvals:number;working:boolean}
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
/** Open sessions in the folder that need the user, counted per session, plus whether any is working. Saved sessions never count. */
export function folderAttention(folder:FolderNode):AttentionSummary{
 const summary:AttentionSummary={waiting:0,responses:0,approvals:0,working:false};
 for(const entry of folder.open){
  if(entry.attention==='response'){summary.waiting++;summary.responses++;}
  else if(entry.attention==='approval'){summary.waiting++;summary.approvals++;}
  if(entry.activity==='working')summary.working=true;
 }
 return summary;
}
export function projectAttention(project:ProjectNode):AttentionSummary{
 const total:AttentionSummary={waiting:0,responses:0,approvals:0,working:false};
 for(const folder of project.folders){const s=folderAttention(folder);total.waiting+=s.waiting;total.responses+=s.responses;total.approvals+=s.approvals;total.working||=s.working;}
 return total;
}
/** Hover and screen-reader text for a badge; empty when nothing is waiting. */
export function attentionLabel(summary:AttentionSummary):string{
 if(!summary.waiting)return '';
 const parts=[summary.responses?plural(summary.responses,'response'):'',summary.approvals?plural(summary.approvals,'approval'):''].filter(Boolean);
 return `${plural(summary.waiting,'session')} waiting: ${parts.join(', ')}`;
}
