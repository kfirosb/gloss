import {test,expect,type Page} from '@playwright/test';
import {mockSession,basicSnapshot} from './session-fixture.js';
const folder=(name:string,path=name)=>({name,relativePath:path,kind:'directory'});
const file=(name:string,path=name)=>({name,relativePath:path,kind:'file'});
async function setup(page:Page){
 await mockSession(page,basicSnapshot);
 await page.route('**/events',r=>r.fulfill({contentType:'text/event-stream',body:''}));
 await page.route('**/files/preview?*',r=>r.fulfill({json:{name:'notes.txt',relativePath:'src/notes.txt',state:'text',size:4,text:'Note'}}));
}
async function open(page:Page){await page.goto('/#capability=test');await page.getByRole('button',{name:'Files',exact:true}).click();}
test('nested folders retain siblings and cached children when collapsed with keyboard',async({page})=>{
 await setup(page);let srcLoads=0;
 await page.route('**/files/browse?*',r=>{const path=new URL(r.request().url()).searchParams.get('path');if(path==='src')srcLoads++;return r.fulfill({json:{entries:path==='src'?[folder('nested','src/nested'),file('notes.txt','src/notes.txt')]:path==='src/nested'?[file('deep.txt','src/nested/deep.txt')]:[folder('src'),folder('docs'),file('README.md')],limited:false}});});
 await open(page);const src=page.getByRole('button',{name:'Open folder src',exact:true});await src.click();
 await expect(page.getByRole('button',{name:'Preview notes.txt'})).toBeVisible();await expect(page.getByRole('button',{name:'Open folder docs'})).toBeVisible();await expect(page.getByRole('button',{name:'Preview README.md'})).toBeVisible();
 await page.getByRole('button',{name:'Open folder nested'}).click();await expect(page.getByRole('button',{name:'Preview deep.txt'})).toBeVisible();
 await src.focus();await src.press('ArrowLeft');await expect(src).toHaveAttribute('aria-expanded','false');await expect(page.getByRole('button',{name:'Preview notes.txt'})).toHaveCount(0);
 await src.press('ArrowRight');await expect(page.getByRole('button',{name:'Preview deep.txt'})).toBeVisible();expect(srcLoads).toBe(1);
 const parent=await src.boundingBox();const child=await page.getByRole('button',{name:'Preview deep.txt'}).boundingBox();expect(child!.x).toBeGreaterThan(parent!.x);
});
test('folder pages append without duplicate files or replacing siblings',async({page})=>{
 await setup(page);
 await page.route('**/files/browse?*',r=>{const params=new URL(r.request().url()).searchParams;const path=params.get('path');return r.fulfill({json:!path?{entries:[folder('src'),file('README.md')],limited:false}:params.get('offset')==='0'?{entries:[file('first.txt','src/first.txt')],nextOffset:100,limited:true}:{entries:[file('first.txt','src/first.txt'),file('last.txt','src/last.txt')],limited:false}});});
 await open(page);await page.getByRole('button',{name:'Open folder src'}).click();await page.getByRole('button',{name:'More files in src',exact:true}).click();
 await expect(page.getByRole('button',{name:'Preview first.txt'})).toHaveCount(1);await expect(page.getByRole('button',{name:'Preview last.txt'})).toBeVisible();await expect(page.getByRole('button',{name:'Preview README.md'})).toBeVisible();await expect(page.getByRole('button',{name:'More files in src'})).toHaveCount(0);
});
test('rows stay single line and compact with selection and safe drag identity',async({page})=>{
 await setup(page);await page.route('**/files/browse?*',r=>r.fulfill({json:{entries:[file('notes.txt','src/notes.txt'),file('a-very-long-filename-that-must-not-wrap-onto-another-line.txt')],limited:false}}));
 await open(page);const row=page.getByRole('button',{name:'Preview notes.txt'});expect((await row.boundingBox())!.height).toBeLessThanOrEqual(30);await expect(row).toHaveText('notes.txt');
 const long=page.getByRole('button',{name:'Preview a-very-long-filename-that-must-not-wrap-onto-another-line.txt'});expect((await long.boundingBox())!.height).toBeLessThanOrEqual(30);
 const payload=await row.evaluate(e=>{const data=new DataTransfer();e.dispatchEvent(new DragEvent('dragstart',{dataTransfer:data,bubbles:true}));return data.getData('application/x-session-file');});expect(JSON.parse(payload)).toEqual({sessionId:'basic',relativePath:'src/notes.txt'});
 await row.click();await page.getByRole('button',{name:'Close preview',exact:true}).click();await expect(row).toHaveAttribute('aria-current','true');
});
test('failed child requests retry inline without discarding the root',async({page})=>{
 await setup(page);let failed=true;await page.route('**/files/browse?*',r=>{const path=new URL(r.request().url()).searchParams.get('path');if(path&&failed){failed=false;return r.fulfill({status:500,json:{error:'Folder temporarily unavailable'}});}return r.fulfill({json:{entries:path?[file('recovered.txt','src/recovered.txt')]:[folder('src'),file('README.md')],limited:false}});});
 await open(page);await page.getByRole('button',{name:'Open folder src'}).click();await expect(page.getByRole('alert')).toContainText('Folder temporarily unavailable');await expect(page.getByRole('button',{name:'Preview README.md'})).toBeVisible();await page.getByRole('button',{name:'Retry src',exact:true}).click();await expect(page.getByRole('button',{name:'Preview recovered.txt'})).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});
