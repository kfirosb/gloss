import {expect,it} from 'vitest';
import {applyTheme,pruneDisplayPreferences,readDisplayPreferences,writeDisplayPreferences,type Theme} from '../../src/ui/display-preferences.js';
const storage=(data:string|null=null)=>({getItem:()=>data,setItem:(_k:string,v:string)=>{data=v;}} as unknown as Storage);
it('recovers from unavailable, corrupt and unknown-version preferences',()=>{
 for(const s of [storage('{'),storage('{"version":99}'),{getItem:()=>{throw Error('denied');}} as unknown as Storage])expect(readDisplayPreferences(s)).toEqual({version:1,collapsed:false,assistantModes:{},lastByFolder:{},tabOrder:{},sidebarWidth:300,theme:'dark'});
 expect(()=>writeDisplayPreferences(readDisplayPreferences(),{setItem:()=>{throw Error('denied');}} as unknown as Storage)).not.toThrow();
});
it('persists validated per-session modes and folder state without routing or capabilities',()=>{
 const s=storage();writeDisplayPreferences({version:1,collapsed:true,assistantModes:{A:'compact',B:'full'},lastByFolder:{},tabOrder:{},sidebarWidth:300,theme:'dark'},s);
 expect(readDisplayPreferences(s)).toEqual({version:1,collapsed:true,assistantModes:{A:'compact',B:'full'},lastByFolder:{},tabOrder:{},sidebarWidth:300,theme:'dark'});
 const bad=storage('{"version":1,"collapsed":"yes","grouping":"no","assistantModes":{"A":"compact","B":"bad"},"capability":"secret"}');
 expect(readDisplayPreferences(bad)).toEqual({version:1,collapsed:false,assistantModes:{A:'compact'},lastByFolder:{},tabOrder:{},sidebarWidth:300,theme:'dark'});
});

it('loads previous-version preferences and keeps new per-folder fields',()=>{
 const storage=new Map<string,string>();const s={getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,v);}} as unknown as Storage;
 storage.set('language-assistant:display:v1',JSON.stringify({version:1,collapsed:true,grouping:'folder',assistantModes:{A:'compact'}}));
 expect(readDisplayPreferences(s)).toEqual({version:1,collapsed:true,assistantModes:{A:'compact'},lastByFolder:{},tabOrder:{},sidebarWidth:300,theme:'dark'});
 writeDisplayPreferences({version:1,collapsed:false,assistantModes:{},lastByFolder:{'/f':'A',bad:1 as any},tabOrder:{'/f':['A','B'],x:'no' as any},sidebarWidth:300,theme:'dark'},s);
 expect(readDisplayPreferences(s)).toEqual({version:1,collapsed:false,assistantModes:{},lastByFolder:{'/f':'A'},tabOrder:{'/f':['A','B']},sidebarWidth:300,theme:'dark'});
});

it('keeps long-lived tab order beyond 200 keys and prunes only vanished keys, folders and selections',()=>{
 const keys=Array.from({length:300},(_,i)=>'k'+i);const s=storage();
 writeDisplayPreferences({version:1,collapsed:false,assistantModes:{},lastByFolder:{'/f':'k0','/gone':'x'},tabOrder:{'/f':keys,'/gone':['x']},sidebarWidth:300,theme:'dark'},s);
 const read=readDisplayPreferences(s);expect(read.tabOrder['/f']).toEqual(keys);
 const present={'/f':{keys:keys.filter(k=>k!=='k5'),ids:['k0']}};
 const pruned=pruneDisplayPreferences(read,present);
 expect(pruned.tabOrder).toEqual({'/f':keys.filter(k=>k!=='k5')});expect(pruned.lastByFolder).toEqual({'/f':'k0'});
 expect(pruneDisplayPreferences(pruned,present)).toBe(pruned);
});

it('validates and persists sidebarWidth',()=>{
 expect(readDisplayPreferences(storage()).sidebarWidth).toBe(300);
 const s=storage();const w=(n:unknown)=>{writeDisplayPreferences({...readDisplayPreferences(),sidebarWidth:n as number},s);return readDisplayPreferences(s).sidebarWidth;};
 expect(w(100)).toBe(240);expect(w(900)).toBe(440);expect(w(350)).toBe(350);expect(w('x')).toBe(300);expect(w(NaN)).toBe(300);
});

it('defaults the theme to dark, persists valid themes and rejects unknown ones',()=>{
 expect(readDisplayPreferences(storage()).theme).toBe('dark');
 expect(readDisplayPreferences(storage('{"version":1,"collapsed":true}')).theme).toBe('dark');
 const s=storage();const t=(theme:unknown)=>{writeDisplayPreferences({...readDisplayPreferences(),theme:theme as Theme},s);return readDisplayPreferences(s).theme;};
 expect(t('light')).toBe('light');expect(t('auto')).toBe('auto');expect(t('dark')).toBe('dark');expect(t('sepia')).toBe('dark');
});

it('maps the theme onto the root color-scheme',()=>{
 const root={style:{colorScheme:''}} as unknown as HTMLElement;
 applyTheme('dark',root);expect(root.style.colorScheme).toBe('dark');
 applyTheme('light',root);expect(root.style.colorScheme).toBe('light');
 applyTheme('auto',root);expect(root.style.colorScheme).toBe('light dark');
});
