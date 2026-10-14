import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {SessionClient} from './session-client.js';
import type {FilePickerHandle} from './file-picker.js';
import type {Inventory,InventoryEntry} from '../agents/inventory.js';

export type InvocationKind='skill'|'mcp';
export interface InvocationMention {kind:InvocationKind;start:number;end:number;query:string}

/** `/` (skills) or `$` (MCP) at a word start, followed by nothing yet or a letter-led name; the left-to-right mark counts as a word start. */
export function detectInvocation(value:string,caret:number):InvocationMention|null{
 const match=/(?:^|[\s‎])([/$])((?:[A-Za-z][\w.:-]*)?)$/.exec(value.slice(0,caret));
 if(!match)return null;
 return {kind:match[1]==='/'?'skill':'mcp',start:caret-match[2]!.length-1,end:caret,query:match[2]!};
}

export function rankEntries(entries:InventoryEntry[],kind:InvocationKind,query:string):InventoryEntry[]{
 const q=query.toLocaleLowerCase();
 const score=(e:InventoryEntry)=>{const name=e.name.toLocaleLowerCase();if(!q||name.startsWith(q))return 0;if(name.includes(q))return 1;if(e.description?.toLocaleLowerCase().includes(q))return 2;return -1;};
 return entries.filter(e=>e.kind===kind).map(e=>({e,s:score(e)})).filter(x=>x.s>=0).sort((a,b)=>a.s-b.s||a.e.name.localeCompare(b.e.name)).slice(0,50).map(x=>x.e);
}

const badge=(e:InventoryEntry)=>e.scope==='plugin'?e.plugin??'Plugin':e.scope==='project'?'Project':'Global';
const detail=(e:InventoryEntry)=>e.kind==='mcp'?[e.transport==='stdio'?'local command':e.transport,e.target].filter(Boolean).join(' · '):e.description??'';

export const InventoryPicker=forwardRef<FilePickerHandle,{sessionId:string;kind:InvocationKind;query:string;listboxId:string;onActiveOption(id:string|undefined):void;onChoose(name:string):void;onClose():void}>(function InventoryPicker({sessionId,kind,query,listboxId,onActiveOption,onChoose,onClose},ref){
 const [inventory,setInventory]=useState<Inventory|null>(null);const [status,setStatus]=useState('Loading…');const [selected,setSelected]=useState(0);const generation=useRef(0);
 useEffect(()=>{const version=++generation.current;const controller=new AbortController();setInventory(null);setStatus('Loading…');void new SessionClient(sessionId).inventory(controller.signal).then(value=>{if(!controller.signal.aborted&&version===generation.current){setInventory(value);setStatus('');}}).catch(e=>{if(!controller.signal.aborted&&version===generation.current)setStatus(e instanceof Error?e.message:'List unavailable');});return()=>controller.abort();},[sessionId]);
 const results=inventory?rankEntries(inventory.entries,kind,query):[];
 const noun=kind==='skill'?'skills':'MCP servers';
 const anyOfKind=!!inventory?.entries.some(e=>e.kind===kind);
 const message=status||(results.length?'':anyOfKind?`No matching ${noun}`:`No ${noun} found for this agent`);
 useEffect(()=>{setSelected(0);},[query,kind]);
 useEffect(()=>{onActiveOption(results[selected]?`${listboxId}-${selected}`:undefined);return()=>onActiveOption(undefined);},[results.length,selected,listboxId,onActiveOption]);
 const choose=(index:number)=>{const result=results[index];if(result)onChoose(result.name);};
 useImperativeHandle(ref,()=>({key(key){if(key==='Escape'){onClose();return true;}if(key==='ArrowDown'||key==='ArrowUp'){setSelected(i=>results.length?(i+(key==='ArrowDown'?1:-1)+results.length)%results.length:0);return true;}if(key==='Enter'||key==='Tab'){if(results.length){choose(selected);return true;}if(key==='Enter')onClose();return false;}return false;}}));
 return <div className="file-picker inventory-picker" dir="ltr"><div id={listboxId} role="listbox" aria-label={kind==='skill'?'Skills':'MCP servers'}>{results.map((e,index)=><button id={`${listboxId}-${index}`} type="button" role="option" aria-selected={index===selected} key={e.name} onMouseDown={ev=>ev.preventDefault()} onClick={()=>choose(index)}><strong>{(kind==='skill'?'/':'$')+e.name}<small className="inventory-badge">{badge(e)}</small></strong>{detail(e)&&<span>{detail(e)}</span>}</button>)}</div>{message&&<span role="status">{message}</span>}{inventory?.problems.length?<small className="inventory-problems">{inventory.problems.join(' · ')}</small>:null}</div>;
});
