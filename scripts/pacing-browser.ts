import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {createClearActServer} from '../packages/server/src/index.ts';

// Framework integration evidence only; business benchmark acceptance is separate.
const out=resolve(process.env.CLEARACT_PACING_OUTPUT||'work/pacing-browser');
await mkdir(out,{recursive:true});
const app=createClearActServer({approvalToken:'fixture-human-only'});
app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
const base=`http://127.0.0.1:${(app.server.address() as any).port}`;
const sessionId='pacing-fixture-'+Date.now();
const entry=`import {createClearActRuntime} from ${JSON.stringify(resolve('packages/core/src/index.ts'))};
import {mountClearActObserver} from ${JSON.stringify(resolve('packages/observer/src/index.ts'))};
const runtime=createClearActRuntime({sessionId:${JSON.stringify(sessionId)},serverUrl:${JSON.stringify(base)}});
window.trace=[];window.fixtureRuntime=runtime;
runtime.registerAction({name:'work',title:'执行计时任务',description:'Framework timing fixture',risk:'write',inputSchema:{type:'object',properties:{duration:{type:'number'}},required:['duration'],additionalProperties:false},async execute(args,ctx){const row={operationId:ctx.operationId,startedAtMs:performance.now(),endedAtMs:null};window.trace.push(row);await new Promise(resolve=>setTimeout(resolve,args.duration));row.endedAtMs=performance.now();return {done:true};}});
mountClearActObserver(runtime);runtime.connect();`;
await writeFile(out+'/entry.ts',entry);
const require=createRequire(import.meta.url);
execFileSync(createRequire(require.resolve('tsup')).resolve('esbuild/bin/esbuild'),[out+'/entry.ts','--bundle','--format=esm','--platform=browser','--outfile='+out+'/bundle.js'],{stdio:'pipe'});
const server=createServer(async(req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?await readFile(out+'/bundle.js'):'<!doctype html><meta charset="utf-8"><title>ClearAct pacing fixture</title><h1>ClearAct 调速框架验收</h1><p>真实 Core + Observer + Broker；独立 fixture。</p><script type="module" src="/bundle.js"></script>');});
server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
page.on('pageerror',error=>console.error('Browser error:',error.message));
try{
 await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
 await page.waitForFunction(()=>(window as any).fixtureRuntime?.isConnected());
 const slider=page.getByRole('slider',{name:'操作频率',exact:true});
 assert.equal(await slider.count(),1,'Observer must expose an accessible operation frequency slider');
 assert.equal(await slider.getAttribute('min'),'0');assert.equal(await slider.getAttribute('max'),'100');assert.equal(await slider.getAttribute('step'),'1');
 assert.equal(await slider.inputValue(),'90');await page.getByText('最多 2 次/秒',{exact:true}).waitFor();
 await slider.focus();await slider.press('ArrowRight');
 assert.equal(await page.evaluate(()=>(window as any).fixtureRuntime.getOperationIntervalMs()),450,'Moving toward fast immediately reduces the runtime interval');
 await page.evaluate(()=>(window as any).fixtureRuntime.setOperationIntervalMs(500));
 assert.equal(await slider.inputValue(),'90');
 await slider.evaluate((element:any)=>{(window as any).originalSlider=element;});
 const set=async(value:number)=>{await slider.evaluate((element:any,value)=>{element.value=String(100-value/50);element.dispatchEvent(new Event('input',{bubbles:true}));},value);assert.equal(await page.evaluate(()=>(window as any).fixtureRuntime.getOperationIntervalMs()),value);};
 const invoke=async(duration:number)=>{const response=await fetch(base+'/api/invoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,action:'work',arguments:{duration},intent:'Run framework timing check',requestId:crypto.randomUUID()})});const body=await response.json() as any;assert.equal(response.ok,true,JSON.stringify(body));return body;};
 const completed=async(ids:string[])=>{await page.waitForFunction(ids=>ids.every(id=>(window as any).fixtureRuntime.getOperations().some((op:any)=>op.id===id&&op.status==='succeeded')),ids);};
 const traces:any[]=[];
 for(const interval of [500,2000,0]){
  await set(interval);await slider.focus();
  const before=await page.evaluate(()=>(window as any).trace.length);
  const first=await invoke(250);const second=await invoke(30);const third=await invoke(30);
  await page.waitForFunction(()=>(window as any).fixtureRuntime.getOperations().some((op:any)=>op.status==='queued'));
  await completed([first.id,second.id,third.id]);
  assert.equal(await slider.evaluate((element:any)=>element===(window as any).originalSlider&&element.getRootNode().activeElement===element),true,'Operation renders preserve slider identity and focus');
  const rows=await page.evaluate(before=>(window as any).trace.slice(before),before);
  assert.deepEqual(rows.map((row:any)=>row.operationId),[first.id,second.id,third.id],'Broker dispatches accepted work FIFO');
  for(let i=1;i<rows.length;i++){assert.ok(rows[i].startedAtMs>=rows[i-1].endedAtMs,'execute promises must not overlap');assert.ok(rows[i].startedAtMs-rows[i-1].startedAtMs>=interval,'start-to-start minimum interval');}
  traces.push({interval,rows});
 }
 // Decreasing a waiting interval must wake it; increasing must extend it.
 for(const [initial,next] of [[2000,100],[1000,1500]]){
  await set(initial);const before=await page.evaluate(()=>(window as any).trace.length);
  const first=await invoke(100);await page.waitForFunction(before=>(window as any).trace.length>before,before);
  const second=await invoke(30);await page.waitForTimeout(200);await set(next);
  await completed([first.id,second.id]);const rows=await page.evaluate(before=>(window as any).trace.slice(before),before);
  const delta=rows[1].startedAtMs-rows[0].startedAtMs;
  assert.ok(delta>=next,'Changed interval applies to pending execute');
  if(next===100)assert.ok(delta<1000,'Decreasing interval wakes pending execution without old delay');
  traces.push({initial,next,rows});
 }
 await page.screenshot({path:out+'/pacing.png',fullPage:true});
 await writeFile(out+'/evidence.json',JSON.stringify({ok:true,scope:'real Chrome framework fixture; not business benchmark or model evaluation',traces},null,2));
 console.log(JSON.stringify({ok:true,output:out}));
}finally{await browser.close();await new Promise<void>(done=>server.close(()=>done()));await app.close();}
