import {createHash} from 'node:crypto';
import type {ConversationSnapshot,ConversationStore,LanguageSession} from './contracts.js';
import {summaryCacheKey,type SummarySource,type ResponseSummary,type SummaryKey} from './summary-contracts.js';
export const SUMMARY_PROMPT_VERSION='summary-v2-language';
export function validateSummarySource(value:unknown):asserts value is SummarySource {
 if(!value||typeof value!=='object')throw new Error('Invalid summary source');
 const v=value as SummarySource;
 if((v.kind!=='coding'&&v.kind!=='discussion')||typeof v.messageId!=='string'||!v.messageId||v.messageId.length>300||typeof v.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(v.contentHash))throw new Error('Invalid summary source');
}
export class ResponseSummaries {
 private pending=new Map<string,Promise<ResponseSummary>>();
 private controllers=new Set<AbortController>();
 private closed=false;
 constructor(private snapshot:()=>ConversationSnapshot,private store:ConversationStore,private language:LanguageSession,private model:string){}
 private resolve(source:SummarySource){
  if(this.closed)throw new Error('Workflow is closed');
  validateSummarySource(source);
  const state=this.snapshot();const message=source.kind==='coding'?state.codingMessages.find(m=>m.sourceId===source.messageId):state.discussion.find(m=>m.id===source.messageId);
  if(!message||message.role!=='assistant'||message.complete!==true||!message.text.trim())throw new Error('Select a completed assistant response');
  if(message.text.length>160000)throw new Error('Response exceeds summary input limit');
  if(createHash('sha256').update(message.text).digest('hex')!==source.contentHash)throw new Error('Response changed; request a new summary');
  const key:SummaryKey={...source,sessionId:state.id,language:state.languageSettings?.assist??'he',model:this.model,promptVersion:SUMMARY_PROMPT_VERSION};
  return {text:message.text,key,revision:source.kind==='coding'?(message as ConversationSnapshot['codingMessages'][number]).revision:undefined};
 }
 async summarize(source:SummarySource):Promise<ResponseSummary>{
  source={...source};const initial=this.resolve(source);const cacheKey=summaryCacheKey(initial.key);
  const cached=this.store.getSummary(initial.key);if(cached!==undefined)return {source,text:cached};
  const existing=this.pending.get(cacheKey);if(existing)return existing;
  const controller=new AbortController();this.controllers.add(controller);
  const operation=(async()=>{
   const text=(await this.language.summarize(initial.text,initial.key.language,controller.signal)).trim();
   if(!text||text.length>4000)throw new Error('Invalid summary output');
   const current=this.resolve(source);
   if(controller.signal.aborted||current.revision!==initial.revision||summaryCacheKey(current.key)!==cacheKey)throw new Error('Response changed; request a new summary');
   this.store.putSummary(initial.key,text);return {source,text};
  })();
  this.pending.set(cacheKey,operation);
  try{return await operation;}finally{this.pending.delete(cacheKey);this.controllers.delete(controller);}
 }
 close(){this.closed=true;for(const controller of this.controllers)controller.abort();}
}
