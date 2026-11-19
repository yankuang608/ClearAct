import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { chromium, type Browser, type Page } from 'playwright';

let browser: Browser;
let bundle: string;
const fixture = fileURLToPath(new URL('./fixtures/page.html', import.meta.url));

before(async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'clearact-dom-test-'));
  try {
    await build({ entry: { browser: fileURLToPath(new URL('./browser-fixture.ts', import.meta.url)) }, bundle: true, format: ['iife'], globalName: 'ClearActDOM', platform: 'browser', outDir, silent: true, outExtension: () => ({ js: '.js' }) });
    bundle = await readFile(join(outDir, 'browser.js'), 'utf8');
  } finally { await rm(outDir, { recursive: true, force: true }); }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function pageWithFixture(): Promise<Page> {
  const page = await browser.newPage();
  const html = await readFile(fixture, 'utf8');
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://localhost/');
  await page.addScriptTag({ content: bundle + '\nglobalThis.__name = (fn) => fn;' });
  await page.evaluate(() => {
    const w = window as any;
    const references = new WeakMap<object, Map<string, string>>();
    w.refs = { ref(identity: object, kind: string, objectKey = '') {
      let byKind = references.get(identity);
      if (!byKind) { byKind = new Map(); references.set(identity, byKind); }
      const key = `${kind}:${objectKey}`;
      if (!byKind.has(key)) byKind.set(key, crypto.randomUUID());
      return byKind.get(key);
    } };
    w.adapter = w.ClearActDOM.createDOMPageAdapter({ document });
    w.views = [];
    w.bindings = [];
    w.capture = () => w.adapter.capture(w.views, w.bindings, w.refs, () => 'action-instance');
  });
  return page;
}

test('P01/P02/P03/P06: native fallback returns current presented rows and formatted cells only', async () => {
  const page = await pageWithFixture();
  try {
    const capture = await page.evaluate(() => (window as any).capture());
    const text = JSON.stringify(capture);
    assert.equal(capture.nodes.filter((n: any) => n.kind === 'row').length, 2);
    assert.ok(text.includes('¥ 2,400.00'), JSON.stringify(capture.nodes.filter((n: any) => n.kind === 'cell')));
    for (const secret of ['RAW_PRIVATE_', 'CLOSED_DETAIL_SECRET', 'HIDDEN_PANEL_SECRET', 'DISPLAY_NONE_SECRET', 'CLOSED_DIALOG_SECRET', 'Invisible candidate', 'CANVAS_FALLBACK_SECRET', 'OBSERVER_TECHNICAL_SECRET']) assert.ok(!text.includes(secret), secret);
    const table = capture.nodes.find((n: any) => n.kind === 'table');
    assert.equal(table.table.renderedRows, 2);
    assert.equal(table.table.totalRows, undefined);
    assert.equal(table.table.columns.length, 4);
    await page.evaluate(() => { document.querySelector('details')!.open = true; });
    assert.ok((await page.evaluate(() => JSON.stringify((window as any).capture()))).includes('CLOSED_DETAIL_SECRET'));
  } finally { await page.close(); }
});

test('P08/P09/P10/P11: reads live control drafts without validation and redacts passwords', async () => {
  const page = await pageWithFixture();
  try {
    await page.evaluate(() => {
      (document.querySelector('#address') as HTMLInputElement).value = 'unsaved direct draft';
      (document.querySelector('textarea') as HTMLTextAreaElement).value = 'new note';
      (document.querySelector('#check') as HTMLInputElement).checked = false;
      (window as any).validations = 0;
      HTMLFormElement.prototype.checkValidity = () => { (window as any).validations++; return false; };
      HTMLFormElement.prototype.reportValidity = () => { (window as any).validations++; return false; };
    });
    const capture = await page.evaluate(() => (window as any).capture());
    assert.ok(capture.nodes.some((n: any) => n.kind === 'field' && n.field.value === 'unsaved direct draft'));
    assert.ok(capture.nodes.some((n: any) => n.kind === 'field' && n.field.value === 'new note'));
    assert.ok(capture.nodes.some((n: any) => n.kind === 'field' && n.field.controlType === 'checkbox' && n.field.value === false));
    const password = capture.nodes.find((n: any) => n.kind === 'field' && n.field.controlType === 'password');
    assert.equal(password.field.redacted, true);
    assert.equal(password.field.value, undefined);
    assert.ok(!JSON.stringify(capture).includes('TOP_SECRET_PASSWORD'));
    assert.ok(!JSON.stringify(capture).includes('Address is required'));
    assert.equal(await page.evaluate(() => (window as any).validations), 0);
  } finally { await page.close(); }
});

test('P14: explicit native reader takes ownership over fallback and preserves portal owner', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      const w = window as any;
      w.views = [{ key: 'orders', kind: 'table', root: () => document.querySelector('#orders'), read: (r: any) => r.table(document.querySelector('#orders')) }, { key: 'draft', kind: 'form', root: () => document.querySelector('#draft'), ownerKey: 'orders', read: (r: any) => r.form(document.querySelector('#draft')) }];
      return w.capture();
    });
    assert.equal(result.nodes.filter((n: any) => n.kind === 'table').length, 1);
    assert.equal(result.nodes.filter((n: any) => n.kind === 'form').length, 1);
    const table = result.nodes.find((n: any) => n.kind === 'table');
    const form = result.nodes.find((n: any) => n.kind === 'form');
    assert.ok(table.children.includes(form.ref));
  } finally { await page.close(); }
});

test('P13: custom readers reject fabricated facts, Promises, stale facts, DOM writes and network', async () => {
  const page = await pageWithFixture();
  try {
    const errors = await page.evaluate(() => {
      const w = window as any;
      const root = document.querySelector('#orders');
      const sample = (read: any) => {
        w.views = [{key:'custom',kind:'table',root:()=>root,read}];
        try { w.capture(); return 'accepted'; } catch (error) { return (error as any).code; }
      };
      let oldFact: any;
      sample((r: any) => { oldFact = r.text(root); return r.table(root); });
      return [
        sample(() => ({element:root,kind:'table',name:{value:'fabricated'}})),
        sample(async (r: any) => r.table(root)),
        sample(() => ({element:root,kind:'table',name:oldFact})),
        sample((r: any) => { root!.setAttribute('data-mutated','yes'); return r.table(root); }),
        sample((r: any) => { fetch('/must-not-request').catch(()=>{}); return r.table(root); }),
      ];
    });
    assert.deepEqual(errors, Array(5).fill('ADAPTER_CONTRACT_VIOLATION'));
    assert.equal(await page.evaluate(() => document.querySelector('#orders')!.hasAttribute('data-mutated')), true);
  } finally { await page.close(); }
});

test('P15: canvas, iframe and unknown custom controls report unsupported coverage', async () => {
  const page = await pageWithFixture();
  try {
    const capture = await page.evaluate(() => (window as any).capture());
    assert.equal(capture.coverage.status, 'partial');
    const kinds = capture.nodes.filter((n: any) => n.kind === 'unsupported').map((n: any) => n.unsupported.reason);
    assert.ok(kinds.some((reason: string) => reason.includes('canvas')));
    assert.ok(kinds.some((reason: string) => reason.includes('iframe')));
    assert.ok(kinds.some((reason: string) => reason.includes('custom')));
  } finally { await page.close(); }
});

test('clipped text is omitted unless the current accessibility semantics provide its full text', async () => {
  const page = await pageWithFixture();
  try {
    const capture = await page.evaluate(() => (window as any).capture());
    assert.ok(!JSON.stringify(capture).includes('CLIPPED_HIDDEN_TAIL_SENTINEL'));
    assert.ok(capture.nodes.some((n: any) => n.source === 'accessible' && (n.text === 'Full accessible description' || n.name === 'Full accessible description')));
    assert.ok(capture.nodes.some((n: any) => n.truncation?.reason === 'clipped_text'));
  } finally { await page.close(); }
});

test('P07/P16/P19: row guards include row, table conditions, selection and related view, not unrelated rows', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      const w = window as any;
      const table = document.querySelector('#orders');
      const row = table!.querySelector('tbody tr');
      w.views = [{key:'orders',kind:'table',root:()=>table},{key:'filters',kind:'region',root:()=>document.querySelector('#filters')}];
      w.bindings = [{key:'edit',viewKey:'orders',action:'edit',target:()=>row,trigger:()=>row!.querySelector('button'),objectKey:()=>row!.getAttribute('data-id'),argumentBindings:()=>({id:row!.getAttribute('data-id')}),guard:{scope:'row',relatedViews:['filters']}}];
      const first = w.capture();
      row!.setAttribute('data-id','NEW');
      const second = w.capture();
      return {first,second};
    });
    const first = result.first.bindings[0];
    const byRef = new Map(result.first.nodes.map((n: any) => [n.ref,n]));
    assert.equal(first.binding.enabled, true);
    assert.ok(first.guardRefs.some((ref: string) => (byRef.get(ref) as any).kind === 'table'));
    assert.ok(first.guardRefs.some((ref: string) => (byRef.get(ref) as any).name === 'Filters'));
    assert.equal(first.guardRefs.filter((ref: string) => (byRef.get(ref) as any).kind === 'row').length, 1);
    assert.notEqual(first.binding.targetRef, result.second.bindings[0].binding.targetRef);
    assert.notEqual(first.binding.ref, result.second.bindings[0].binding.ref);
    assert.notEqual(first.targetIdentity, result.second.bindings[0].targetIdentity);
  } finally { await page.close(); }
});

test('P12: top modal blocks background bindings and trigger resolution uses actual button', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      const w = window as any;
      const table = document.querySelector('#orders');
      const row = table!.querySelector('tbody tr');
      const button = row!.querySelector('button');
      const outer = document.createElement('dialog'); outer.innerHTML = '<h2>Outer</h2><button>Continue</button>'; document.body.append(outer); outer.showModal();
      const inner = document.createElement('dialog'); inner.innerHTML = '<h2>Inner</h2><button>Confirm</button>'; outer.append(inner); inner.showModal();
      w.views = [{key:'orders',kind:'table',root:()=>table},{key:'outer',kind:'dialog',root:()=>outer},{key:'inner',kind:'dialog',root:()=>inner,ownerKey:'outer'}];
      w.bindings = [{key:'edit',viewKey:'orders',action:'edit',target:()=>row,trigger:()=>button,objectKey:()=>row!.getAttribute('data-id'),guard:{scope:'row'}}];
      const capture = w.capture();
      const resolvesButton = w.adapter.resolveTrigger(w.bindings[0]) === button;
      inner.close();
      const closed = w.capture();
      inner.showModal();
      const reopened = w.capture();
      return {capture,closed,reopened,resolvesButton};
    });
    const active = result.capture.nodes.find((n: any) => n.ref === result.capture.activeDialogRef);
    assert.equal(active.name, 'Inner');
    assert.equal(result.capture.bindings[0].binding.enabled, false);
    assert.equal(result.resolvesButton, true);
    assert.ok(!result.closed.nodes.some((n: any) => n.name === 'Inner'));
    assert.notEqual(result.capture.activeDialogRef, result.reopened.activeDialogRef);
  } finally { await page.close(); }
});

test('P16/P18: form submit guards cannot narrow away another live form field', async () => {
  const page = await pageWithFixture();
  try {
    const capture = await page.evaluate(() => {
      const w = window as any; const form = document.querySelector('#draft'); const submit = document.querySelector('#submit');
      w.views = [{key:'form',kind:'form',root:()=>form}];
      w.bindings = [{key:'submit',viewKey:'form',action:'save',target:()=>submit,trigger:()=>submit,objectKey:()=> 'save',guard:{scope:'target'}}];
      return w.capture();
    });
    const binding = capture.bindings[0];
    const fields = capture.nodes.filter((n: any) => n.kind === 'field' && ['Address', 'Password', 'Selected', 'Notes'].includes(n.name));
    assert.equal(fields.length, 4);
    assert.ok(fields.every((n: any) => binding.guardRefs.includes(n.ref)));
    assert.ok(capture.nodes.some((n: any) => n.kind === 'form' && binding.guardRefs.includes(n.ref)));
  } finally { await page.close(); }
});

test('explicit adapter owner conflicts fail and fallback can be disabled', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      const w = window as any; const root = document.querySelector('#orders');
      const fallbackOff = w.ClearActDOM.createDOMPageAdapter({document,fallback:false}).capture([],[],w.refs,()=> 'action');
      w.views = [{key:'one',kind:'table',root:()=>root},{key:'two',kind:'table',root:()=>root}];
      let error: string|undefined;
      try { w.capture(); } catch (err) { error = (err as any).code; }
      return {fallbackOff,error};
    });
    assert.equal(result.fallbackOff.nodes.length, 1);
    assert.equal(result.error, 'ADAPTER_CONTRACT_VIOLATION');
  } finally { await page.close(); }
});


test('contenteditable and keyboard interactive custom spans expose their currently presented text', async () => {
  const page = await pageWithFixture();
  try {
    const capture = await page.evaluate(() => {
      const root = document.createElement('section');
      root.innerHTML = '<div contenteditable="true" aria-label="Comment">Draft <b>comment</b></div><span tabindex="0" aria-label="October 19, 2026">19</span>';
      document.body.append(root);
      return (window as any).capture();
    });
    assert.ok(capture.nodes.some((n: any) => n.kind === 'control' && n.control.controlType === 'contenteditable' && n.control.value === 'Draft comment'));
    assert.ok(capture.nodes.some((n: any) => n.kind === 'control' && n.name === 'October 19, 2026'));
  } finally { await page.close(); }
});

test('caught network attempts and direct control writes still fail the synchronous read contract', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      const w = window as any; const root = document.querySelector('#draft');
      const read = (attempt: any) => {
        w.views = [{key:'form',kind:'form',root:()=>root,read:(r: any)=> { attempt(); return r.form(root); }}];
        try { w.capture(); return 'accepted'; } catch (err) { return (err as any).code; }
      };
      return [read(()=> { try { fetch('/should-not-run'); } catch {} }), read(()=> { (document.querySelector('#address') as HTMLInputElement).value = 'reader write'; })];
    });
    assert.deepEqual(result, ['ADAPTER_CONTRACT_VIOLATION','ADAPTER_CONTRACT_VIOLATION']);
  } finally { await page.close(); }
});


test('body view precedence and actual Core guard evidence survive unrelated updates but reject selected row changes', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      const w = window as any;
      const core = new w.ClearActDOM.PagePerception('real-dom', ()=>'action');
      core.setAdapter(w.ClearActDOM.createDOMPageAdapter({document}));
      core.registerView({key:'body',kind:'region',root:()=>document.body});
      const first = core.observe();
      const root = document.querySelector('#orders'); const row = root!.querySelector('tbody tr');
      core.registerView({key:'orders',kind:'table',root:()=>root,ownerKey:'body'});
      core.registerView({key:'filters',kind:'region',root:()=>document.querySelector('#filters'),ownerKey:'body'});
      core.registerActionBinding({key:'edit',viewKey:'orders',action:'edit',target:()=>row,trigger:()=>row!.querySelector('button'),objectKey:()=>row!.getAttribute('data-id'),argumentBindings:()=>({id:row!.getAttribute('data-id')}),guard:{scope:'row',relatedViews:['filters']}});
      const overview = core.observe();
      const bodyRef = overview.snapshot.nodes.find((n:any)=>n.name === 'Filters').ref;
      const pageRef = overview.snapshot.nodes.find((n:any)=>n.kind==='page').ref;
      const detail = core.observe({detail:'region',regionRef:pageRef});
      const evidence = {documentId:detail.evidence.documentId,snapshotId:detail.evidence.snapshotId,binding:detail.evidence.bindings[0]};
      let callbacks = 0;
      const invoke = ()=> { try {core.validate(evidence,'edit',{id:'1048'});callbacks++;return 'ran';} catch(err) {return (err as any).code;} };
      document.querySelector('#toast p')!.textContent = 'Unrelated new toast';
      root!.querySelectorAll('tbody tr')[1].querySelector('td')!.textContent = 'unrelated row updated';
      const unrelated = invoke();
      row!.setAttribute('aria-selected','false');
      const changed = invoke();
      return {firstRows:first.snapshot.nodes.filter((n:any)=>n.kind==='table').length,unrelated,changed,callbacks,evidenceCount:detail.evidence.bindings.length,bodyRef};
    });
    assert.equal(result.firstRows,1);
    assert.equal(result.evidenceCount,1);
    assert.equal(result.unrelated,'ran');
    assert.equal(result.changed,'CONTEXT_CHANGED');
    assert.equal(result.callbacks,1);
  } finally { await page.close(); }
});

test('P04/P05: actual DOM protocol pagination stays local and rejects a changed region cursor', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      const w = window as any; const root=document.querySelector('#orders')!; const tbody=root.querySelector('tbody')!;
      tbody.innerHTML=Array.from({length:300},(_,index)=>`<tr><td>${index}</td><td>Rendered</td></tr>`).join('');
      let pageChanges=0; root.addEventListener('click',()=>pageChanges++);
      const core=new w.ClearActDOM.PagePerception('large-dom',()=> 'action');core.setAdapter(w.ClearActDOM.createDOMPageAdapter({document,fallback:false}));
      core.registerView({key:'orders',kind:'table',root:()=>root});
      const overview=core.observe();const tableRef=overview.snapshot.nodes.find((n:any)=>n.kind==='table').ref;
      const first=core.observe({detail:'region',regionRef:tableRef,limit:25});
      const next=core.observe({detail:'region',regionRef:tableRef,limit:25,cursor:first.snapshot.coverage.nextCursor});
      tbody.querySelector('td')!.textContent='Changed filter result';
      let error;try {core.observe({detail:'region',regionRef:tableRef,limit:25,cursor:next.snapshot.coverage.nextCursor});} catch(err) {error=(err as any).code;}
      return {first:first.snapshot,next:next.snapshot,error,pageChanges};
    });
    assert.equal(result.first.coverage.truncated,true);assert.ok(result.first.coverage.nextCursor);
    assert.equal(result.first.nodes.length,25);assert.equal(result.next.nodes.length,25);
    assert.equal(result.error,'STALE_CURSOR');assert.equal(result.pageChanges,0);
  } finally { await page.close(); }
});


test('focusable main and region containers preserve their rendered form, table and link descendants', async () => {
  const page=await pageWithFixture();
  try {
    const capture=await page.evaluate(()=> { document.querySelector('main')!.setAttribute('tabindex','-1');return (window as any).capture(); });
    assert.equal(capture.nodes.filter((n:any)=>n.kind==='table').length,1);
    assert.equal(capture.nodes.filter((n:any)=>n.kind==='form').length,1);
    assert.ok(capture.nodes.some((n:any)=>n.kind==='field'&&n.name==='Address'));
  } finally { await page.close(); }
});

test('a native field target includes all current parent form controls in Core guard evidence', async () => {
  const page=await pageWithFixture();
  try {
    const result=await page.evaluate(()=> {
      const w=window as any;const core=new w.ClearActDOM.PagePerception('field-guard',()=> 'action');
      core.setAdapter(w.ClearActDOM.createDOMPageAdapter({document,fallback:false}));
      const form=document.querySelector('#draft'),field=document.querySelector('#address');
      core.registerView({key:'form',kind:'form',root:()=>form});
      core.registerActionBinding({key:'fill',viewKey:'form',action:'fill',target:()=>field,trigger:()=>field,objectKey:()=> 'address',guard:{scope:'target'}});
      const overview=core.observe();const formRef=overview.snapshot.nodes.find((n:any)=>n.kind==='form').ref;
      const detail=core.observe({detail:'region',regionRef:formRef});return {bindings:detail.evidence.bindings.length,callable:detail.snapshot.nodes.flatMap((n:any)=>n.actions??[])[0].callable};
    });
    assert.deepEqual(result,{bindings:1,callable:true});
  } finally { await page.close(); }
});

test('a button in a teleported dialog keeps every dialog descendant in its outer form guard', async () => {
  const page = await pageWithFixture();
  try {
    const result = await page.evaluate(() => {
      document.body.innerHTML = '<div id="task-form"><textarea aria-label="Task draft">Current draft</textarea><button id="add" type="button">Add task</button></div><dialog aria-label="Task syntax help"><button id="close" type="button">Close help</button><section><p>Sibling help content</p><h3>Supported dates</h3><ul><li>Tomorrow</li></ul></section></dialog>';
      const w = window as any, form = document.querySelector('#task-form'), dialog = document.querySelector('dialog') as HTMLDialogElement;
      const close = document.querySelector('#close'), add = document.querySelector('#add');
      const core = new w.ClearActDOM.PagePerception('portal-help', () => 'action-instance');
      core.setAdapter(w.ClearActDOM.createDOMPageAdapter({document}));
      core.registerView({key:'form',kind:'form',root:()=>form});
      core.registerView({key:'help',kind:'dialog',ownerKey:'form',root:()=>dialog.open ? dialog : null});
      core.registerView({key:'close',kind:'region',ownerKey:'help',root:()=>dialog.open ? close : null});
      core.registerActionBinding({key:'add',viewKey:'form',action:'add',target:()=>form,trigger:()=>add,objectKey:()=> 'task',guard:{scope:'target'}});
      core.registerActionBinding({key:'close',viewKey:'close',action:'close',target:()=>close,trigger:()=>close,objectKey:()=> 'help-close',guard:{scope:'target'}});
      const before = core.observe({limit:500});
      dialog.showModal();
      const after = core.observe({detail:'region',regionRef:before.snapshot.scope.ref,limit:500});
      const binding = after.evidence.bindings.find((entry: any) => entry.action === 'close');
      return {beforeDialog:before.snapshot.activeDialogRef,snapshot:after.snapshot,guard:binding?.guardRefs};
    });
    assert.equal(result.beforeDialog, null);
    assert.ok(result.guard, 'the close action remains observable and callable after opening help');
    const bindings = result.snapshot.nodes.flatMap((node: any) => node.actions ?? []);
    const close = bindings.find((binding: any) => binding.action === 'close');
    const add = bindings.find((binding: any) => binding.action === 'add');
    assert.equal(close.enabled, true); assert.equal(close.callable, true);
    assert.equal(add.enabled, false); assert.equal(add.callable, false);
    const guarded = result.snapshot.nodes.filter((node: any) => result.guard.includes(node.ref));
    assert.ok(guarded.some((node: any) => node.kind === 'field' && node.field.value === 'Current draft'));
    for (const text of ['Sibling help content', 'Supported dates', 'Tomorrow']) {
      assert.ok(guarded.some((node: any) => node.kind === 'text' && node.text === text), text);
    }
  } finally { await page.close(); }
});

test('native sibling modals follow current top-layer hit testing on first sample and after reopen', async () => {
  const page=await pageWithFixture();
  try {
    const result=await page.evaluate(()=> {
      const w=window as any;
      document.body.innerHTML='<dialog id="a" aria-label="Dialog A"><button>A action</button></dialog><dialog id="b" aria-label="Dialog B"><button>B action</button></dialog>';
      const a=document.querySelector('#a') as HTMLDialogElement,b=document.querySelector('#b') as HTMLDialogElement;
      b.showModal();a.showModal();
      w.views=[{key:'a',kind:'dialog',root:()=>a},{key:'b',kind:'dialog',root:()=>b}];
      w.bindings=[a,b].map((dialog,index)=>({key:'confirm',viewKey:index?'b':'a',action:'confirm',target:()=>dialog,trigger:()=>dialog.querySelector('button'),objectKey:()=>dialog.id,guard:{scope:'target'}}));
      const sample=()=> {const capture=w.capture();const hit=document.elementFromPoint(innerWidth/2,innerHeight/2);return {capture,hit:hit?.closest('dialog:modal')?.getAttribute('aria-label'),owners:Object.fromEntries([a,b].map(dialog=>[dialog.getAttribute('aria-label'),dialog.closest('dialog:modal')?.getAttribute('aria-label')]))};};
      const first=sample();
      b.close();b.showModal();
      const reopened=sample();
      a.append(b);a.close();a.showModal();
      const nestedReopened=sample();
      return {first,reopened,nestedReopened};
    });
    for(const [sample,label] of [[result.first,'Dialog A'],[result.reopened,'Dialog B'],[result.nestedReopened,result.nestedReopened.hit]] as const) {
      assert.equal(sample.hit,label);
      const active=sample.capture.nodes.find((node:any)=>node.ref===sample.capture.activeDialogRef);
      assert.equal(active.name,label);
      for(const binding of sample.capture.bindings) {
        const target=sample.capture.nodes.find((node:any)=>node.ref===binding.binding.targetRef);
        assert.equal(binding.binding.callable,sample.owners[target.name]===label);
      }
    }
  } finally {await page.close();}
});

test('nested custom controls and graphics remain unsupported inside text containers and table cells', async () => {
  const page=await pageWithFixture();
  try {
    const capture=await page.evaluate(()=> {
      document.body.innerHTML='<p>Chart <x-chart>PRIVATE_CHART_FALLBACK</x-chart></p><p>Logo <svg width="20" height="20"><rect width="20" height="20" /></svg></p><table><tbody><tr><td>Value <x-money>PRIVATE_MONEY_FALLBACK</x-money></td></tr></tbody></table>';
      return (window as any).capture();
    });
    assert.equal(capture.coverage.status,'partial');
    assert.equal(capture.nodes.filter((node:any)=>node.kind==='unsupported').length,3);
    assert.ok(!JSON.stringify(capture).includes('PRIVATE_CHART_FALLBACK'));
    assert.ok(!JSON.stringify(capture).includes('PRIVATE_MONEY_FALLBACK'));
    assert.ok(capture.nodes.some((node:any)=>node.kind==='text'&&node.text==='Chart'));
  } finally {await page.close();}
});

test('a portal footer owned by a form binds its actual submit trigger and includes the complete logical form guard', async () => {
  const page=await pageWithFixture();
  try {
    const result=await page.evaluate(()=> {
      const w=window as any;
      document.body.innerHTML='<form id="form" aria-label="Draft form"><label>Name<input value="Current draft"></label></form><div id="footer"><button>Save draft</button></div><form id="other" aria-label="Other form"><input aria-label="Other" value="Unrelated"></form>';
      const form=document.querySelector('#form'),footer=document.querySelector('#footer'),button=footer!.querySelector('button'),other=document.querySelector('#other');
      w.views=[{key:'form',kind:'form',root:()=>form},{key:'footer',kind:'region',root:()=>footer,ownerKey:'form'},{key:'other',kind:'form',root:()=>other}];
      const binding={key:'save',viewKey:'form',action:'save',target:()=>form,trigger:()=>button,objectKey:()=> 'draft',guard:{scope:'form'}};
      w.bindings=[binding];const owned=w.capture();const resolved=w.adapter.resolveTrigger(binding)===button;
      w.views[1]={...w.views[1],ownerKey:'other'};const crossOwner=w.capture();const crossResolved=w.adapter.resolveTrigger(binding);
      return {owned,resolved,crossOwner,crossResolved};
    });
    assert.equal(result.owned.bindings.length,1);
    assert.equal(result.owned.bindings[0].binding.label,'Save draft');
    assert.equal(result.owned.bindings[0].binding.callable,true);
    const byRef=new Map(result.owned.nodes.map((node:any)=>[node.ref,node]));
    const guard=result.owned.bindings[0].guardRefs.map((ref:string)=>byRef.get(ref) as any);
    assert.ok(guard.some((node:any)=>node.kind==='field'&&node.field.value==='Current draft'));
    assert.ok(guard.some((node:any)=>node.kind==='control'&&node.name==='Save draft'));
    assert.ok(!guard.some((node:any)=>node.kind==='field'&&node.field.value==='Unrelated'));
    assert.equal(result.resolved,true);
    assert.equal(result.crossOwner.bindings.length,0);
    assert.equal(result.crossResolved,null);
  } finally {await page.close();}
});


test('a row containing an unsupported custom slot cannot mint callable Core evidence',async()=> {
  const page=await pageWithFixture();
  try {
    const result=await page.evaluate(()=> {
      const w=window as any;
      document.body.innerHTML='<table><tbody><tr><td><label>Chart <x-chart>PRIVATE_SLOT_DATA</x-chart></label></td><td><button>Edit</button></td></tr></tbody></table>';
      const table=document.querySelector('table'),row=table!.querySelector('tr');
      const core=new w.ClearActDOM.PagePerception('unsupported-guard',()=> 'action');
      core.setAdapter(w.ClearActDOM.createDOMPageAdapter({document,fallback:false}));
      core.registerView({key:'table',kind:'table',root:()=>table});
      core.registerActionBinding({key:'edit',viewKey:'table',action:'edit',target:()=>row,trigger:()=>row!.querySelector('button'),objectKey:()=> 'row',guard:{scope:'row'}});
      const overview=core.observe();const ref=overview.snapshot.nodes.find((node:any)=>node.kind==='table').ref;
      const detail=core.observe({detail:'region',regionRef:ref});return {snapshot:detail.snapshot,evidence:detail.evidence};
    });
    const binding=result.snapshot.nodes.flatMap((node:any)=>node.actions??[])[0];
    assert.equal(result.snapshot.coverage.status,'partial');assert.equal(binding.enabled,true);assert.equal(binding.callable,false);
    assert.equal(binding.unavailableReason,'observation_incomplete');assert.equal(result.evidence.bindings.length,0);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SLOT_DATA'));
  } finally {await page.close();}
});

test('CSS sibling modal wrappers use current hit testing rather than DOM discovery order',async()=> {
  const page=await pageWithFixture();
  try {
    const result=await page.evaluate(()=> {
      const w=window as any;
      document.body.innerHTML='<section id="css-a" role="dialog" aria-modal="true" aria-label="CSS A" style="position:fixed;inset:10px;z-index:200;background:white"><button>A</button></section><section id="css-b" role="dialog" aria-modal="true" aria-label="CSS B" style="position:fixed;inset:10px;z-index:100;background:white"><button>B</button></section>';
      const a=document.querySelector('#css-a'),b=document.querySelector('#css-b');
      w.views=[{key:'a',kind:'dialog',root:()=>a},{key:'b',kind:'dialog',root:()=>b}];
      w.bindings=[a,b].map((dialog,index)=>({key:'confirm',viewKey:index?'b':'a',action:'confirm',target:()=>dialog,trigger:()=>dialog!.querySelector('button'),objectKey:()=>dialog!.id,guard:{scope:'target'}}));
      const capture=w.capture();return {capture,hit:document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('[role="dialog"]')?.getAttribute('aria-label')};
    });
    assert.equal(result.hit,'CSS A');
    assert.equal(result.capture.nodes.find((node:any)=>node.ref===result.capture.activeDialogRef).name,'CSS A');
    for(const entry of result.capture.bindings) assert.equal(entry.binding.callable,entry.binding.label==='A');
  } finally {await page.close();}
});

test('logical Portal ownership cannot make content outside a native top layer available',async()=> {
  const page=await pageWithFixture();
  try {
    const capture=await page.evaluate(()=> {
      const w=window as any;
      document.body.innerHTML='<dialog aria-label="Native owner"><button>Native action</button></dialog><section role="dialog" aria-modal="true" aria-label="Outside portal" style="position:fixed;inset:10px;z-index:999999;background:white"><button>Portal action</button></section>';
      const a=document.querySelector('dialog') as HTMLDialogElement,p=document.querySelector('section');a.showModal();
      w.views=[{key:'native',kind:'dialog',root:()=>a},{key:'portal',kind:'dialog',root:()=>p,ownerKey:'native'}];
      w.bindings=[{key:'native',viewKey:'native',action:'confirm',target:()=>a,trigger:()=>a.querySelector('button'),objectKey:()=> 'native',guard:{scope:'target'}},{key:'portal',viewKey:'portal',action:'confirm',target:()=>p,trigger:()=>p!.querySelector('button'),objectKey:()=> 'portal',guard:{scope:'target'}}];
      return w.capture();
    });
    assert.equal(capture.nodes.find((node:any)=>node.ref===capture.activeDialogRef).name,'Native owner');
    assert.equal(capture.bindings.find((entry:any)=>entry.binding.label==='Portal action').binding.callable,false);
  } finally {await page.close();}
});

test('independent disjoint modal wrappers with no provable top layer fail closed',async()=> {
  const page=await pageWithFixture();
  try {
    const error=await page.evaluate(()=> {
      const w=window as any;
      document.body.innerHTML='<div role="dialog" aria-modal="true" style="position:fixed;left:10px;top:10px;width:100px;height:100px">A</div><div role="dialog" aria-modal="true" style="position:fixed;right:10px;bottom:10px;width:100px;height:100px">B</div>';
      try {w.capture();return 'accepted';}catch(error){return (error as any).code;}
    });
    assert.equal(error,'PAGE_NOT_READY');
  } finally {await page.close();}
});


test('accessible labels exclude embedded unpresented options and textarea default business values', async () => {
  const page = await pageWithFixture();
  try {
    await page.evaluate(() => {
      document.body.innerHTML = `<label>Choice<select id="choice"><option selected>Visible choice</option><option>UNPRESENTED_OPTION_SECRET</option></select><span hidden>HIDDEN_LABEL_SECRET</span></label>
        <label>Notes<textarea id="notes">STALE_TEXTAREA_DEFAULT_SECRET</textarea></label>
        <div id="explicit" hidden>Explicit reference<select><option>REFERENCED_OPTION_SECRET</option></select></div><input id="named" aria-labelledby="explicit">`;
      (document.querySelector('#notes') as HTMLTextAreaElement).value = 'current presented draft';
    });
    const capture = await page.evaluate(() => (window as any).capture());
    assert.ok(capture.nodes.some((node: any) => node.kind === 'field' && node.name === 'Choice' && node.field.value === 'Visible choice'));
    assert.ok(capture.nodes.some((node: any) => node.kind === 'field' && node.name === 'Notes' && node.field.value === 'current presented draft'));
    assert.ok(capture.nodes.some((node: any) => node.kind === 'field' && node.name === 'Explicit reference'));
    for (const value of ['UNPRESENTED_OPTION_SECRET', 'HIDDEN_LABEL_SECRET', 'STALE_TEXTAREA_DEFAULT_SECRET', 'REFERENCED_OPTION_SECRET']) assert.ok(!JSON.stringify(capture).includes(value), value);
  } finally { await page.close(); }
});

test('disabled accessible descriptions exclude nested control defaults, options and scripts', async () => {
 const page = await pageWithFixture();
 try {
  const capture = await page.evaluate(() => {
   const w = window as any;
   document.body.innerHTML = '<div id="reason" hidden>Approval required<textarea>OLD_DRAFT_SECRET</textarea><select><option>OPTION_SECRET</option></select><script type="application/json">SCRIPT_SECRET</script></div><button disabled aria-describedby="reason">Submit</button>';
   const button = document.querySelector('button');
   w.views = [{key:'body',kind:'region',root:()=>document.body}];
   w.bindings = [{key:'submit',viewKey:'body',action:'save',target:()=>button,trigger:()=>button,objectKey:()=> 'submit',guard:{scope:'target'}}];
   return w.capture();
  });
  assert.equal(capture.bindings[0].binding.disabledReason, 'Approval required');
  assert.doesNotMatch(JSON.stringify(capture), /OLD_DRAFT_SECRET|OPTION_SECRET|SCRIPT_SECRET/);
 } finally {await page.close();}
});

test('explicit ARIA table readers retain presented div rows, cells and row controls', async () => {
 const page = await pageWithFixture();
 try {
  const capture = await page.evaluate(() => {
   const w = window as any;
   document.body.innerHTML = '<div role="table"><div role="row"><div role="columnheader">Invoice</div></div><div role="row"><div role="cell">INV-204<button>Review invoice</button></div></div><div role="row" hidden><div role="cell">HIDDEN_ROW_SECRET</div></div></div>';
   const root = document.querySelector('[role="table"]');
   w.views = [{key:'table',kind:'table',root:()=>root,read:(reader:any)=>reader.table(root,{headers:'[role="columnheader"]',rows:'[role="row"]',cells:':scope > [role="cell"],:scope > [role="gridcell"]'})}];
   return w.capture();
  });
  assert.equal(capture.nodes.find((node:any)=>node.kind==='table').table.renderedRows, 1);
  assert.ok(capture.nodes.some((node:any)=>node.kind==='cell' && node.text.includes('INV-204') && node.text.includes('Review invoice')));
  assert.ok(capture.nodes.some((node:any)=>node.name==='Review invoice'));
  assert.doesNotMatch(JSON.stringify(capture), /HIDDEN_ROW_SECRET/);
 } finally {await page.close();}
});

for (const attribute of ['type="password"','data-clearact-private']) test(`changed ${attribute} drafts reject old submit without disclosing values`, async () => {
 const page = await pageWithFixture();
 try {
  const result = await page.evaluate(attribute => {
   const w = window as any;
   document.body.innerHTML = `<form><label>Private draft<input ${attribute} value="PRIVATE_INITIAL_SECRET"></label><button>Submit</button></form>`;
   const core = new w.ClearActDOM.PagePerception('private-guard', ()=>'save-instance');
   core.setAdapter(w.ClearActDOM.createDOMPageAdapter({document}));
   const button=document.querySelector('button');
   core.registerView({key:'body',kind:'region',root:()=>document.body});
   core.registerActionBinding({key:'save',viewKey:'body',action:'save',target:()=>button,trigger:()=>button,objectKey:()=> 'save',guard:{scope:'form'}});
   const directory=core.observe(), detail=core.observe({detail:'region',regionRef:directory.snapshot.scope.ref});
   const evidence={documentId:detail.evidence.documentId,snapshotId:detail.evidence.snapshotId,binding:detail.evidence.bindings[0]};
   (document.querySelector('input') as HTMLInputElement).value='PRIVATE_CHANGED_SECRET';
   let callbacks=0, code='';
   try {core.validate(evidence,'save',{});callbacks++;}catch(error){code=(error as any).code;}
   const fresh=core.observe({detail:'region',regionRef:directory.snapshot.scope.ref});
   core.validate({documentId:fresh.evidence.documentId,snapshotId:fresh.evidence.snapshotId,binding:fresh.evidence.bindings[0]},'save',{});
   return {code,callbacks,serialized:JSON.stringify({detail,fresh})};
  }, attribute);
  assert.equal(result.code,'CONTEXT_CHANGED');
  assert.equal(result.callbacks,0);
  assert.doesNotMatch(result.serialized,/PRIVATE_INITIAL_SECRET|PRIVATE_CHANGED_SECRET/);
 } finally {await page.close();}
});
