import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { chromium, type Browser, type Page } from 'playwright';
import { createClearActServer } from '../../server/src/http.ts';

let browser: Browser;
let bundle: string;
let css: string;
before(async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'clearact-element-browser-'));
  try {
    await build({ entry: { browser: fileURLToPath(new URL('./browser-fixture.tsx', import.meta.url)) }, bundle: true, noExternal: [/.*/], format: ['iife'], globalName: 'Fixture', platform: 'browser', outDir, silent: true, define: { 'process.env.NODE_ENV': '"production"' }, outExtension: () => ({ js: '.js' }) });
    bundle = await readFile(join(outDir, 'browser.js'), 'utf8');
    css = await readFile(join(outDir, 'browser.css'), 'utf8');
  } finally { await rm(outDir, { recursive: true, force: true }); }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
});
after(async () => { await browser?.close(); });

async function mount(kind: 'React' | 'Vue' | 'Unsupported' | 'NativeModals') {
  const app = createClearActServer({ approvalToken: 'human-test-only' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('websocket', socket => { socket.on('socketerror', error => browserErrors.push(String(error))); socket.on('framereceived', frame => browserErrors.push(String(frame.payload))); });
  await page.route(`${base}/fixture`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><div id="app"></div>' }));
  await page.goto(`${base}/fixture`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle + '\nglobalThis.__name=(fn)=>fn;' });
  await page.evaluate(({ kind, base }) => { const w = window as any; w.fixture = w.Fixture[`mount${kind}`](base); }, { kind, base });
  const sessionId = kind === 'React' ? 'react-fixture' : kind === 'Vue' ? 'vue-fixture' : kind === 'Unsupported' ? 'unsupported-fixture' : 'native-modals-fixture';
  await page.waitForFunction(() => !!document.querySelector('form,.el-table,dialog[open]'));
  const deadline = Date.now() + 5000;
  while (!app.broker.listSessions().some(session => session.sessionId === sessionId)) {
    if (Date.now() >= deadline) {
      await page.evaluate(() => (window as any).fixture.dispose()); await page.close(); await app.close();
      assert.fail('Browser runtime did not connect: ' + JSON.stringify(browserErrors));
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { app, page, async close() { await page.evaluate(() => (window as any).fixture.dispose()); await page.close(); await app.close(); } };
}
async function observe(page: Page) { return page.evaluate(() => (window as any).fixture.runtime.observe()); }
async function region(page: Page, ref: string) { return page.evaluate(ref => (window as any).fixture.runtime.observe({ detail: 'region', regionRef: ref }), ref); }

test('Element Plus 2.11.5 ordinary table reads 2 rendered rows out of 100 and reuses its adapter on a second page', async () => {
  const fixture = await mount('Vue');
  try {
    const overview = await observe(fixture.page);
    assert.equal(overview.nodes.filter((n: any) => n.kind === 'table').length, 1);
    const table = overview.nodes.find((n: any) => n.kind === 'table');
    const first = await region(fixture.page, table.ref);
    assert.equal(first.nodes.filter((n: any) => n.kind === 'row').length, 2);
    assert.ok(JSON.stringify(first).includes('¥1000.00'));
    assert.ok(!JSON.stringify(first).includes('100000'));
    assert.ok(!JSON.stringify(first).includes('HIDDEN-MODEL'));
    assert.equal(table.table.totalRows, undefined);
    assert.ok(!overview.nodes.some((n: any) => n.kind === 'dialog'));
    await fixture.page.evaluate(() => (window as any).fixture.second());
    await fixture.page.waitForFunction(() => document.querySelector('.el-table')?.getAttribute('aria-label') === 'Second business page');
    const second = await region(fixture.page, table.ref);
    assert.ok(JSON.stringify(second).includes('¥1000.02'));
    assert.ok(!JSON.stringify(second).includes('¥1000.00'));
    assert.equal(second.nodes.filter((n: any) => n.kind === 'row').length, 2);
  } finally { await fixture.close(); }
});

test('Element Plus form reads DOM drafts and presented errors inside an open Teleport dialog', async () => {
  const fixture = await mount('Vue');
  try {
    await fixture.page.evaluate(() => (window as any).fixture.open());
    await fixture.page.waitForFunction(() => { let e = document.querySelector('.el-dialog'); if (!e) return false; for (;e;e=e.parentElement) { const s=getComputedStyle(e);if(s.opacity!=='1'||s.display==='none'||s.visibility==='hidden')return false; } return true; });
    const overview = await observe(fixture.page);
    const dialog = overview.nodes.find((n: any) => n.kind === 'dialog');
    assert.ok(dialog, JSON.stringify(overview));
    assert.equal(dialog.name, 'Edit rendered order', await fixture.page.locator('.el-dialog').evaluate(e => e.parentElement!.outerHTML.slice(0,1800)));
    assert.equal(overview.activeDialogRef, dialog.ref);
    assert.equal(await fixture.page.evaluate(() => !document.getElementById('app')!.contains(document.querySelector('.el-dialog'))), true);
    const detail = await region(fixture.page, dialog.ref);
    assert.equal(detail.nodes.filter((n: any) => n.kind === 'form').length, 1);
    const field = detail.nodes.find((n: any) => n.kind === 'field');
    assert.equal(field.name, 'Address'); assert.equal(field.field.value, 'Unsaved address'); assert.equal(field.field.required, true);
    await fixture.page.addStyleTag({content:'.el-form-item.is-required .el-form-item__label::before {display:none!important}'});
    const hiddenMarker = await region(fixture.page,dialog.ref);
    assert.equal(hiddenMarker.nodes.find((n:any)=>n.kind==='field').field.required,undefined);
    await fixture.page.evaluate(() => { (document.querySelector('.el-input__inner') as HTMLInputElement).value = 'Direct DOM draft'; });
    const direct = await region(fixture.page, dialog.ref);
    assert.ok(direct.nodes.some((n: any) => n.kind === 'field' && n.field.value === 'Direct DOM draft'));
    await fixture.page.evaluate(() => (window as any).fixture.clear());
    await fixture.page.waitForFunction(() => { const e = document.querySelector('.el-form-item__error'); return e && getComputedStyle(e).opacity === '1'; });
    const error = await region(fixture.page, dialog.ref);
    const invalid = error.nodes.find((n: any) => n.kind === 'field');
    assert.deepEqual(invalid.messages, ['Please enter address']); assert.equal(invalid.state.invalid, true);
    await fixture.page.evaluate(() => (window as any).fixture.close());
    await fixture.page.waitForFunction(() => !document.querySelector('.el-dialog'));
    const closed = await observe(fixture.page);
    assert.ok(!closed.nodes.some((n: any) => n.kind === 'dialog' || n.kind === 'form'));
  } finally { await fixture.close(); }
});

test('React registers committed views only, ignores abandoned Suspense updates and unregisters on unmount', async () => {
  const fixture = await mount('React');
  try {
    const first = await observe(fixture.page); const form = first.nodes.find((n: any) => n.kind === 'form');
    assert.equal(form.name, 'Committed label');
    const detail = await region(fixture.page, form.ref);
    assert.ok(detail.nodes.some((n: any) => n.kind === 'field' && n.field.value === 'Unsaved DOM draft'));
    await fixture.page.evaluate(() => (window as any).fixture.update('Abandoned label'));
    await fixture.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const abandoned = await observe(fixture.page); assert.ok(!JSON.stringify(abandoned).includes('Abandoned label'));
    assert.equal(abandoned.nodes.find((n: any) => n.kind === 'form').name, 'Committed label');
    await fixture.page.evaluate(() => (window as any).fixture.update('Committed next'));
    await fixture.page.waitForFunction(() => document.querySelector('form')?.getAttribute('aria-label') === 'Committed next');
    assert.equal((await observe(fixture.page)).nodes.find((n: any) => n.kind === 'form').name, 'Committed next');
    await fixture.page.evaluate(() => (window as any).fixture.hide());
    await fixture.page.waitForFunction(() => !document.querySelector('form'));
    assert.ok(!(await observe(fixture.page)).nodes.some((n: any) => n.kind === 'form'));
    await assert.rejects(region(fixture.page, form.ref));
    await fixture.page.evaluate(() => (window as any).fixture.show());
    await fixture.page.waitForFunction(() => !!document.querySelector('form'));
    const remount = await observe(fixture.page); assert.notEqual(remount.nodes.find((n: any) => n.kind === 'form').ref, form.ref);
  } finally { await fixture.close(); }
});

test('P17: a DOM change during runtime preparation prevents the business callback', async () => {
  const fixture = await mount('React');
  try {
    const overview = await observe(fixture.page); const form = overview.nodes.find((n: any) => n.kind === 'form');
    const detail = await region(fixture.page, form.ref); const binding = detail.nodes.flatMap((n: any) => n.actions ?? [])[0];
    assert.equal(binding.callable, true);
    const operation = await fixture.page.evaluate(async ({ snapshotId, bindingRef }) => {
      const w = window as any;
      w.preparing = false;
      w.fixture.runtime.addBeforeExecuteHook(() => { w.preparing = true; return new Promise<void>(resolve => w.release = resolve); });
      return w.fixture.runtime.invoke('save', {}, 'Save the current draft', crypto.randomUUID(), { observation: { snapshotId, bindingRef } });
    }, { snapshotId: detail.snapshotId, bindingRef: binding.ref });
    await fixture.page.waitForFunction(() => (window as any).preparing);
    await fixture.page.evaluate(() => { (document.querySelector('input') as HTMLInputElement).value = 'Human changed draft'; (window as any).release(); });
    const deadline = Date.now() + 3000;
    while (!['failed','succeeded'].includes(fixture.app.broker.getOperation(operation.id).status)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    const final = fixture.app.broker.getOperation(operation.id);
    assert.equal(final.status, 'failed'); assert.equal(final.errorCode, 'CONTEXT_CHANGED'); assert.equal(final.effect, 'not_started');
    assert.equal(await fixture.page.evaluate(() => (window as any).fixture.callbacks), 0);
  } finally { await fixture.close(); }
});


test('unsupported Element Plus Table V2, date, cascader and select composites report partial coverage',async()=> {
  const fixture=await mount('Unsupported');
  try {
    const overview=await observe(fixture.page);
    assert.equal(overview.coverage.status,'partial');
    const table=overview.nodes.find((node:any)=>node.kind==='table');
    const tableDetail=await region(fixture.page,table.ref);
    assert.ok(tableDetail.nodes.some((node:any)=>node.kind==='unsupported'&&node.unsupported.reason==='element_plus_table_v2'));
    const form=overview.nodes.find((node:any)=>node.kind==='form');
    const formDetail=await region(fixture.page,form.ref);
    const reasons=formDetail.nodes.filter((node:any)=>node.kind==='unsupported').map((node:any)=>node.unsupported.reason);
    for(const reason of ['element_plus_date_picker','element_plus_cascader','element_plus_select']) assert.ok(reasons.includes(reason),JSON.stringify(reasons));
    assert.ok(!JSON.stringify(formDetail).includes('UNEXPANDED_CASCADER_OPTION'));
    assert.ok(!JSON.stringify(formDetail).includes('UNEXPANDED_SELECT_OPTION'));
  } finally {await fixture.close();}
});


test('native top-layer change rejects the now-background modal at Runtime before its callback',async()=> {
  const fixture=await mount('NativeModals');
  try {
    const first=await observe(fixture.page);
    assert.equal(first.nodes.find((node:any)=>node.ref===first.activeDialogRef).name,'Native A');
    const initialB=first.nodes.flatMap((node:any)=>node.actions??[]).find((action:any)=>action.argumentBindings.id==='b');
    assert.equal(initialB.callable,false);
    await fixture.page.evaluate(()=> (window as any).fixture.revealB());
    const visibleB=await observe(fixture.page);
    const binding=visibleB.nodes.flatMap((node:any)=>node.actions??[]).find((action:any)=>action.argumentBindings.id==='b');
    assert.equal(binding.callable,true);
    await fixture.page.evaluate(()=> (window as any).fixture.coverB());
    const operation=await fixture.page.evaluate(({snapshotId,bindingRef})=> (window as any).fixture.runtime.invoke('confirm',{id:'b'},'Confirm the observed B modal',crypto.randomUUID(),{observation:{snapshotId,bindingRef}}),{snapshotId:visibleB.snapshotId,bindingRef:binding.ref});
    const deadline=Date.now()+3000;
    while(!['failed','succeeded'].includes(fixture.app.broker.getOperation(operation.id).status)) {assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}
    const final=fixture.app.broker.getOperation(operation.id);
    assert.equal(final.status,'failed');assert.equal(final.errorCode,'CONTEXT_CHANGED');assert.equal(final.effect,'not_started');
    assert.deepEqual(await fixture.page.evaluate(()=> (window as any).fixture.callbacks),{a:0,b:0});
  } finally {await fixture.close();}
});
