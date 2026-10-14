import {expect,it} from 'vitest';
import {sessionTitle} from '../../src/ui/session-navigation.js';
import type {CatalogEntry} from '../../src/core/session-catalog.js';
const entry=(id:string,path:string,open=true):CatalogEntry=>({key:id,sessionId:id,target:{agent:'codex',sessionRef:id,projectId:path},projectKey:'/repo/.git',projectName:'Project',worktreePath:path,open,activity:open?'idle':'disconnected',availability:'available'});
it('prefers title but keeps a distinguishable fallback',()=>{expect(sessionTitle({...entry('abcdefghijk','/work'),sessionTitle:'Named'})).toBe('Named');expect(sessionTitle(entry('abcdefghijk','/work'))).toBe('Codex · abcdefgh…');});

import {applySidebarSettings,visibleProjectTree,removableSessions,mergeSavedRecords,buildProjectTree,orderFolderTabs,chooseSessionForFolder,activityLabel} from '../../src/ui/session-navigation.js';
const at=(id:string,projectKey:string,worktree:string,open=true,activity:CatalogEntry['activity']='idle'):CatalogEntry=>({key:id,sessionId:id,target:{agent:'codex',sessionRef:id,projectId:worktree},projectKey,projectName:projectKey.split('/').filter(Boolean).at(-2)??'p',worktreePath:worktree,open,activity:open?activity:'disconnected',availability:'available'});
it('nests sibling worktrees under one project and keeps same-named repositories apart',()=>{
 const tree=buildProjectTree([at('A','/a/app/.git','/a/app'),at('B','/a/app/.git','/wt/app-feature'),at('C','/b/app/.git','/b/app')]);
 expect(tree).toHaveLength(2);
 const first=tree.find(p=>p.key==='/a/app/.git')!;
 expect(first.folders.map(f=>f.key)).toEqual(['/a/app','/wt/app-feature']);
 expect(tree.find(p=>p.key==='/b/app/.git')!.folders.map(f=>f.key)).toEqual(['/b/app']);
});
it('non-Git folders key by project folder and saved sessions are separated',()=>{
 const e={...at('D','/notes','/notes',false)};delete e.worktreePath;
 const [project]=buildProjectTree([e]);
 expect(project!.folders[0]!.key).toBe('/notes');expect(project!.folders[0]!.open).toEqual([]);expect(project!.folders[0]!.saved.map(s=>s.key)).toEqual(['D']);
});
it('tab order is first-seen and stable when activity changes',()=>{
 let order:Record<string,string[]>={};
 ({tabOrder:order}=orderFolderTabs('/f',['B','A'],order));
 const next=orderFolderTabs('/f',['A','C','B'],order);
 expect(next.ordered).toEqual(['B','A','C']);
 const tree=buildProjectTree([at('A','/r/.git','/f',true,'working'),at('B','/r/.git','/f'),at('C','/r/.git','/f')],next.tabOrder);
 expect(tree[0]!.folders[0]!.open.map(e=>e.key)).toEqual(['B','A','C']);
});
it('chooses the last selected open session, else the first open, else none',()=>{
 const folder={key:'/f',name:'f',path:'/f',main:true,git:true,missing:false,terminals:[],open:[at('A','/r/.git','/f'),at('B','/r/.git','/f')],saved:[at('S','/r/.git','/f',false)]};
 expect(chooseSessionForFolder(folder,'B')).toBe('B');
 expect(chooseSessionForFolder(folder,'S')).toBe('S');
 expect(chooseSessionForFolder(folder,'gone')).toBe('A');
 expect(chooseSessionForFolder({...folder,open:[]})).toBeUndefined();
});
it('activity labels',()=>{expect(activityLabel(at('A','/r/.git','/f',true,'approval-required'))).toBe('Approval required');expect(activityLabel(at('A','/r/.git','/f',true,'working'))).toBe('Working');});

it('projects registered records missing from the catalog as saved entries',()=>{
 const catalogEntry=at('A','/r/.git','/f');
 const rec=(id:string,ref:string,enabled=true)=>({id,target:{agent:'codex' as const,sessionRef:ref,projectId:'/p/'+id},canonicalRoot:'/p/'+id,projectName:id,enabled}) as any;
 const merged=mergeSavedRecords([catalogEntry],[rec('A','A'),rec('X','ref-x'),rec('Y','ref-y',false),rec('Z','A')]);
 expect(merged.map(e=>e.key)).toEqual(['A','saved:X','saved:Y']);
 expect(merged[1]).toMatchObject({sessionId:'X',open:false,activity:'unknown',availability:'available',projectKey:'/p/X'});
 expect(merged[2]).toMatchObject({activity:'disconnected',availability:'unavailable'});
});
it('merged saved records join the catalog project of their folder instead of creating a duplicate',()=>{
 const sibling=at('A','/repo/.git','/wt/feature');
 const rec={id:'R',target:{agent:'codex' as const,sessionRef:'ref-r',projectId:'/wt/feature'},canonicalRoot:'/wt/feature',projectName:'feature-root',worktreePath:'/wt/feature',enabled:true} as any;
 const merged=mergeSavedRecords([sibling],[rec]);
 expect(merged[1]).toMatchObject({projectKey:'/repo/.git',projectName:sibling.projectName});
 expect(buildProjectTree(merged)).toHaveLength(1);
 expect(mergeSavedRecords([],[rec])[0]).toMatchObject({projectKey:'/wt/feature',projectName:'feature-root'});
});
it('labels folders by their shortest distinguishing suffix when names repeat',()=>{
 const key='/Users/x/.superset/projects/hebrow-for-terminal/.git';
 const paths=['/Users/x/.superset/projects/hebrow-for-terminal','/Users/x/.codex/worktrees/805d/hebrow-for-terminal','/Users/x/.codex/worktrees/claude-parity/hebrow-for-terminal','/Users/x/.superset/worktrees/hebrow-for-terminal/ionized-printer'];
 const [project]=buildProjectTree(paths.map((p,i)=>({...at('S'+i,key,p),projectName:'hebrow-for-terminal'})));
 expect(project!.folders.map(f=>f.name)).toEqual(['main','codex · 805d','codex · claude-parity','ionized-printer']);
 expect(project!.folders.map(f=>f.path)).toEqual(paths);
});
it('disambiguates colliding sibling names with parent/last and leaves unique names alone',()=>{
 const [project]=buildProjectTree([at('A','/r/app/.git','/r/app'),at('B','/r/app/.git','/w/one/feat'),at('C','/r/app/.git','/w/two/feat'),at('D','/r/app/.git','/w/solo')].map(e=>({...e,projectName:'app'})));
 expect(project!.folders.map(f=>f.name).sort()).toEqual(['main','one/feat','solo','two/feat']);
});

it('keeps every existing folder (even with no open sessions) and hides missing ones unless selected',()=>{
 const missing=(e:CatalogEntry):CatalogEntry=>({...e,folderMissing:true});
 const tree=buildProjectTree([
  at('O','/r/.git','/r'),at('S','/r/.git','/r-saved',false),missing(at('M','/r/.git','/r-gone',false)),
  missing(at('MO','/r/.git','/r-gone-open')),at('X','/x/.git','/x',false),missing(at('Y','/y/.git','/y',false))]);
 const keys=(t:typeof tree)=>t.map(x=>x.folders.map(f=>f.key));
 expect(keys(visibleProjectTree(tree))).toEqual([['/r','/r-saved'],['/x']]);
 expect(visibleProjectTree(tree,'/y').flatMap(x=>x.folders.map(f=>f.key)).sort()).toEqual(['/r','/r-saved','/x','/y']);
 expect(visibleProjectTree(tree,'/r-gone').flatMap(x=>x.folders.map(f=>f.key))).toContain('/r-gone');
});
it('lists removable sessions as closed saved sessions without a running launch',()=>{
 const [project]=buildProjectTree([at('A','/r/.git','/r',false),{...at('B','/r/.git','/r',false),launchState:'running' as const},{...at('C','/r/.git','/r',false),sessionId:undefined} as any,at('D','/r/.git','/r')]);
 expect(removableSessions(project!.folders[0]!).map(e=>e.sessionId)).toEqual(['A']);
});
it('a saved worktree record groups under its repository project using the server project key',()=>{
 const main=at('M','/repo/.git','/repo');
 const rec={id:'W',target:{agent:'codex' as const,sessionRef:'ref-w',projectId:'/home/.codex/worktrees/ab/repo'},canonicalRoot:'/home/.codex/worktrees/ab/repo',projectName:'repo',projectKey:'/repo/.git',enabled:true} as any;
 const tree=buildProjectTree(mergeSavedRecords([main],[rec]));
 expect(tree).toHaveLength(1);expect(tree[0]!.key).toBe('/repo/.git');expect(tree[0]!.folders).toHaveLength(2);
 expect(mergeSavedRecords([],[{...rec,projectKey:'/repo/.git',folderMissing:true}])[0]).toMatchObject({projectKey:'/repo/.git',folderMissing:true});
});

it('adds connected projects and worktrees without sessions, and marks the main checkout',()=>{
 const sources=[{key:'/r/.git',name:'r',path:'/r',git:true,main:'/r',folders:[{path:'/r',name:'r',branch:'main',main:true},{path:'/r/.worktrees/f1',name:'f1',branch:'f1',main:false}]},{key:'/notes',name:'notes',path:'/notes',git:false,main:'/notes',folders:[{path:'/notes',name:'notes',main:true}]}];
 const tree=buildProjectTree([],{} ,sources);
 expect(tree.map(p=>[p.key,p.folders.map(f=>[f.key,f.name,f.main,f.git])])).toEqual([['/notes',[['/notes','notes',true,false]]],['/r/.git',[['/r','main',true,true],['/r/.worktrees/f1','f1',false,true]]]]);
});
it('session folders merge into source projects rather than duplicating',()=>{
 const tree=buildProjectTree([at('A','/r/.git','/r/.worktrees/f1')],{}, [{key:'/r/.git',name:'r',path:'/r',git:true,main:'/r',folders:[{path:'/r',name:'r',branch:'main',main:true},{path:'/r/.worktrees/f1',name:'f1',branch:'f1',main:false}]}]);
 expect(tree).toHaveLength(1);expect(tree[0]!.folders.find(f=>f.key==='/r/.worktrees/f1')!.open.map(e=>e.key)).toEqual(['A']);
});
it('applies order and hiding with the selected project kept',()=>{
 const tree=buildProjectTree([at('A','/a/.git','/a'),at('B','/b/.git','/b'),at('C','/c/.git','/c')]);
 const {visible,hidden}=applySidebarSettings(tree,{order:['/c/.git','/a/.git'],hidden:['/b/.git','/a/.git'],collapsed:[],worktreeLocation:{}},'/a/.git');
 expect(visible.map(p=>p.key)).toEqual(['/c/.git','/a/.git']);expect(hidden.map(p=>p.key)).toEqual(['/b/.git']);
});
it('keeps source folders without sessions visible and flags missing ones',()=>{
 const tree=buildProjectTree([],{},[{key:'/n',name:'n',path:'/n',git:false,main:'/n',folders:[{path:'/n',name:'n',main:true,missing:true}]}]);
 expect(tree[0]!.folders[0]!.missing).toBe(true);expect(visibleProjectTree(tree)).toEqual([]);expect(visibleProjectTree(tree,'/n')).toHaveLength(1);
});

import {reorderVisible} from '../../src/ui/session-navigation.js';
import {projectSources} from '../../src/ui/use-projects.js';
it('reordering visible projects keeps hidden ones in their slots and appends new keys',()=>{
 expect(reorderVisible(['A','H','B'],['B','A'])).toEqual(['B','H','A']);
 expect(reorderVisible(['A','H'],['X','A'])).toEqual(['X','H','A']);
 expect(reorderVisible([],['Y','X'])).toEqual(['Y','X']);
});
it('lists worktrees of a discovered Git project that was never connected, and marks only listed rows as worktrees',()=>{
 const listing={hasCommits:true,worktrees:[{path:'/r',branch:'main',main:true,detached:false,locked:false,prunable:false},{path:'/r/.worktrees/other',branch:'other',main:false,detached:false,locked:false,prunable:false}]};
 const sources=projectSources([],{'/r/.git':listing},[{key:'/r/.git',name:'r'},{key:'/plain',name:'plain'}]);
 expect(sources).toEqual([{key:'/r/.git',name:'r',path:'/r',git:true,main:'/r',hasCommits:true,folders:[{path:'/r',name:'r',branch:'main',main:true,missing:false,worktree:true},{path:'/r/.worktrees/other',name:'other',branch:'other',main:false,missing:false,worktree:true}]}]);
 const sub={path:'/r/sub',projectKey:'/r/.git',kind:'worktree' as const,createdByApp:false,connectedAt:1,projectName:'r',missing:false};
 const tree=buildProjectTree([],{},projectSources([sub],{'/r/.git':listing}));
 expect(tree[0]!.folders.map(f=>[f.key,f.worktree===true])).toEqual([['/r',true],['/r/.worktrees/other',true],['/r/sub',false]]);
});
