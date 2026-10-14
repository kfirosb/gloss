import {useEffect,useRef,useState} from 'react';
import type {CatalogEntry} from '../core/session-catalog.js';
import {diffAlerts,emptyTracker,useAlertSettings,type AlertEvent} from './attention-alerts.js';

export interface AlertBanner {key:string;sessionId:string;text:string}
const MAX_BANNERS=3,SOUND_GAP_MS=2000,HIDE_MS=8000;
const isFocused=()=>document.visibilityState==='visible'&&document.hasFocus();
/** Folder name, plus the session title when the folder has more than one open session. */
function bannerText(event:AlertEvent,entries:readonly CatalogEntry[]){
 const entry=entries.find(e=>e.sessionId===event.sessionId);
 const folder=(entry?.worktreePath??entry?.target.projectId??'').split('/').filter(Boolean).at(-1)??'Session';
 const crowded=entries.filter(e=>e.open&&(e.worktreePath??e.target.projectId)===(entry?.worktreePath??entry?.target.projectId)).length>1;
 const label=crowded&&entry?.sessionTitle?`${folder} · ${entry.sessionTitle}`:folder;
 return `${label} — ${event.kind==='reply'?'New reply':'Approval needed'}`;
}
/** Turns catalog changes into banners and one sound/bounce per burst, honouring the alert settings. */
export function useAttentionAlerts(entries:readonly CatalogEntry[]|undefined,selectedId:string){
 const [settings]=useAlertSettings();
 const [banners,setBanners]=useState<AlertBanner[]>([]);
 const tracker=useRef(emptyTracker),lastSound=useRef(0);
 useEffect(()=>{
  if(!entries)return;
  const {events,tracker:next}=diffAlerts(tracker.current,entries,{focused:isFocused(),selectedId});tracker.current=next;
  if(!events.length)return;
  const now=Date.now();const sound=settings.sound&&now-lastSound.current>=SOUND_GAP_MS?settings.soundName:undefined;
  if(sound)lastSound.current=now;
  if(sound||settings.message)window.languageAssistant?.alert?.({...(sound?{sound}:{}),bounce:settings.message});
  if(settings.message)setBanners(old=>[...old.filter(b=>!events.some(e=>e.sessionId===b.sessionId)),...events.map(e=>({key:e.key,sessionId:e.sessionId,text:bannerText(e,entries)}))].slice(-MAX_BANNERS));
 },[entries,selectedId,settings]);
 // Opening a session clears its banners.
 useEffect(()=>{setBanners(old=>old.some(b=>b.sessionId===selectedId)?old.filter(b=>b.sessionId!==selectedId):old);},[selectedId]);
 return {banners,dismiss:(key:string)=>setBanners(old=>old.filter(b=>b.key!==key))};
}
function Toast({banner,onOpen,onDismiss}:{banner:AlertBanner;onOpen():void;onDismiss():void}){
 useEffect(()=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const start=()=>{if(!timer&&isFocused())timer=setTimeout(onDismiss,HIDE_MS);};
  const stop=()=>{clearTimeout(timer);timer=undefined;};
  start();window.addEventListener('focus',start);window.addEventListener('blur',stop);
  return()=>{stop();window.removeEventListener('focus',start);window.removeEventListener('blur',stop);};
 },[banner.key]);
 return <div className="attn-toast" role="status"><span className="attn-dot" aria-hidden="true"/><span className="attn-toast-text">{banner.text}</span><button type="button" onClick={onOpen}>Open</button><button type="button" className="attn-toast-close" aria-label="Dismiss" onClick={onDismiss}>×</button></div>;
}
export function AttentionToasts({banners,onOpen,onDismiss}:{banners:AlertBanner[];onOpen(sessionId:string):void;onDismiss(key:string):void}){
 if(!banners.length)return null;
 return <div className="attn-toasts" dir="ltr">{banners.map(b=><Toast key={b.key} banner={b} onOpen={()=>{onDismiss(b.key);onOpen(b.sessionId);}} onDismiss={()=>onDismiss(b.key)}/>)}</div>;
}
