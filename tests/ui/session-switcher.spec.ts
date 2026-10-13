import { test, expect, type Page } from '@playwright/test';
import { sessionFixture } from './multi-session-fixture.js';
import { expectSelected } from './session-fixture.js';
import type { CatalogSnapshot } from '../../src/core/session-catalog.js';
const tab=(page:Page,key:string)=>page.locator(`[role=tab][data-session-key="${key}"]`);
const header=(page:Page)=>page.locator('.session-header');
const sidebar=(page:Page)=>page.getByRole('navigation',{name:'Sessions'});
async function setup(context: Parameters<typeof sessionFixture>[0]) {
 const f=await sessionFixture(context);
 const catalog: CatalogSnapshot={epoch:'test',sequence:1,discovery:{state:'healthy'},entries:f.records.map(r=>({key:r.id,sessionId:r.id,target:r.target as any,projectKey:'/common',projectName:'Project',branch:r.id==='A'?'main':'feature',worktreePath:'/worktree',open:true,activity:'idle',availability:'available'}))};
 await context.route('**/api/session-catalog',r=>r.fulfill({json:catalog}));
 await context.route('**/api/session-catalog/events',r=>r.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify(catalog)+'\n\n'}));
 return {...f,catalog};
}
test('catalog updates add tabs without retargeting or replacing unsent work',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');
 const input=page.getByRole('textbox',{name:'Discuss with language assistant'});await input.fill('Preserve my draft');
 await page.getByRole('button',{name:'Add to answer',exact:true}).click();await page.getByRole('button',{name:'Prepare instruction',exact:true}).click();await page.getByRole('button',{name:'Close review',exact:true}).click();
 await expect(tab(page,'A')).toHaveAttribute('aria-selected','true');
 await sidebar(page).getByRole('button',{name:'Session details',exact:true}).click();await expect(sidebar(page)).toContainText('Project: /project/A');await expect(sidebar(page)).toContainText('Codex session: A');await expect(sidebar(page)).toContainText('Branch: main');
 f.catalog.entries[0]!.activity='working';f.catalog.sequence++;
 f.records.push({...f.records[1]!,id:'C',target:{...f.records[1]!.target,sessionRef:'C'}});f.snapshots.C={...f.snapshots.B,id:'C',target:f.records[2]!.target};f.workspaces.C={...structuredClone(f.workspaces.B!),sessionId:'C'};f.sequences.C=1;
 f.catalog.entries.push({...f.catalog.entries[1]!,key:'C',sessionId:'C',target:f.records[2]!.target as any,branch:'new-worktree'});
 await expect(header(page)).toContainText('Working');await expect(tab(page,'C')).toBeVisible();await expect(input).toHaveValue('Preserve my draft');await expect(page.getByRole('button',{name:'Resume review'})).toBeVisible();
 await tab(page,'C').click();await expectSelected(page,'C');await expect(sidebar(page)).toContainText('Branch: new-worktree');await expect(input).toHaveValue('');await tab(page,'A').click();await expect(input).toHaveValue('Preserve my draft');
});
test('closure preserves selection; saved and unavailable sessions stay honest',async({page,context})=>{
 const f=await setup(context);f.catalog.entries.push({...f.catalog.entries[1]!,key:'unsupported',branch:'unsupported',availability:'unavailable',reason:'Native transport unsupported'});
 delete f.catalog.entries.at(-1)!.sessionId;
 await page.goto('/#capability=test');
 await expect(tab(page,'unsupported')).toHaveAttribute('aria-disabled','true');await expect(tab(page,'unsupported')).toHaveAccessibleDescription(/Native transport unsupported/);
 await tab(page,'A').focus();f.catalog.entries[0]!.open=false;f.catalog.entries[0]!.activity='disconnected';f.catalog.sequence++;
 await expect(header(page)).toContainText('Disconnected');await expect(tab(page,'A')).toHaveCount(0);await expectSelected(page,'A');
 await page.getByRole('button',{name:'Saved sessions (1)'}).click();await expect(page.getByRole('menuitem',{name:/Disconnected/})).toBeVisible();
 await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0);await tab(page,'B').focus();await page.keyboard.press('Enter');await expectSelected(page,'B');await expect(header(page)).toContainText('Idle');
 await page.getByRole('button',{name:'Saved sessions (1)'}).click();await page.locator('[role=menuitem][data-session-id="A"]').click();await expectSelected(page,'A');await expect(header(page)).toContainText('Disconnected');
});
test('session details fit narrow short viewports',async({page,context})=>{
 await setup(context);await page.setViewportSize({width:390,height:450});await page.goto('/#capability=test');await page.getByRole('button',{name:'Expand sessions'}).click();const picker=sidebar(page);await expect(picker.getByRole('button',{name:'Find sessions by path',exact:true})).toHaveCount(0);await picker.getByRole('button',{name:'Session details',exact:true}).click();await expect(picker).toContainText('Project:');const box=await picker.boundingBox();expect(box!.x+box!.width).toBeLessThanOrEqual(390);expect(box!.y+box!.height).toBeLessThanOrEqual(450);
});
test('catalog changes retain tab-local selections and stable groups even with matching project names',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');const other=await context.newPage();await other.goto('/#capability=test');
 await tab(page,'B').click();await expectSelected(page,'B');
 await expectSelected(other,'A');const order=await page.locator('[role=tab]').allTextContents();
 f.catalog.entries[0]!.activity='working';f.catalog.entries[1]!.activity='connecting';f.catalog.entries.push({...f.catalog.entries[1]!,key:'other-project',sessionId:'other',target:{...f.catalog.entries[1]!.target,sessionRef:'other'},projectKey:'/other-common',worktreePath:'/other-worktree',branch:'same-name-project'});f.catalog.sequence++;
 await expect(sidebar(page).getByRole('group',{name:'Project',exact:true})).toHaveCount(2);await expect(tab(page,'A').getByRole('img',{name:'Working'})).toBeVisible();expect((await page.locator('[role=tab]').allTextContents()).map(s=>s.replace(/Working|Connecting/g,'Idle'))).toEqual(order);
 await expectSelected(page,'B');await expectSelected(other,'A');await expect(sidebar(page).getByText('Discovery stale',{exact:true})).toBeVisible();
 await page.screenshot({path:'test-results/session-picker-desktop.png'});await other.close();
});
test('early catalog must wait for launch bootstrap before hydrating a restored workspace',async({page,context})=>{
 await setup(context);let release!:()=>void;
 await context.route('**/api/snapshot',async route=>{await new Promise<void>(resolve=>{release=resolve;});await route.fallback();});
 await page.addInitScript(()=>sessionStorage.setItem('selected-session','A'));
 await page.goto('/#capability=test');await expect.poll(()=>Boolean(release)).toBe(true);await page.waitForTimeout(300);
 await expect(page.getByRole('textbox',{name:'Discuss with language assistant'})).toHaveCount(0);release();await expect(page.getByRole('textbox',{name:'Discuss with language assistant'})).toBeVisible();
});
test('missing discovery reports unknown activity rather than inventing a disconnected destination',async({page,context})=>{
 await sessionFixture(context);await page.goto('/#capability=test');await expectSelected(page,'A');await expect(header(page)).toContainText('Idle');await expect(header(page)).not.toContainText('Disconnected');await expect(sidebar(page).getByText('Discovery stale',{exact:true})).toBeVisible();
});
test('retry repeats failed bootstrap even when the catalog has already loaded records',async({page,context})=>{
 await setup(context);let failed=true;
 await context.route('**/api/snapshot',route=>failed?route.fulfill({status:503,json:{error:'Launch temporarily unavailable'}}):route.fallback());
 await page.goto('/#capability=test');await expect(page.getByRole('alert')).toContainText('Launch temporarily unavailable');await page.waitForTimeout(300);failed=false;
 await page.getByRole('button',{name:'Retry connection'}).click();await expect(page.getByRole('textbox',{name:'Discuss with language assistant'})).toBeVisible();
});
test('a slow record lookup keeps the previous selection until the new session is ready',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');await expect(page.getByRole('textbox',{name:'Discuss with language assistant'})).toBeVisible();
 let releases:(()=>void)[]=[];await context.route('**/api/sessions',async route=>{await new Promise<void>(resolve=>releases.push(resolve));return route.fulfill({json:f.records});});
 f.catalog.entries.push({...f.catalog.entries[1]!,key:'C',sessionId:'C',target:{...f.catalog.entries[1]!.target,sessionRef:'C'},branch:'pending-new'});f.catalog.sequence++;
 await tab(page,'C').click();await expect(tab(page,'A')).toHaveAttribute('aria-selected','true');await expectSelected(page,'A');
 f.records.push({...f.records[1]!,id:'C',target:{...f.records[1]!.target,sessionRef:'C'}});f.snapshots.C={...f.snapshots.B,id:'C',target:f.records[2]!.target};f.workspaces.C={...structuredClone(f.workspaces.B!),sessionId:'C'};f.sequences.C=1;await expect.poll(()=>releases.length).toBeGreaterThan(0);for(const release of releases)release();await expectSelected(page,'C');
});
test('a slow record lookup cannot override a later tab choice',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');await expect(page.getByRole('textbox',{name:'Discuss with language assistant'})).toBeVisible();
 let releases:(()=>void)[]=[];await context.route('**/api/sessions',async route=>{await new Promise<void>(resolve=>releases.push(resolve));return route.fulfill({json:f.records});});
 f.catalog.entries.push({...f.catalog.entries[1]!,key:'C',sessionId:'C',target:{...f.catalog.entries[1]!.target,sessionRef:'C'},branch:'pending-new'});f.catalog.sequence++;
 await tab(page,'C').click();await expect.poll(()=>releases.length).toBeGreaterThan(0);
 await tab(page,'B').click();await expectSelected(page,'B');
 f.records.push({...f.records[1]!,id:'C',target:{...f.records[1]!.target,sessionRef:'C'}});f.snapshots.C={...f.snapshots.B,id:'C',target:f.records[2]!.target};f.workspaces.C={...structuredClone(f.workspaces.B!),sessionId:'C'};f.sequences.C=1;
 for(const release of releases)release();await page.waitForTimeout(500);
 await expect(tab(page,'B')).toHaveAttribute('aria-selected','true');await expect(tab(page,'C')).toHaveAttribute('aria-selected','false');await expectSelected(page,'B');await expect(header(page)).toContainText('B / B');
});
test('a failed tab selection shows an alert without a retry-connection button',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');
 f.catalog.entries.push({...f.catalog.entries[1]!,key:'ghost',sessionId:'ghost',target:{...f.catalog.entries[1]!.target,sessionRef:'ghost'}});f.catalog.sequence++;
 await tab(page,'ghost').click();await expect(page.getByRole('alert')).toContainText('Session is not available yet');await expect(page.getByRole('button',{name:'Retry connection'})).toHaveCount(0);await expectSelected(page,'A');
});
test('catalog updates preserve composer focus after a focused tab is left',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');await tab(page,'A').focus();
 const input=page.getByRole('textbox',{name:'Discuss with language assistant'});await input.click();await input.fill('Keep editing here');f.catalog.entries[0]!.activity='working';f.catalog.sequence++;
 await expect(header(page)).toContainText('Working');await expect(input).toBeFocused();await input.press('End');await input.press('!');await expect(input).toHaveValue('Keep editing here!');
});
test('selected tab exposes destination and activity to assistive technology',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');const selected=tab(page,'A');await expect(selected).toHaveAccessibleDescription(/Codex session: A.*Project.*Branch: main/);await expect(selected).toHaveAccessibleName(/Idle/);f.catalog.entries[0]!.activity='working';f.catalog.sequence++;await expect(selected).toHaveAccessibleName(/Working/);await expect(selected).toHaveAttribute('aria-selected','true');
});
test('unsupported native identity replaces a registered tab without losing selected work',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');const input=page.getByRole('textbox',{name:'Discuss with language assistant'});await input.fill('Preserve unsupported work');await page.getByRole('button',{name:'Add to answer',exact:true}).click();await page.getByRole('button',{name:'Prepare instruction',exact:true}).click();await page.getByRole('button',{name:'Close review',exact:true}).click();
 delete f.catalog.entries[0]!.sessionId;f.catalog.entries[0]!.availability='unavailable';f.catalog.entries[0]!.reason='Native transport unsupported';f.catalog.sequence++;
 await expect(tab(page,'A')).toHaveAccessibleDescription(/Native transport unsupported/);await expect(page.locator('[role=tab]')).toHaveCount(2);await expect(tab(page,'A')).toHaveAttribute('aria-disabled','true');await expectSelected(page,'A');await page.keyboard.press('Escape');await expect(input).toHaveValue('Preserve unsupported work');await page.getByRole('button',{name:'Resume review'}).click();await expect(page.getByRole('dialog',{name:'Review instruction',exact:true})).toContainText('Prepared A');
});
test('fallback titles remain compact with complete native IDs in details and accessibility',async({page,context})=>{
 const f=await setup(context);const native='019aa123-4567-7890-abcd-123456789abc';f.records[0]!.target.sessionRef=native;f.catalog.entries[0]!.target.sessionRef=native;
 await page.goto('/#capability=test');const row=tab(page,'A');await expect(row.locator('.session-tab-title')).toContainText('019aa123');await expect(row.locator('.session-tab-title')).not.toContainText(native);await expect(row).toHaveAccessibleDescription(new RegExp(native));await sidebar(page).getByRole('button',{name:'Session details',exact:true}).click();await expect(page.locator('.session-details')).toContainText(native);
});
test('same-name project groups expose visible parent paths',async({page,context})=>{
 const f=await setup(context);f.catalog.entries[0]!.projectKey='/clients/one/project/.git';f.catalog.entries[1]!.projectKey='/clients/two/project/.git';
 await page.goto('/#capability=test');await expect(sidebar(page).getByText('/clients/one/project',{exact:true})).toBeVisible();await expect(sidebar(page).getByText('/clients/two/project',{exact:true})).toBeVisible();
});
test('reconnect appears only for a disconnected selected destination',async({page,context})=>{
 const f=await setup(context);await page.goto('/#capability=test');await sidebar(page).getByRole('button',{name:'Session details',exact:true}).click();const reconnect=page.getByRole('button',{name:'Reconnect same target'});await expect(reconnect).toHaveCount(0);f.catalog.entries[0]!.open=false;f.catalog.entries[0]!.activity='disconnected';f.catalog.sequence++;await expect(reconnect).toBeVisible();
});
test('pending native initialization shows Connecting while remaining unselectable',async({page,context})=>{
 const f=await setup(context);const pending={...f.catalog.entries[1]!,key:'pending-native',target:{...f.catalog.entries[1]!.target,sessionRef:'pending-native'},branch:'pending-connection',activity:'connecting' as const,availability:'unavailable' as const};delete pending.sessionId;f.catalog.entries.push(pending);
 await page.goto('/#capability=test');const row=tab(page,'pending-native');await expect(row).toHaveAttribute('aria-disabled','true');await expect(row.getByRole('img',{name:'Connecting',exact:true})).toBeVisible();await expect(row.getByRole('img',{name:/Unavailable/})).toHaveCount(0);
});
test('manual Claude activity remains visible independently of discovery membership', async ({ page, context }) => {
 const f = await setup(context);
 f.records[0]!.target.agent = 'claude';
 f.catalog.entries[0]!.target.agent = 'claude';
 f.catalog.entries[0]!.open = false;
 await page.goto('/#capability=test');
 await expect(header(page)).toContainText('Idle');
 await expect(sidebar(page).getByRole('button',{name:'worktree, 1 open'})).toBeVisible();
 await page.getByRole('button',{name:'Saved sessions (1)'}).click();
 const item = page.locator('[role=menuitem][data-session-id="A"]');
 await expect(item.getByRole('img',{name:'Idle',exact:true})).toBeVisible();
 f.catalog.entries[0]!.activity = 'working'; f.catalog.sequence++;
 await expect(header(page)).toContainText('Working'); await expect(item.getByRole('img',{name:'Working',exact:true})).toBeVisible();
 f.catalog.entries[0]!.activity = 'disconnected'; f.catalog.sequence++;
 await expect(header(page)).toContainText('Disconnected'); await expect(item.getByRole('img',{name:'Disconnected',exact:true})).toBeVisible();
 await expectSelected(page, 'A');
});
for (const disconnectDuringOutage of [false, true]) test(`recovered Claude tab stays selectable with authoritative disconnected state ${disconnectDuringOutage}`, async ({ page, context }) => {
 const f = await setup(context);
 f.records[1]!.target.agent = 'claude';
 const entry = f.catalog.entries[1]!;
 entry.target.agent = 'claude';
 await page.goto('/#capability=test');
 const row = tab(page, 'B');
 await expect(row).not.toHaveAttribute('aria-disabled', 'true'); await expect(row.getByRole('img',{name:'Idle',exact:true})).toBeVisible();
 entry.activity = 'disconnected'; entry.availability = 'unavailable'; entry.reason = 'Project directory is unavailable'; f.catalog.sequence++;
 await expect(row).toHaveAttribute('aria-disabled', 'true'); await expect(row).toHaveAccessibleDescription(/Project directory is unavailable/);
 if (disconnectDuringOutage) {
  entry.open = false; f.catalog.sequence++;
  await expect(sidebar(page).getByRole('button',{name:'worktree, 1 open'})).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved sessions (1)' })).toBeVisible();
 }
 entry.availability = 'available'; entry.activity = disconnectDuringOutage ? 'disconnected' : 'idle'; delete entry.reason; f.catalog.sequence++;
 const expected = disconnectDuringOutage ? 'Disconnected' : 'Idle';
 if (disconnectDuringOutage) {
  await page.getByRole('button', { name: 'Saved sessions (1)' }).click();
  const item = page.locator('[role=menuitem][data-session-id="B"]');
  await expect(item).toBeEnabled(); await expect(item.getByRole('img',{name:expected,exact:true})).toBeVisible();
  await expect(sidebar(page).getByRole('button',{name:'worktree, 1 open'})).toBeVisible();
  await expectSelected(page, 'A');
  await item.click();
 } else {
  await expect(row).not.toHaveAttribute('aria-disabled', 'true'); await expect(row.getByRole('img',{name:expected,exact:true})).toBeVisible();
  await expect(row).not.toHaveAccessibleDescription(/Project directory is unavailable/);
  await expect(sidebar(page).getByRole('button',{name:'worktree, 2 open'})).toBeVisible();
  await expectSelected(page, 'A');
  await row.click();
 }
 await expectSelected(page, 'B');
 await expect(header(page)).toContainText(expected);
});
