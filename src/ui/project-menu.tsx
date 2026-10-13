import type {ProjectNode} from './session-navigation.js';
import {PopupMenu,type PopupMenuItem} from './popup-menu.js';
export const projectIsGit=(project:ProjectNode)=>project.key.endsWith('/.git');
export function ProjectMenu({project,index,count,onCreateWorktree,onInitGit,onMoveUp,onMoveDown,onHide}:{project:ProjectNode;index:number;count:number;onCreateWorktree?:(()=>void)|undefined;onInitGit?:(()=>void)|undefined;onMoveUp():void;onMoveDown():void;onHide():void}){
 const git=projectIsGit(project);
 const items:PopupMenuItem[]=[
  ...(git&&onCreateWorktree?[{key:'create',content:'Create worktree…',onChoose:onCreateWorktree}]:[]),
  ...(!git&&onInitGit?[{key:'init',content:'Initialize Git…',onChoose:onInitGit}]:[]),
  {key:'up',content:'Move up',disabled:index===0,onChoose:onMoveUp},
  {key:'down',content:'Move down',disabled:index>=count-1,onChoose:onMoveDown},
  {key:'hide',content:'Hide project',onChoose:onHide},
 ];
 return <PopupMenu label={<span aria-hidden="true">⋯</span>} triggerLabel={`${project.name} actions`} className="project-menu" menuClassName="session-saved-menu project-menu-list" menuLabel={`${project.name} actions`} resetKey={project.key} items={items}/>;
}
