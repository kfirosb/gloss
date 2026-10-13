import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../../src/runtime/application.js';
import { startServer } from '../../src/runtime/http-server.js';
import { FakeAgent } from '../helpers/fake-agent.js';
import { FakeLanguageSession } from '../helpers/fake-language.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
 const app = createApplication({store:new SqliteStore(':memory:'), agents:[new FakeAgent('claude')], languageBackends:{claude:{open:async()=>new FakeLanguageSession(),models:async()=>[]}},capability:'cap'});
 app.catalog!.start();
 const server = await startServer(app);
 cleanup.push(async()=>{await server.close();await app.close();});
 const request = (path:string, token='cap') => fetch(new URL(path,server.url),{headers:{Authorization:'Bearer '+token}});
 return {app,request};
}
it('protects both catalog routes and returns an authoritative snapshot',async()=>{
 const {app,request}=await setup();
 for(const route of ['/api/session-catalog','/api/session-catalog/events']) expect((await request(route,'wrong')).status).toBe(401);
 const response=await request('/api/session-catalog');
 expect(response.status).toBe(200); expect(await response.json()).toEqual(app.catalog!.snapshot());
 expect(await (await request('/api/sessions')).json()).toEqual([]);
 expect((await request('/api/sessions/missing/snapshot')).status).toBe(404);
});
it('streams one initial snapshot, membership and activity changes, and cleans up on disconnect',async()=>{
 const {app,request}=await setup();
 const original=app.catalog!.subscribe; const removed=vi.fn();
 vi.spyOn(app.catalog!,'subscribe').mockImplementation(listener=>{const unsubscribe=original(listener);return()=>{unsubscribe();removed();};});
 const response=await request('/api/session-catalog/events');expect(response.status).toBe(200);
 const reader=response.body!.getReader(); const decoder=new TextDecoder();
 const initial=decoder.decode((await reader.read()).value);
 expect(initial.match(/data: /g)).toHaveLength(1);expect(JSON.parse(initial.slice(6))).toEqual(app.catalog!.snapshot());
 await app.sessions!.register({agent:'claude',sessionRef:'A',projectId:process.cwd()},'A');
 const next=JSON.parse(decoder.decode((await reader.read()).value).trim().slice(6));
 expect(next.entries).toEqual([expect.objectContaining({sessionId:'A',open:false,activity:'disconnected'})]);
 expect(next.sequence).toBeGreaterThan(JSON.parse(initial.slice(6)).sequence);
 await app.sessions!.ensure('A');
 const activity=decoder.decode((await reader.read()).value);
 expect(activity).toContain('"activity":"idle"');
 await reader.cancel();await vi.waitFor(()=>expect(removed).toHaveBeenCalledTimes(1));
});
