import { test, expect, vi } from 'vitest';
import { createTestWorkflow } from '../helpers/create-test-workflow.js';
test('file review uses language tools without changing discussion or sending to the coding agent', async()=>{
 const app=await createTestWorkflow();
 try {
  const before=app.workflow.snapshot();
  const summary=vi.spyOn(app.language,'summarize').mockResolvedValue('תקציר');
  const translation=vi.spyOn(app.language,'translate').mockResolvedValue('תרגום');
  const signal=new AbortController().signal;
  expect(await app.workflow.reviewFileText('Long file','summary',signal)).toBe('תקציר');
  expect(summary).toHaveBeenCalledWith('Long file','he',expect.any(AbortSignal));
  expect(await app.workflow.reviewFileText('Long file','translation',signal)).toBe('תרגום');
  expect(translation).toHaveBeenCalledWith('Long file','Hebrew',expect.any(AbortSignal));
  expect(app.workflow.snapshot()).toEqual(before);
  await expect(app.workflow.reviewFileText('x'.repeat(160001),'summary',signal)).rejects.toThrow('160000');
 } finally {await app.workflow.close();}
});
