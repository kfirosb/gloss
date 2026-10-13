import { mockSession, basicSnapshot } from './session-fixture.js';
import { expect, test } from '@playwright/test';
for (const [width,height] of [[1280,800],[390,800],[900,450]]) {
  test(`draggable pane boundaries at ${width}x${height}`, async ({page})=>{
    await page.setViewportSize({width:width!,height:height!});
    await mockSession(page, basicSnapshot); await page.goto('/#capability=test');
    await expect(page.getByRole('slider')).toHaveCount(0);
    const live=page.locator('.pane-live');
    const divider=page.getByRole('separator',{name:'Resize Live Conversation'});
    const before=await live.boundingBox(); const box=(await divider.boundingBox())!;
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+(width!>760?70:0),box.y+box.height/2+(width!<=760?70:0),{steps:8});await page.mouse.up();
    const after=(await live.boundingBox())!;
    expect(Math.abs(width!>760?after.width-before!.width:after.height-before!.height)).toBeGreaterThan(10);
    const value=await divider.getAttribute('aria-valuenow');
    const discussion=page.locator('.pane-assistant'); const beforeDiscussion=(await discussion.boundingBox())!;
    const row=page.getByRole('separator',{name:'Resize Language Assistant'}); const r=(await row.boundingBox())!;
    await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2,r.y+r.height/2-50,{steps:8});await page.mouse.up();
    expect(await row.getAttribute('aria-valuenow')).not.toBe('60');
    expect((await discussion.boundingBox())!.height).toBeLessThanOrEqual(beforeDiscussion.height);
    expect(await page.locator('.composer').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;})).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.style.userSelect)).not.toBe('none');
    await page.reload();await expect(divider).toHaveAttribute('aria-valuenow',value!);
  });
}
