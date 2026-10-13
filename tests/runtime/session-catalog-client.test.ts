import { afterEach, expect, it, vi } from 'vitest';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';
import { subscribeSessionCatalog, type SessionCatalogState } from '../../src/ui/use-session-catalog.js';
const snapshot=(epoch:string,sequence:number):CatalogSnapshot=>({epoch,sequence,entries:[],discovery:{state:'healthy'}});
const stops:(()=>void)[]=[];
afterEach(()=>{for(const stop of stops.splice(0))stop();vi.unstubAllGlobals();vi.useRealTimers();});
function setup(initial:Promise<Response>=Promise.resolve(Response.json(snapshot('a',0)))) {
 vi.stubGlobal('location',{hash:'#capability=secret'});
 const streams:ReadableStreamDefaultController<Uint8Array>[]=[]; const cancelled=vi.fn();
 const fetcher=vi.fn((url:string)=>url.endsWith('/events')?Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(c){streams.push(c);},cancel:cancelled}))):initial.then(response=>response.clone()));
 vi.stubGlobal('fetch',fetcher);
 const states:SessionCatalogState[]=[];const stop=subscribeSessionCatalog(state=>states.push(state));stops.push(stop);
 const send=(value:CatalogSnapshot,index=0)=>streams[index]!.enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n'));
 return {streams,send,states,fetcher,cancelled,stop,setSnapshot:(value:CatalogSnapshot)=>{initial=Promise.resolve(Response.json(value));}};
}
it('rejects out-of-order sequences and retired epochs while accepting a new epoch',async()=>{
 const h=setup();await vi.waitFor(()=>expect(h.streams).toHaveLength(1));
 for(const value of [snapshot('a',3),snapshot('a',2),snapshot('b',0),snapshot('a',99)])h.send(value);
 await vi.waitFor(()=>expect(h.states.at(-1)?.catalog?.epoch).toBe('b'));
 expect(h.states.at(-1)?.catalog?.sequence).toBe(0);
 expect(h.states.some(s=>s.catalog?.sequence===2||s.catalog?.sequence===99)).toBe(false);
 for(const [,init] of h.fetcher.mock.calls as unknown as [string,RequestInit][])expect(init.headers).toMatchObject({Authorization:'Bearer secret'});
});
it('does not let a delayed fetch replace a newer stream snapshot, including another epoch',async()=>{
 let resolve!:(r:Response)=>void;const h=setup(new Promise(r=>{resolve=r;}));
 await vi.waitFor(()=>expect(h.streams).toHaveLength(1));h.send(snapshot('b',7));
 await vi.waitFor(()=>expect(h.states.at(-1)?.catalog?.sequence).toBe(7));
 resolve(Response.json(snapshot('a',100)));await new Promise(r=>setTimeout(r,10));
 expect(h.states.at(-1)?.catalog).toEqual(snapshot('b',7));
});
it('retains stale data on disconnect and recovers the authoritative snapshot on reconnect',async()=>{
 const h=setup();await vi.waitFor(()=>expect(h.states.at(-1)?.catalog?.sequence).toBe(0));
 h.send(snapshot('a',4));await vi.waitFor(()=>expect(h.states.at(-1)?.catalog?.sequence).toBe(4));
 h.setSnapshot(snapshot('b',0));
 h.streams[0]!.close();await vi.waitFor(()=>expect(h.states.at(-1)?.error).toBeTruthy());
 expect(h.states.at(-1)?.catalog).toMatchObject({sequence:4,discovery:{state:'stale'}});
 await vi.waitFor(()=>expect(h.streams).toHaveLength(2),{timeout:2000});
 h.send(snapshot('b',0),1);await vi.waitFor(()=>expect(h.states.at(-1)).toEqual({catalog:snapshot('b',0),error:null}));
});
it('cancels the reader and requests on cleanup and never publishes delayed results',async()=>{
 let resolve!:(r:Response)=>void;const h=setup(new Promise(r=>{resolve=r;}));
 await vi.waitFor(()=>expect(h.streams).toHaveLength(1));h.stop();const count=h.states.length;
 resolve(Response.json(snapshot('a',1)));await vi.waitFor(()=>expect(h.cancelled).toHaveBeenCalledTimes(1));
 expect(h.states).toHaveLength(count);
 for(const [,init] of h.fetcher.mock.calls as unknown as [string,RequestInit][])expect(init.signal?.aborted).toBe(true);
});
it('does not retire a newer HTTP epoch when an older initial stream frame arrives afterward',async()=>{
 const h=setup(Promise.resolve(Response.json(snapshot('new',0))));
 await vi.waitFor(()=>expect(h.states.at(-1)?.catalog?.epoch).toBe('new'));
 h.send(snapshot('old',20));
 await new Promise(r=>setTimeout(r,10));
 expect(h.states.some(state=>state.catalog?.epoch==='old')).toBe(false);
 // The old server closes; the replacement connection must still accept new.
 try { h.streams[0]!.close(); } catch { /* transport may already cancel a conflicting stream */ }
 await vi.waitFor(()=>expect(h.streams).toHaveLength(2),{timeout:2000});
 h.send(snapshot('new',1),1);
 await vi.waitFor(()=>expect(h.states.at(-1)).toEqual({catalog:snapshot('new',1),error:null}));
});
