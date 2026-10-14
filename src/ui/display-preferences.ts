import {useEffect,useState} from 'react';
export type AssistantMode='full'|'compact';
export type Theme='light'|'dark'|'auto';
export interface DisplayPreferences {version:1;collapsed:boolean;assistantModes:Record<string,AssistantMode>;lastByFolder:Record<string,string>;tabOrder:Record<string,string[]>;sidebarWidth:number;theme:Theme}
const maxFolders=500;
const key='language-assistant:display:v1';
const defaults=():DisplayPreferences=>({version:1,collapsed:false,assistantModes:{},lastByFolder:{},tabOrder:{},sidebarWidth:300,theme:'dark'});
const clampWidth=(w:unknown)=>typeof w==='number'&&Number.isFinite(w)?Math.min(440,Math.max(240,Math.round(w))):300;
const objectOf=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function validated(value:unknown):DisplayPreferences{
 if(!value||typeof value!=='object'||(value as DisplayPreferences).version!==1)return defaults();
 const v=value as Partial<DisplayPreferences>;
 const theme=v.theme==='light'||v.theme==='dark'||v.theme==='auto'?v.theme:'dark';
 return {version:1,collapsed:v.collapsed===true,sidebarWidth:clampWidth(v.sidebarWidth),theme,
  assistantModes:Object.fromEntries(Object.entries(objectOf(v.assistantModes)).filter(([,mode])=>mode==='full'||mode==='compact')) as Record<string,AssistantMode>,
  lastByFolder:Object.fromEntries(Object.entries(objectOf(v.lastByFolder)).filter(([,id])=>typeof id==='string')) as Record<string,string>,
  tabOrder:Object.fromEntries(Object.entries(objectOf(v.tabOrder)).filter(([,keys])=>Array.isArray(keys)&&keys.every(k=>typeof k==='string')).map(([k,keys])=>[k,keys as string[]]).slice(-maxFolders))};
}
export function readDisplayPreferences(storage?:Storage):DisplayPreferences{
 try{return validated(JSON.parse((storage??globalThis.localStorage)?.getItem(key)??'null'));}catch{return defaults();}
}
export function writeDisplayPreferences(value:DisplayPreferences,storage?:Storage):void{
 try{(storage??globalThis.localStorage)?.setItem(key,JSON.stringify(validated(value)));}catch{/* In-memory controls remain usable. */}
}
// Stylesheet colors are light-dark() pairs; color-scheme on <html> picks one ('light dark' follows the system).
export function applyTheme(theme:Theme,root:HTMLElement=document.documentElement):void{
 root.style.colorScheme=theme==='auto'?'light dark':theme;
}
let current:DisplayPreferences|undefined;
const listeners=new Set<(value:DisplayPreferences)=>void>();
export function useDisplayPreferences():[DisplayPreferences,(update:(current:DisplayPreferences)=>DisplayPreferences)=>void]{
 const [value,setValue]=useState(()=>current??(current=readDisplayPreferences()));
 useEffect(()=>{listeners.add(setValue);return()=>{listeners.delete(setValue);};},[]);
 return [value,update=>{current=validated(update(current??value));writeDisplayPreferences(current);for(const listener of listeners)listener(current);}];
}
// Drops order/last-selection state for tabs and folders that no longer exist; present keys are never dropped.
export function pruneDisplayPreferences(prefs:DisplayPreferences,present:Record<string,{keys:string[];ids:string[]}>):DisplayPreferences{
 const tabOrder=Object.fromEntries(Object.entries(prefs.tabOrder).filter(([f])=>present[f]).map(([f,keys])=>[f,keys.filter(k=>present[f]!.keys.includes(k))]));
 const lastByFolder=Object.fromEntries(Object.entries(prefs.lastByFolder).filter(([f,id])=>present[f]?.ids.includes(id)));
 const same=(a:object,b:object)=>JSON.stringify(a)===JSON.stringify(b);
 return same(tabOrder,prefs.tabOrder)&&same(lastByFolder,prefs.lastByFolder)?prefs:{...prefs,tabOrder,lastByFolder};
}
