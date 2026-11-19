import {after, before, test} from "node:test";
import assert from "node:assert/strict";
import {createServer, type Server} from "node:http";
import {once} from "node:events";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {chromium, type Browser, type Page} from "playwright";
import {WebSocketServer, type WebSocket} from "ws";

const require = createRequire(import.meta.url);
const {build} = require(require.resolve("esbuild", {paths: [require.resolve("tsup")]}));
let browser: Browser;
let server: Server;
let sockets: WebSocketServer;
let base: string;
let bundle: string;
const clients = new Map<string, WebSocket>();
const replies = new Map<string, (message: any) => void>();
const historyOperations = new Map<string, any>();

before(async () => {
  const source = `import {createClearActRuntime} from ${JSON.stringify(resolve("packages/core/src/index.ts"))};
import {mountClearActObserver} from ${JSON.stringify(resolve("packages/observer/src/index.ts"))};
window.startFixture = (options = {}) => {
 if(options.background) document.body.style.backgroundColor=options.background;
 if(options.appBackground){document.body.style.backgroundColor="transparent";const app=document.createElement("main");app.id="theme-app-root";Object.assign(app.style,{position:"fixed",inset:"0",backgroundColor:options.appBackground});document.body.prepend(app);}
 const runtime = createClearActRuntime({sessionId: options.sessionId, serverUrl: location.origin});
 const effects = []; const samples = []; const events = []; const releases = new Map();
 runtime.registerAction({name:"read", title:"读取目标", description:"Read the selected element", risk:"read", target:options.target ?? "#target", inputSchema:{type:"object"}, async execute(args, context) {
   const cursor=document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector('[data-clearact-cursor]');
   const point=cursor ? new DOMMatrix(getComputedStyle(cursor).transform) : null;
   effects.push({id:context.operationId,time:performance.now(),point:point && {x:point.m41,y:point.m42},phase:cursor?.dataset.phase});
   if(options.hold && args.hold !== false) await new Promise(done=>{releases.set(context.operationId,done);});
   return {read:true};
 }});
 runtime.subscribe(event=>events.push({...event,time:performance.now()}));
 const unmount=mountClearActObserver(runtime,undefined,{theme:options.theme,styleNonce:options.styleNonce,cursor:options.cursor,resolveTarget:options.resolve ? operation => {if(options.resolve === "throw")throw new Error("target resolver failed");return document.querySelector(operation.arguments.useResolved ? "#resolved" : "#target");} : undefined});
 const sample=()=>{const cursor=document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector('[data-clearact-cursor]');if(cursor && !cursor.hidden){const p=new DOMMatrix(getComputedStyle(cursor).transform);samples.push({id:cursor.dataset.operationId,phase:cursor.dataset.phase,x:p.m41,y:p.m42,time:performance.now()});}window.sampleFrame=requestAnimationFrame(sample);};requestAnimationFrame(sample);
 window.fixture={runtime,effects,samples,events,unmount,release:()=>{for(const done of releases.values())done();releases.clear();}};runtime.connect();
};`;
  bundle = (await build({stdin:{contents:source,resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"browser",write:false})).outputFiles[0].text;
  server=createServer((request,response)=>{
    if(request.url?.includes('style-csp=1'))response.setHeader('Content-Security-Policy',"style-src 'nonce-Y2xlYXJhY3QtdGVzdA=='; style-src-attr 'none'");
    response.setHeader("Content-Type",request.url==="/bundle.js" ? "application/javascript" : "text/html");
    response.end(request.url==="/bundle.js" ? bundle : `<!doctype html><html><head><style nonce="Y2xlYXJhY3QtdGVzdA==">body{margin:0;height:2000px}#target{position:absolute;left:850px;top:450px;width:120px;height:80px}#resolved{position:absolute;left:500px;top:220px;width:80px;height:60px}</style></head><body><button id="target">Target</button><button id="resolved">Resolved</button><script type="module" src="/bundle.js"></script></body></html>`);
  });
  sockets=new WebSocketServer({server});
  sockets.on("connection",socket=>socket.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.type==="register") {clients.set(message.sessionId,socket);socket.send(JSON.stringify({type:"registered",enabled:true}));}
    if(message.type==="control") socket.send(JSON.stringify({type:"control",enabled:message.enabled,requestId:message.requestId}));
    if(message.type==="result") {
      const operation=historyOperations.get(message.operationId);
      if(operation){socket.send(JSON.stringify({type:'event',operation:{...operation,status:message.error?'failed':'succeeded',result:message.result,error:message.error,updatedAt:new Date().toISOString()}}));historyOperations.delete(message.operationId);}
      replies.get(message.operationId)?.(message);replies.delete(message.operationId);
    }
  }));
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  browser=await chromium.launch({channel:"chrome",headless:true});
});
after(async()=>{await browser?.close();for(const socket of sockets?.clients ?? [])socket.terminate();await new Promise<void>(done=>sockets?.close(()=>server.close(()=>done())));});

let sequence=0;
async function fixture(options: Record<string,unknown> = {}): Promise<{page:Page;session:string;dispatch:(id?:string,args?:Record<string,unknown>,intent?:string)=>Promise<any>}> {
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  const session=`observer-${++sequence}`;
  if(options.reducedMotion)await page.emulateMedia({reducedMotion:"reduce"});
  if(options.colorScheme)await page.emulateMedia({colorScheme:options.colorScheme as "light"|"dark"});
  if(options.strictStyleCsp)await page.addInitScript(()=>{(window as any).styleViolations=[];document.addEventListener('securitypolicyviolation',event=>(window as any).styleViolations.push(event.violatedDirective));});
  await page.goto(options.strictStyleCsp?base+'/?style-csp=1':base);
  await page.waitForFunction(()=>typeof (window as any).startFixture==="function");
  await page.evaluate(options=>(window as any).startFixture(options),{...options,sessionId:session});
  await page.waitForFunction(()=>(window as any).fixture.runtime.isConnected());
  while(!clients.has(session))await new Promise(done=>setTimeout(done,5));
  return {page,session,dispatch(id=`operation-${sequence}`,args:Record<string,unknown>={},intent='Read target') {
    const reply=new Promise<any>((done,reject)=>{const timeout=setTimeout(()=>{replies.delete(id);reject(new Error("Result timed out"));},2000);replies.set(id,message=>{clearTimeout(timeout);done(message);});});
    void reply.catch(()=>{});
    if(options.history)historyOperations.set(id,{id,sessionId:session,action:'read',arguments:args,intent,createdAt:new Date().toISOString()});
    clients.get(session)!.send(JSON.stringify({type:"execute",operationId:id,action:"read",arguments:args,intent}));
    return reply;
  }};
}
async function state(page: Page) {return page.evaluate(()=>({effects:(window as any).fixture.effects,samples:(window as any).fixture.samples,events:(window as any).fixture.events}));}

// Replacing the Agent's current intent with action metadata or a selected old record would fail.
test('the island narrates the active intent while history opens only after manual selection',async t=>{
 const {page,dispatch}=await fixture({hold:true,history:true});t.after(()=>page.close());
 await dispatch('history-first',{hold:false},'先确认最初的目标。');
 await dispatch('history-second',{hold:false},'再核对第二个目标。');
 const current='我正在核对另一个目标，确认当前页的信息。';
 const pending=dispatch('history-active',{},current);
 await page.waitForFunction(()=>(window as any).fixture.effects.length===3);
 assert.equal(await page.locator('.control-status').textContent(),current);
 assert.equal(await page.getByRole('button',{name:'选择历史操作',exact:true}).count(),1);
 await page.getByRole('button',{name:'选择历史操作',exact:true}).click();
 assert.equal(await page.locator('.history-item').count(),2);
 const menu=(await page.locator('.history-menu').boundingBox())!;
 assert.ok(menu.width<=320,'history is a compact inspector instead of a full-width list');
 assert.ok((await page.locator('.history-list').boundingBox())!.height<=48,'history choices occupy one compact row');
 assert.equal(await page.locator('.history-detail').isVisible(),false);
 await page.locator('[data-history-operation="history-first"]').click();
 assert.equal(await page.locator('.history-detail').isVisible(),true);
 assert.match(await page.locator('.history-detail').textContent()??'',/先确认最初的目标/);
 assert.equal(await page.locator('.control-status').textContent(),current);
 await page.getByText('查看操作参数',{exact:true}).click();
 await page.evaluate(()=>(window as any).fixture.runtime.setOperationIntervalMs(900));
 assert.equal(await page.locator('.history-detail details').last().evaluate(el=>(el as HTMLDetailsElement).open),true,'frequency updates keep the selected history inspection open');
 await page.evaluate(()=>(window as any).fixture.release());await pending;
 await page.waitForFunction(()=>(window as any).fixture.runtime.getOperations().filter((op:any)=>op.status==='succeeded').length===3);
 assert.equal(await page.locator('.history-detail details').last().evaluate(el=>(el as HTMLDetailsElement).open),true,'a newer result does not close an older selected record');
});

// Reversing the slider or keeping it in a hidden popover would violate slow-to-fast control.
test('visible operation frequency maps slow and fast to the runtime pacing',async t=>{
 const {page}=await fixture();t.after(()=>page.close());
 const slider=page.getByRole('slider',{name:'操作频率',exact:true});
 assert.equal(await slider.count(),1);assert.equal(await slider.isVisible(),true);
 await slider.press('Home');
 assert.equal(await page.evaluate(()=>(window as any).fixture.runtime.getOperationIntervalMs()),5000);
 await slider.press('End');
 assert.equal(await page.evaluate(()=>(window as any).fixture.runtime.getOperationIntervalMs()),0);
 await page.evaluate(()=>(window as any).fixture.runtime.setOperationIntervalMs(1350));
 assert.equal(await slider.inputValue(),'73');
});

// Losing the stored drag position or leaving controls exposed in the dock would fail.
test('the island docks at the top and restores its dragged position',async t=>{
 const {page}=await fixture();t.after(()=>page.close());
 const handle=page.getByRole('button',{name:'拖动 ClearAct 顶岛',exact:true});
 const origin=(await handle.boundingBox())!;
 await page.mouse.move(origin.x+12,origin.y+12);await page.mouse.down();
 await page.mouse.move(origin.x+60,origin.y+142,{steps:8});await page.mouse.up();
 const before=(await page.locator('.panel').boundingBox())!;
 await page.getByRole('button',{name:'收起顶岛',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).isVisible(),false);
 assert.equal(await page.getByRole('slider',{name:'操作频率',exact:true}).isVisible(),false);
 const dock=page.getByRole('button',{name:'展开顶岛',exact:true});await dock.waitFor();
 const box=(await dock.boundingBox())!;
 assert.ok(Math.abs(box.x+box.width/2-600)<2&&box.y<=2,'only the centered top-edge entry remains');
 await dock.click();await handle.waitFor();
 const restored=(await page.locator('.panel').boundingBox())!;
 assert.ok(Math.abs(restored.x-before.x)<2&&Math.abs(restored.y-before.y)<2,'expansion restores the original position');
 assert.equal(await page.getByRole('slider',{name:'操作频率',exact:true}).isVisible(),true);
 await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).click();
 assert.equal(await page.evaluate(()=>(window as any).fixture.runtime.isAgentEnabled()),false);
});

// The component must react to the application's actual background, not only the OS preference.
test('observer theme follows page backgrounds and respects an explicit override',async t=>{
 const {page}=await fixture({background:'#101114'});t.after(()=>page.close());
 const color=()=>page.locator('.control-status').evaluate(el=>getComputedStyle(el).color);
 const sum=(value:string)=>value.match(/[\d.]+/g)!.slice(0,3).reduce((a,b)=>a+Number(b),0);
 assert.ok(sum(await color())>500,'dark pages use light narrative text');
 await page.locator('body').evaluate(el=>el.style.backgroundColor='#fafafa');
 await page.waitForFunction(()=>{const el=document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector('.control-status');return el&&getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0,3).reduce((a,b)=>a+Number(b),0)<350;});
 assert.ok(sum(await color())<350,'switching the host page to light updates the narrative contrast');
 const forced=await fixture({background:'#fafafa',theme:'dark'});t.after(()=>forced.page.close());
 assert.ok(sum(await forced.page.locator('.control-status').evaluate(el=>getComputedStyle(el).color))>500,'explicit dark appearance is retained');
});

// An approval arriving while the glass is folding must interrupt the fold and expose the decision.
test('incoming approval opens the dock and cancels an in-progress collapse',async t=>{
 const {page,session}=await fixture();t.after(()=>page.close());
 await page.getByRole('button',{name:'收起顶岛',exact:true}).click();
 const now=new Date().toISOString();
 clients.get(session)!.send(JSON.stringify({type:'event',operation:{id:'approval-after-fold',sessionId:session,action:'read',arguments:{},intent:'请核对这次读取的目标。',status:'waiting_approval',createdAt:now,updatedAt:now}}));
 await page.getByRole('button',{name:'批准执行',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'展开顶岛',exact:true}).isVisible(),false);
 assert.equal(await page.locator('.island-morph').count(),0);
});

// A separate running action must never conceal the next independent human approval.
test('approval received while another operation runs interrupts docking without replacing its intent',async t=>{
 const {page,session,dispatch}=await fixture({hold:true});t.after(()=>page.close());
 const intent='读取较慢的目标，仍在等待真实结果。';
 const running=dispatch('running-before-approval',{},intent);
 await page.waitForFunction(()=>(window as any).fixture.effects.length===1);
 await page.getByRole('button',{name:'收起顶岛',exact:true}).click();
 const now=new Date().toISOString();
 clients.get(session)!.send(JSON.stringify({type:'event',operation:{id:'parallel-approval',sessionId:session,action:'read',arguments:{},intent:'请另外确认这个目标。',status:'waiting_approval',createdAt:now,updatedAt:now}}));
 await page.getByRole('button',{name:'批准执行',exact:true}).waitFor({timeout:1500});
 assert.equal(await page.locator('.control-status').textContent(),intent);
 assert.equal(await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).isVisible(),true);
 assert.equal(await page.locator('.island-morph').count(),0);
 await page.evaluate(()=>(window as any).fixture.release());await running;
});

// The visible SPA surface may be a sibling of the observer, with transparent body/html.
test('auto theme follows an opaque SPA root below a transparent body',async t=>{
 const {page}=await fixture({appBackground:'#101114',colorScheme:'light'});t.after(()=>page.close());
 const brightness=()=>page.locator('.control-status').evaluate(el=>getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0,3).reduce((a,b)=>a+Number(b),0));
 assert.ok(await brightness()>500,'a dark app surface needs light text even when the OS and body are light');
 await page.addStyleTag({content:'#theme-app-root.page-light{background:#fafafa!important}'});
 await page.locator('#theme-app-root').evaluate(el=>el.classList.add('page-light'));
 await page.waitForFunction(()=>{const el=document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector('.control-status');return el&&getComputedStyle(el).color.match(/[\d.]+/g)!.slice(0,3).reduce((a,b)=>a+Number(b),0)<350;},{},{timeout:1500});
 assert.ok(await brightness()<350,'changes on the app root update the narrative contrast');
});

// Resizing during motion must settle the visible entry at the new center, without a stale overlay.
test('resize and reduced motion keep the dock reachable and remove transient layers',async t=>{
 const {page}=await fixture();t.after(()=>page.close());
 await page.getByRole('button',{name:'收起顶岛',exact:true}).click();
 await page.setViewportSize({width:780,height:320});
 const dock=page.getByRole('button',{name:'展开顶岛',exact:true});await dock.waitFor();
 const box=(await dock.boundingBox())!;assert.ok(Math.abs(box.x+box.width/2-390)<2&&box.y<=2);
 assert.equal(await page.locator('.island-morph').count(),0);
 await dock.click();await page.getByRole('button',{name:'收起顶岛',exact:true}).waitFor();
 const reduced=await fixture({reducedMotion:true});t.after(()=>reduced.page.close());
 await reduced.page.getByRole('button',{name:'收起顶岛',exact:true}).click();
 assert.equal(await reduced.page.getByRole('button',{name:'展开顶岛',exact:true}).isVisible(),true);
 assert.equal(await reduced.page.locator('.island-morph').count(),0);
 await reduced.page.getByRole('button',{name:'展开顶岛',exact:true}).click();
 assert.equal(await reduced.page.getByRole('button',{name:'终止 Agent 操作',exact:true}).isVisible(),true);
});

// A nonce authorizes the Observer stylesheet, but must not rely on forbidden inline SVG styles.
test('nonce-protected styling keeps the folded glass usable without inline style violations',async t=>{
 const {page}=await fixture({strictStyleCsp:true,styleNonce:'Y2xlYXJhY3QtdGVzdA=='});t.after(()=>page.close());
 assert.ok((await page.locator('.panel').boundingBox())!.width>=550,'the nonce-protected component stylesheet applies');
 await page.getByRole('button',{name:'收起顶岛',exact:true}).click();
 await page.getByRole('button',{name:'展开顶岛',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>(window as any).styleViolations),[],'folding does not add prohibited inline style attributes');
 await page.getByRole('button',{name:'展开顶岛',exact:true}).click();await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>(window as any).styleViolations),[]);
});

// A page-wide mask would fail these bounds; the visual layer must mark only the action target.
test('target locking frames the target and leaves the page clickable',async t=>{
 const {page,dispatch}=await fixture({hold:true});t.after(()=>page.close());const pending=dispatch();
 await page.waitForFunction(()=>(window as any).fixture.effects.length===1);
 const box=(await page.locator('[data-clearact-frame]').boundingBox())!;
 assert.ok(Math.abs(box.x-850)<=12&&Math.abs(box.y-450)<=12&&box.width<=144&&box.height<=104);
 assert.equal(await page.locator('[data-clearact-frame]').evaluate(el=>getComputedStyle(el).pointerEvents),'none');
 await page.evaluate(()=>(window as any).fixture.release());await pending;
});

// Stopping future work cannot imply that an already-started business promise has settled.
test('shutdown keeps a running action visible until its real result arrives',async t=>{
 const {page,dispatch}=await fixture({hold:true,history:true});t.after(()=>page.close());
 const intent='我正在读取目标，核对它的实际内容。';
 const pending=dispatch('shutdown-running',{},intent);
 await page.waitForFunction(()=>(window as any).fixture.effects.length===1);
 await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).click();
 assert.match(await page.locator('.control-status').textContent()??'',/等待.*结果/);
 assert.match(await page.locator('.control-status').textContent()??'',/核对它的实际内容/);
 assert.equal(await page.locator('[data-clearact-frame]').isVisible(),false);
 await page.evaluate(()=>(window as any).fixture.release());
 assert.deepEqual((await pending).result,{read:true});
 await page.waitForFunction(()=>(window as any).fixture.runtime.getOperations().some((op:any)=>op.id==='shutdown-running'&&op.status==='succeeded'));
 assert.doesNotMatch(await page.locator('.control-status').textContent()??'',/等待.*结果/);
 await page.getByRole('button',{name:'选择历史操作',exact:true}).click();
 await page.locator('[data-history-operation="shutdown-running"]').click();
 assert.match(await page.locator('.history-detail').textContent()??'',/真实执行结果/);
});

// A tall island must leave its history and the shutdown inside the viewport.
test('history remains accessible when a long intent fills the island',async t=>{
 const {page,dispatch}=await fixture({hold:true,history:true});t.after(()=>page.close());
 await page.setViewportSize({width:780,height:320});
 await dispatch('history-before-long',{hold:false},'先读取目标。');
 const pending=dispatch('long-active',{},'我正在核对当前页面的目标，确认这些信息与本次请求一致。'.repeat(55));
 await page.waitForFunction(()=>(window as any).fixture.effects.length===2);
 await page.getByRole('button',{name:'选择历史操作',exact:true}).click();
 const box=(await page.locator('.history-menu').boundingBox())!;
 assert.ok(box.y>=12&&box.y+box.height<=308,'history remains inside the viewport');
 assert.equal(await page.locator('[data-history-operation="history-before-long"]').isVisible(),true);
 assert.equal(await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).isVisible(),true);
 await page.locator('[data-history-operation="history-before-long"]').click();
 assert.equal(await page.locator('.history-detail').isVisible(),true);
 await page.evaluate(()=>(window as any).fixture.release());await pending;
});

// The history menu cannot intercept shutdown in a short viewport after dragging down.
test('compact history leaves shutdown clickable at the bottom of a short viewport',async t=>{
 const {page,dispatch}=await fixture({history:true});t.after(()=>page.close());
 await page.setViewportSize({width:780,height:260});await dispatch('short-history');
 const handle=(await page.getByRole('button',{name:'拖动 ClearAct 顶岛',exact:true}).boundingBox())!;
 await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(740,250,{steps:5});await page.mouse.up();
 await page.getByRole('button',{name:'选择历史操作',exact:true}).click();
 const menu=(await page.locator('.history-menu').boundingBox())!;
 const stop=(await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).boundingBox())!;
 assert.ok(menu.y+menu.height<=stop.y||menu.y>=stop.y+stop.height,'history does not overlap the shutdown button');
 await page.getByRole('button',{name:'终止 Agent 操作',exact:true}).click({timeout:1000});
 assert.equal(await page.evaluate(()=>(window as any).fixture.runtime.isAgentEnabled()),false);
});

// A long or partly clipped real target still needs visible locking corners.
test('target locking keeps all corners inside the visible target area',async t=>{
 const {page,dispatch}=await fixture({hold:true});t.after(()=>page.close());
 await page.locator('#target').evaluate(el=>Object.assign(el.style,{left:'-10px',top:'-30px',width:'1200px',height:'1200px'}));
 const pending=dispatch('clipped-target');await page.waitForFunction(()=>(window as any).fixture.effects.length===1);
 const box=(await page.locator('[data-clearact-frame]').boundingBox())!;
 assert.ok(box.x>=6&&box.y>=6&&box.x+box.width<=1194&&box.y+box.height<=794,'every corner remains visible');
 await page.evaluate(()=>(window as any).fixture.release());assert.deepEqual((await pending).result,{read:true});
});

// Removing the before-execute hook or snapping the cursor would make this fail.
test("the cursor has intermediate positions and arrives before business execution",async t=>{
 const {page,dispatch}=await fixture({hold:true});t.after(()=>page.close());
 const result=dispatch();
 await page.locator('[data-clearact-frame][data-phase="preparing"]').waitFor({state:"visible"});
 assert.equal(await page.locator(".control-status").textContent(),"Read target");
 await page.waitForFunction(()=>(window as any).fixture.effects.length===1);
 const {effects,samples}=await state(page);
 assert.ok(samples.filter((p:any)=>p.phase==="preparing" && p.x>0 && p.x<900).length>=2,"cursor must move through intermediate positions");
 assert.ok(Math.abs(effects[0].point?.x-910)<0.1 && Math.abs(effects[0].point?.y-490)<0.1,"business starts at the real target center");
 assert.equal(effects[0].phase,"executing");
 assert.equal(await page.locator(".control-status").textContent(),"Read target");
 assert.equal(await page.locator("[data-clearact-frame]").evaluate(el=>getComputedStyle(el).pointerEvents),"none");
 await page.getByRole("button",{name:"收起顶岛",exact:true}).click();
 assert.equal(await page.getByRole("button",{name:"终止 Agent 操作",exact:true}).isVisible(),false);
 await page.getByRole("button",{name:"展开顶岛",exact:true}).waitFor();
 await page.evaluate(()=>{(window as any).targetClicks=0;document.querySelector('#target')!.addEventListener('click',()=>{(window as any).targetClicks++;});});
 await page.mouse.click(910,490);
 assert.equal(await page.evaluate(()=>(window as any).targetClicks),1,"pointer and frame let a real mouse click through");
 await page.evaluate(()=>(window as any).fixture.release());assert.deepEqual((await result).result,{read:true});
 await page.waitForFunction(()=>document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector<HTMLElement>('[data-clearact-frame]')?.hidden===true);
});

// Removing local stop's abort boundary would start the real callback after this click.
test("stopping during movement prevents business execution until explicit resume",async t=>{
 const {page,dispatch}=await fixture();t.after(()=>page.close());
 const result=dispatch();await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:"visible"});
 await page.getByRole("button",{name:"终止 Agent 操作",exact:true}).click();
 assert.match((await result).error,/cancel|stop|disabled/i);assert.equal((await state(page)).effects.length,0);
 await page.getByRole("button",{name:"重新允许 Agent 操作",exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>(window as any).fixture.runtime.isAgentEnabled()),false);
 await page.getByRole("button",{name:"重新允许 Agent 操作",exact:true}).click();
 await page.getByRole("button",{name:"终止 Agent 操作",exact:true}).waitFor();
 assert.deepEqual((await dispatch("resumed-operation")).result,{read:true});
 assert.equal((await state(page)).effects.length,1);
});

// A detached target must release preparation and must never leave a stale glow.
test("removing the moving target releases visual waiting",async t=>{
 const {page,dispatch}=await fixture();t.after(()=>page.close());const result=dispatch();
 await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:"visible"});
 await page.locator('#target').evaluate(el=>el.remove());
 assert.deepEqual((await result).result,{read:true});assert.equal((await state(page)).effects.length,1);
});

// Observation alone cannot become a session stop or a permanent execution barrier.
test("unmounting observation releases preparation without stopping the runtime",async t=>{
 const {page,dispatch}=await fixture();t.after(()=>page.close());const result=dispatch();
 await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:"visible"});
 await page.evaluate(()=>(window as any).fixture.unmount());
 assert.deepEqual((await result).result,{read:true});assert.equal((await state(page)).effects.length,1);
 assert.equal(await page.evaluate(()=>(window as any).fixture.runtime.isAgentEnabled()),true);
 assert.equal(await page.locator('[data-clearact-observer]').count(),0);
});

// Reduced-motion users must not pay an artificial animation delay.
test("reduced motion skips movement and still executes",async t=>{
 const {page,dispatch}=await fixture();t.after(()=>page.close());await page.emulateMedia({reducedMotion:"reduce"});
 assert.deepEqual((await dispatch()).result,{read:true});assert.equal((await state(page)).samples.filter((p:any)=>p.phase==="preparing").length,0);
});


// A broken visual cancellation API must not consume the Runtime's preparation timeout.
test("visual cleanup failures release waiting immediately",async t=>{
 const {page,dispatch}=await fixture();t.after(()=>page.close());const result=dispatch();
 await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:"visible"});
 const removedAt=await page.evaluate(()=>{window.cancelAnimationFrame=()=>{throw new Error("visual subsystem failed");};document.querySelector('#target')?.remove();return performance.now();});
 assert.deepEqual((await result).result,{read:true});
 assert.ok((await state(page)).effects[0].time-removedAt<300,"visual failure should release its own wait, not rely on Runtime timeout");
});

// Approval must retain the target lock without overwriting the application's own outline.
test("approval keeps target locking without changing the page's outline",async t=>{
 const {page,session}=await fixture();t.after(()=>page.close());
 await page.locator('#target').evaluate(el=>{el.style.outline="1px dotted rgb(255, 0, 0)";el.style.outlineOffset="2px";});
 const pending={id:"approval-highlight",sessionId:session,action:"read",arguments:{},intent:"Review target",status:"waiting_approval",createdAt:"2026-10-11T00:00:00Z",updatedAt:"2026-10-11T00:00:00Z"};
 clients.get(session)!.send(JSON.stringify({type:"event",operation:pending}));
 await page.locator(".status.waiting_approval").waitFor();
 assert.equal(await page.locator('#target').evaluate(el=>el.style.outlineStyle),"dotted");
 assert.equal(await page.locator('[data-clearact-frame]').evaluate(el=>(el as HTMLElement).hidden),false);
 assert.equal(await page.locator('[data-clearact-frame]').getAttribute('data-phase'),'approval');
 clients.get(session)!.send(JSON.stringify({type:"event",operation:{...pending,status:"rejected",updatedAt:"2026-10-11T00:00:01Z"}}));
 await page.locator('[data-agent-mode="ready"]').waitFor();
 assert.equal(await page.locator('#target').evaluate(el=>el.style.outline),"rgb(255, 0, 0) dotted 1px");
 assert.equal(await page.locator('#target').evaluate(el=>el.style.outlineOffset),"2px");
});

// An earlier resume ACK must not swallow a stop while rendering its enabled state.
test("stop remains effective during the resume acknowledgement",async t=>{
 const {page}=await fixture();t.after(()=>page.close());
 await page.getByRole("button",{name:"终止 Agent 操作",exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector<HTMLButtonElement>('.resume')?.disabled===false);
 await page.evaluate(()=>{(window as any).fixture.runtime.subscribe((event:any)=>{if(event.type==="control" && event.enabled)document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector<HTMLButtonElement>('.stop')?.click();});});
 await page.getByRole("button",{name:"重新允许 Agent 操作",exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector<HTMLButtonElement>('.resume')?.disabled===false);
 assert.equal((await state(page)).events.filter((event:any)=>event.type==='control'&&event.enabled).length,1,'the resume acknowledgement actually arrived');
 assert.equal(await page.evaluate(()=>(window as any).fixture.runtime.isAgentEnabled()),false);
});


// Runtime FIFO gives each action a complete movement after the previous action settles.
test("overlapping dispatches retain serial business execution and independent pointer movement",async t=>{
 const {page,dispatch}=await fixture({hold:true});t.after(()=>page.close());
 const first=dispatch("serial-first");
 await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:"visible"});
 const second=dispatch("serial-second",{hold:false});
 await page.waitForFunction(()=>(window as any).fixture.effects.length===1);
 assert.equal((await state(page)).effects[0].id,"serial-first");
 assert.equal(await page.locator('[data-clearact-cursor]').getAttribute('data-operation-id'),"serial-first");
 await page.evaluate(()=>(window as any).fixture.release());
 assert.deepEqual((await first).result,{read:true});
 assert.deepEqual((await second).result,{read:true});
 const actual=await state(page);
 assert.deepEqual(actual.effects.map((effect:any)=>effect.id),['serial-first','serial-second']);
 const movement=actual.samples.filter((sample:any)=>sample.id==='serial-second'&&sample.phase==='preparing');
 assert.ok(movement.length>=10,'the later action must acquire a complete pointer preparation');
});

// A viewport change must not leave the pointer at the element's earlier coordinates.
test("scrolling during movement tracks the current target center",async t=>{
 const {page,dispatch}=await fixture({hold:true});t.after(()=>page.close());const result=dispatch();
 await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:"visible"});
 await page.evaluate(()=>window.scrollTo(0,100));
 await page.waitForFunction(()=>(window as any).fixture.effects.length===1);
 const effect=(await state(page)).effects[0];
 assert.ok(Math.abs(effect.point.x-910)<.1 && Math.abs(effect.point.y-390)<.1);
 await page.evaluate(()=>window.scrollTo(0,200));
 await page.waitForFunction(()=>{const cursor=document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector('[data-clearact-cursor]');return cursor && Math.abs(new DOMMatrix(getComputedStyle(cursor).transform).m42-290)<.1;});
 await page.evaluate(()=>(window as any).fixture.release());assert.deepEqual((await result).result,{read:true});
});

// Ignoring operation-specific arguments would aim at the action's static selector.
test("resolveTarget uses operation arguments to locate the actual target",async t=>{
 const {page,dispatch}=await fixture({resolve:true});t.after(()=>page.close());
 assert.deepEqual((await dispatch(undefined,{useResolved:true})).result,{read:true});
 const point=(await state(page)).effects[0].point;
 assert.ok(Math.abs(point.x-540)<.1 && Math.abs(point.y-250)<.1);
});

// Visual absence or a resolver error must not fail valid business work.
for(const options of [{target:'#missing'},{target:'['},{cursor:false},{resolve:'throw'}]) {
 test(`visual preparation safely skips ${JSON.stringify(options)}`,async t=>{
  const {page,dispatch}=await fixture(options);t.after(()=>page.close());
  assert.deepEqual((await dispatch()).result,{read:true});
  const actual=await state(page);assert.equal(actual.effects.length,1);assert.equal(actual.samples.length,0);
 });
}

// A paused animation callback must have its own bounded release, even without rAF progress.
test("a stalled animation releases visual preparation within its deadline",async t=>{
 const {page,dispatch}=await fixture();t.after(()=>page.close());
 await page.evaluate(()=>{window.requestAnimationFrame=()=>1;});
 assert.deepEqual((await dispatch()).result,{read:true});
 assert.equal((await state(page)).effects.length,1);
 assert.equal(await page.locator('[data-clearact-cursor]').evaluate(el=>(el as HTMLElement).hidden),true);
});

// Runtime/page lifecycle cleanup must abort the prepared action before its callback starts.
for(const lifecycle of ['disconnect','dispose']) {
 test(`runtime ${lifecycle} during movement cancels business and clears visuals`,async t=>{
  const {page}=await fixture();t.after(()=>page.close());
  const runtimeSession=await page.evaluate(()=>(window as any).fixture.runtime.options.sessionId);
  clients.get(runtimeSession)!.send(JSON.stringify({type:'execute',operationId:`lifecycle-${lifecycle}`,action:'read',arguments:{},intent:'Read target'}));
  await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:'visible'});
  await page.evaluate(method=>(window as any).fixture.runtime[method](),lifecycle);
  await page.waitForFunction(()=>document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector<HTMLElement>('[data-clearact-cursor]')?.hidden===true);
  if(lifecycle==='disconnect')await page.waitForFunction(()=>{const events=(window as any).fixture.events;return events.some((event:any)=>event.type==='execution' && event.phase==='settled');});
  assert.equal((await state(page)).effects.length,0);
  assert.equal(await page.locator('[data-clearact-cursor]').evaluate(el=>(el as HTMLElement).hidden),true);
  assert.equal(await page.locator('[data-clearact-frame]').evaluate(el=>(el as HTMLElement).hidden),true);
 });
}

// Nearby fields must remain visibly connected even when tool calls have a gap.
test('successive short actions keep the pointer and travel from field to field', async t => {
 const {page,dispatch}=await fixture({resolve:true});t.after(()=>page.close());
 await page.locator('#resolved').evaluate(el=>{Object.assign((el as HTMLElement).style,{left:'850px',top:'520px',width:'120px',height:'80px'});});
 await dispatch('field-first');
 const cursor=page.locator('[data-clearact-cursor]');
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),false,'the pointer must survive business completion');
 assert.equal(await cursor.getAttribute('data-phase'),'idle');
 assert.equal(await page.locator('[data-clearact-frame]').evaluate(el=>(el as HTMLElement).hidden),true,'the action frame must still end with the action');
 assert.equal(await page.locator('.target-glow').evaluate(el=>(el as HTMLElement).hidden),true);
 await page.waitForTimeout(600); // Represents the interval between sequential tool responses.
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),false);
 await dispatch('field-second',{useResolved:true});
 await dispatch('field-third');
 const {samples,effects}=await state(page);
 for(const [id,startY,endY] of [['field-second',490,560],['field-third',560,490]] as const) {
  const movement=samples.filter((sample:any)=>sample.id===id && sample.phase==='preparing');
  assert.ok(movement.length>=10,'nearby targets need a readable movement');
  assert.ok(Math.abs(movement[0].y-startY)<5,'the next movement starts at the previous field');
  assert.ok(movement.some((sample:any)=>sample.y>495 && sample.y<555),'the pointer visits intermediate positions between fields');
  const effect=effects.find((effect:any)=>effect.id===id);
  assert.ok(effect.time-movement[0].time>=350,'short movements must not flash past');
  assert.ok(Math.abs(effect.point.y-endY)<.1,'execution starts after reaching the next field');
 }
});

// Freeze before dispatch so every preparation/idle/fade timer shares the same clock.
async function prepareTimedPointer(page:Page,dispatch:(id?:string,args?:Record<string,unknown>)=>Promise<any>,id:string) {
 await page.clock.install();
 await page.clock.pauseAt(new Date(Date.now()+100));
 const result=dispatch(id);
 await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:'visible'});
 await page.clock.runFor(700);
 await result;
}
async function remainingIdle(page:Page,id:string) {
 return page.evaluate(id=>{
  const f=(window as any).fixture;
  const settled=f.events.find((event:any)=>event.type==='execution' && event.phase==='settled' && event.operation.id===id);
  return 10_000-(performance.now()-settled.time);
 },id);
}

// The full idle hold must end in visible intermediate opacity, then hidden DOM.
test('the idle pointer stays for ten seconds and then fades out', async t => {
 const {page,dispatch}=await fixture();t.after(()=>page.close());
 await prepareTimedPointer(page,dispatch,'idle-fade');
 const cursor=page.locator('[data-clearact-cursor]');
 await page.clock.fastForward((await remainingIdle(page,'idle-fade'))-1);
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),false);
 assert.equal(await cursor.getAttribute('data-phase'),'idle','the pointer stays for the entire ten-second hold');
 assert.equal(await cursor.evaluate(el=>getComputedStyle(el).opacity),'1');
 await page.clock.fastForward(1);
 assert.equal(await cursor.getAttribute('data-phase'),'fading','fade starts at the ten-second boundary');
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),false);
 // CSS transitions use the compositor clock; keep JS timers paused while sampling opacity.
 await page.waitForTimeout(100);
 const opacity=Number(await cursor.evaluate(el=>getComputedStyle(el).opacity));
 assert.ok(opacity>0 && opacity<1,'the fade must have visible intermediate opacity');
 await page.clock.fastForward(299);
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),false,'hidden is delayed until the full fade duration');
 await page.clock.fastForward(1);
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),true);
});

// A stale fade timer must not hide the pointer belonging to a newer operation.
test('an action arriving during fade restores the same pointer and cancels old cleanup', async t => {
 const {page,dispatch}=await fixture({resolve:true});t.after(()=>page.close());
 await prepareTimedPointer(page,dispatch,'before-fade');
 await page.clock.fastForward(await remainingIdle(page,'before-fade'));
 const cursor=page.locator('[data-clearact-cursor]');
 assert.equal(await cursor.getAttribute('data-phase'),'fading');
 await page.waitForTimeout(100);
 assert.ok(Number(await cursor.evaluate(el=>getComputedStyle(el).opacity))<1);
 const next=dispatch('interrupt-fade',{useResolved:true});
 await page.locator('[data-clearact-cursor][data-phase="preparing"]').waitFor({state:'visible'});
 assert.equal(await cursor.evaluate(el=>getComputedStyle(el).opacity),'1');
 const start=await cursor.evaluate(el=>{const matrix=new DOMMatrix(getComputedStyle(el).transform);return {x:matrix.m41,y:matrix.m42};});
 assert.ok(Math.abs(start.x-910)<.1 && Math.abs(start.y-490)<.1,'fade cancellation retains the exact last coordinate');
 await page.clock.runFor(700); // Also passes the previous fade cleanup deadline.
 await next;
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),false);
 const movement=(await state(page)).samples.filter((sample:any)=>sample.id==='interrupt-fade' && sample.phase==='preparing');
 assert.ok(movement.some((sample:any)=>sample.x>550 && sample.x<900),'movement remains visible through the old fade deadline');
 await page.clock.fastForward((await remainingIdle(page,'interrupt-fade'))-1);
 assert.equal(await cursor.getAttribute('data-phase'),'idle','the newer action restarts the entire idle hold');
 assert.equal(await cursor.evaluate(el=>(el as HTMLElement).hidden),false);
});

// Idle retention cannot leave a stale pointer after explicit lifecycle cleanup.
for(const cleanup of ['stop','disconnect','unmount','reduced-motion','hidden-page']) {
 test(`retained idle pointer clears immediately on ${cleanup}`,async t=>{
  const {page,dispatch}=await fixture();t.after(()=>page.close());
  await dispatch(`idle-cleanup-${cleanup}`);
  assert.equal(await page.locator('[data-clearact-cursor]').evaluate(el=>(el as HTMLElement).hidden),false);
  if(cleanup==='reduced-motion') await page.emulateMedia({reducedMotion:'reduce'});
  else if(cleanup==='hidden-page') await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  else await page.evaluate(method=>{const f=(window as any).fixture;return method==='unmount' ? f.unmount() : f.runtime[method]();},cleanup);
  if(cleanup==='unmount') assert.equal(await page.locator('[data-clearact-observer]').count(),0);
  else await page.waitForFunction(()=>document.querySelector('[data-clearact-observer]')?.shadowRoot?.querySelector<HTMLElement>('[data-clearact-cursor]')?.hidden===true);
 });
}
