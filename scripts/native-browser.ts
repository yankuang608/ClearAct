import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,type Browser,type Page} from 'playwright';
import {createClearActServer} from '../packages/server/src/http.ts';
import type {ClearActOperation} from '../packages/core/src/types.ts';

// Independent framework fixture: no model, no application integration, no shared broker.
const output=resolve(process.env.CLEARACT_NATIVE_OUTPUT||'work/round-2/native-browser');
const flag='--enable-blink-features=WebMCP';
const sessionId='native-browser-'+Date.now();
const approvalToken=randomBytes(32).toString('base64url');
const brokerOptions={approvalTimeoutMs:10_000,executionTimeoutMs:10_000};
const app=createClearActServer({approvalToken,brokerOptions});
let browser:Browser|undefined;
let activePage:Page|undefined;
let pageServer:ReturnType<typeof createServer>|undefined;
const evidence:Record<string,any>={
 scope:'Real experimental Chrome WebMCP + ClearAct core + isolated HTTP/WS broker fixture. No model and no Kan/Vikunja validation.',
 startedAt:new Date().toISOString(),
 specification:{url:'https://webmachinelearning.github.io/webmcp/',observedDraft:'2026-09-30',expected:'document.modelContext.getTools() returns RegisteredTool[]; executeTool(tool,input,options) resolves to a JSON-serialized string',chromeCompatibilitySource:'https://github.com/GoogleChrome/modern-web-guidance-src/blob/main/guides/webmcp/agentic-javascript-tools/guide.md',boundary:'Chrome 154 experimental API compatibility, not full conformance to the 2026-09-30 draft'},
 startup:{channel:'chrome',headless:true,experimentalFlag:flag,brokerOptions},
 approval:'Independent Node test driver holds the approval credential; browser receives execution capabilities only.',
 cases:[],consoleErrors:[],pageErrors:[],ok:false,
};
await mkdir(output,{recursive:true});

async function capabilities(page:Page){
 return page.evaluate(()=>{
  const doc=(document as any).modelContext;const nav=(navigator as any).modelContext;
  return {documentApi:typeof doc,navigatorApi:typeof nav,methods:doc?Object.getOwnPropertyNames(Object.getPrototypeOf(doc)):[]};
 });
}

try{
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const entry=`import {createClearActRuntime} from ${JSON.stringify(resolve('packages/core/src/index.ts'))};
const runtime=createClearActRuntime({sessionId:${JSON.stringify(sessionId)},serverUrl:${JSON.stringify(base)},context:{scope:'isolated native WebMCP fixture'}});
const counts={read:0,approved:0,rejected:0,selfUnregistered:0};
(window as any).fixture={runtime,counts,calls:{}};
runtime.registerAction({name:'read_status',description:'Read the fixture status',risk:'read',inputSchema:{type:'object',additionalProperties:false},async execute(){counts.read++;return {count:7,source:'native-browser-fixture'};}});
const schema={type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false};
function registerHigh(name:string,counter:'approved'|'rejected'){
 runtime.registerAction({name,description:'Change exactly one fixture record after independent human approval',risk:'high',inputSchema:schema,async execute(args,context){
  const verified=await fetch(${JSON.stringify(base+'/api/verify-execution')},{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+context.executionToken},body:JSON.stringify({operationId:context.operationId,sessionId:${JSON.stringify(sessionId)},action:name,arguments:args})});
  if(!verified.ok)throw new Error('Execution capability rejected');
  counts[counter]++;return {updated:args.id,executionCount:counts[counter]};
 }});
}
registerHigh('high_approve','approved');registerHigh('high_reject','rejected');
const unregisterSelf=runtime.registerAction({name:'self_unregister',description:'Complete once and unregister this fixture action during execution',risk:'write',inputSchema:{type:'object',additionalProperties:false},async execute(){counts.selfUnregistered++;unregisterSelf();return {completed:true,executionCount:counts.selfUnregistered};}});
runtime.connect();`;
 await writeFile(resolve(output,'entry.ts'),entry);
 execFileSync(createRequire(createRequire(import.meta.url).resolve('tsup')).resolve('esbuild/bin/esbuild'),[resolve(output,'entry.ts'),'--bundle','--format=esm','--platform=browser','--outfile='+resolve(output,'bundle.js')],{stdio:'pipe'});
 const bundle=await readFile(resolve(output,'bundle.js'));
 const html='<!doctype html><meta charset="utf-8"><title>ClearAct experimental native WebMCP fixture</title><h1>Experimental Chrome WebMCP fixture</h1><p>Real browser API and ClearAct core; isolated test only, no model or application integration.</p><script type="module" src="/bundle.js"></script>';
 pageServer=createServer((req,res)=>{
  if(req.url==='/bundle.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(bundle);}
  else if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(html);}
  else if(req.url==='/capabilities'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>WebMCP capability probe</title>');}
  else if(req.url==='/favicon.ico'){res.writeHead(204);res.end();}
  else {res.writeHead(404);res.end();}
 });
 pageServer.listen(0,'127.0.0.1');await once(pageServer,'listening');
 const pageUrl=`http://127.0.0.1:${(pageServer.address() as {port:number}).port}`;
 // Probe the same trustworthy loopback origin without loading the fixture or registering actions.
 browser=await chromium.launch({channel:'chrome',headless:true});
 let page=await browser.newPage();await page.goto(pageUrl+'/capabilities');
 evidence.defaultChrome={version:browser.version(),...await capabilities(page)};
 await browser.close();browser=undefined;
 browser=await chromium.launch({channel:'chrome',headless:true,args:[flag]});
 page=await browser.newPage();activePage=page;page.setDefaultTimeout(15_000);
 page.on('pageerror',error=>evidence.pageErrors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')evidence.consoleErrors.push(message.text());});
 await page.goto(pageUrl);
 evidence.experimentalChrome={version:browser.version(),...await capabilities(page)};
 assert.equal(evidence.experimentalChrome.documentApi,'object','Experimental document.modelContext unavailable');
 await page.waitForFunction(async()=>{
  const fixture=(window as any).fixture;
  return fixture?.runtime.isConnected()&&(await (document as any).modelContext.getTools()).length===4;
 });
 evidence.registeredTools=await page.evaluate(async()=>((await (document as any).modelContext.getTools()) as any[]).map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema,origin:tool.origin})));

 const request=async(path:string,decision=false):Promise<ClearActOperation>=>{
  const response=await fetch(base+path,{method:decision?'POST':'GET',headers:decision?{'Content-Type':'application/json',Authorization:'Bearer '+approvalToken}:{},body:decision?'{}':undefined,signal:AbortSignal.timeout(5_000)});
  const body=await response.json();if(!response.ok)throw new Error(`ClearActBroker ${response.status}: ${JSON.stringify(body)}`);return body as ClearActOperation;
 };
 let inputEncoding:'object'|'json-string'='object';
 const startNative=async(key:string,name:string,args:Record<string,unknown>)=>{
  await page.evaluate(async({key,name,args,inputEncoding})=>{
   const modelContext=(document as any).modelContext;
   const tool=(await modelContext.getTools()).find((candidate:any)=>candidate.name===name);
   if(!tool)throw new Error('Native tool unavailable: '+name);
   const fixture=(window as any).fixture;const controller=new AbortController();
   fixture.calls[key]={status:'pending',controller};
   const timeout=setTimeout(()=>controller.abort(),12_000);
   const input={intent:`检查 ${name} 的实际执行结果，验证原生调用与页面操作记录一致。`,arguments:args};
   // Call the actual browser API. Do not replace it with a shim or direct callback.
   Promise.resolve(modelContext.executeTool(tool,inputEncoding==='json-string'?JSON.stringify(input):input,{signal:controller.signal})).then(
    value=>{fixture.calls[key]={status:'fulfilled',value,valueType:typeof value};},
    error=>{fixture.calls[key]={status:'rejected',error:{name:error?.name,message:error?.message}};},
   ).finally(()=>clearTimeout(timeout));
  },{key,name,args,inputEncoding});
 };
 const nativeResult=async(key:string)=>{
  await page.waitForFunction(key=>(window as any).fixture.calls[key]?.status!=='pending',key);
  return await page.evaluate(key=>(window as any).fixture.calls[key],key) as any;
 };
 const operation=async(action:string,status?:string)=>{
  await page.waitForFunction(({action,status})=>(window as any).fixture.runtime.getOperations().some((op:any)=>op.action===action&&(!status||op.status===status)),{action,status});
  const id=await page.evaluate(action=>(window as any).fixture.runtime.getOperations().find((op:any)=>op.action===action).id,action);
  return await request('/api/operations/'+encodeURIComponent(id));
 };
 const counts=()=>page.evaluate(()=>(window as any).fixture.counts);
 const parsed=(result:any)=>{assert.equal(result.status,'fulfilled');assert.equal(result.valueType,'string','Browser executeTool serialization differs from the checked draft');return JSON.parse(result.value);};

 await startNative('object-input-probe','read_status',{});
 let readResult=await nativeResult('object-input-probe');
 evidence.inputCompatibility={objectAttempt:readResult,countsAfterObjectAttempt:await counts(),operationsAfterObjectAttempt:await page.evaluate(()=>(window as any).fixture.runtime.getOperations())};
 if(readResult.status==='rejected'&&readResult.error?.message==='Failed to parse input arguments'){
  // Chrome <155 accepts JSON text. Retry only this confirmed parser rejection before any invocation.
  assert.equal(evidence.inputCompatibility.operationsAfterObjectAttempt.length,0);
  assert.deepEqual(evidence.inputCompatibility.countsAfterObjectAttempt,{read:0,approved:0,rejected:0,selfUnregistered:0});
  inputEncoding='json-string';await startNative('read','read_status',{});readResult=await nativeResult('read');
 }
 evidence.inputCompatibility.selectedInputEncoding=inputEncoding;
 const read={name:'read',native:readResult,operation:await operation('read_status'),counts:await counts()};evidence.cases.push(read);
 assert.deepEqual(parsed(read.native),{count:7,source:'native-browser-fixture'});assert.equal(read.operation.status,'succeeded');assert.equal(read.counts.read,1);
 assert.match(read.operation.intent,/检查 read_status 的实际执行结果/);

 await startNative('approve','high_approve',{id:'fixture-1'});
 const waiting=await operation('high_approve','waiting_approval');const beforeApprove=await counts();
 assert.equal(beforeApprove.approved,0);
 const firstApproval=await request(`/api/operations/${waiting.id}/approve`,true);
 const repeatedApproval=await request(`/api/operations/${waiting.id}/approve`,true);
 const approved={name:'high-approved-once',before:waiting,beforeCounts:beforeApprove,approvalStatuses:[firstApproval.status,repeatedApproval.status],native:await nativeResult('approve'),operation:await operation('high_approve'),counts:await counts()};evidence.cases.push(approved);
 assert.deepEqual(parsed(approved.native),{updated:'fixture-1',executionCount:1});assert.equal(approved.operation.status,'succeeded');assert.equal(approved.counts.approved,1);

 await startNative('reject','high_reject',{id:'fixture-2'});
 const waitingReject=await operation('high_reject','waiting_approval');
 assert.equal((await counts()).rejected,0);await request(`/api/operations/${waitingReject.id}/reject`,true);
 const rejected={name:'high-rejected-no-execution',before:waitingReject,native:await nativeResult('reject'),operation:await operation('high_reject'),counts:await counts()};evidence.cases.push(rejected);
 assert.equal(rejected.native.status,'rejected');assert.equal(rejected.operation.status,'rejected');assert.equal(rejected.counts.rejected,0);

 await startNative('unregister','self_unregister',{});
 const unregistered={name:'active-callback-unregister',native:await nativeResult('unregister'),operation:await operation('self_unregister'),counts:await counts(),remainingTools:await page.evaluate(async()=>((await (document as any).modelContext.getTools()) as any[]).map(tool=>tool.name))};evidence.cases.push(unregistered);
 assert.deepEqual(parsed(unregistered.native),{completed:true,executionCount:1});assert.equal(unregistered.operation.status,'succeeded');assert.equal(unregistered.counts.selfUnregistered,1);assert.equal(unregistered.remainingTools.includes('self_unregister'),false);
 evidence.finalCounts=await counts();evidence.ok=true;
}catch(error){
 evidence.failure={name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message:String(error)};
 if(activePage)try{evidence.failureSnapshot=await activePage.evaluate(()=>{
  const fixture=(window as any).fixture;
  return fixture?{calls:Object.fromEntries(Object.entries(fixture.calls).map(([key,value]:[string,any])=>[key,{status:value.status,value:value.value,valueType:value.valueType,error:value.error}])),counts:fixture.counts,operations:fixture.runtime.getOperations()}:null;
 });}catch{}
 process.exitCode=1;
}finally{
 const cleanupErrors:string[]=[];
 if(browser)try{await browser.close();}catch(error){cleanupErrors.push(String(error));}
 if(pageServer)try{await new Promise<void>((done,reject)=>pageServer!.close(error=>error?reject(error):done()));}catch(error){cleanupErrors.push(String(error));}
 try{await app.close();}catch(error){cleanupErrors.push(String(error));}
 evidence.finishedAt=new Date().toISOString();evidence.cleanup={closed:cleanupErrors.length===0,errors:cleanupErrors};
 if(cleanupErrors.length){evidence.ok=false;process.exitCode=1;}
 await writeFile(resolve(output,'evidence.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({ok:evidence.ok,scope:evidence.scope,output,evidenceFile:resolve(output,'evidence.json'),failure:evidence.failure},null,2));
}
