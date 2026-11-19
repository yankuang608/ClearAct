import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createClearActRuntime, PageError, type ClearActAction} from '../src/index.ts';
import {createClearActServer} from '../../server/src/http.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){for(let n=0;n<400;n++){if(check())return;await delay(5);}throw new Error('transition timed out');}
const code=(expected:string)=>(error:any)=>error?.code===expected;
async function fixture(t:TestContext,options:{risk?:'write'|'high';result?:unknown;native?:boolean;hold?:Promise<void>;throwError?:Error}={}){
 const tools=new Map<string,any>();const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 if(options.native)Object.defineProperty(globalThis,'document',{configurable:true,value:{modelContext:{registerTool(tool:any){tools.set(tool.name,tool);},unregisterTool(name:string){tools.delete(name);}}}});
 const app=createClearActServer({approvalToken:'test-human-only',brokerOptions:{approvalTimeoutMs:600_000}});
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(app.server.address() as any).port}`;
 const runtime=createClearActRuntime({sessionId:'page-test',serverUrl:url,contextMode:'page',operationIntervalMs:0});
 const model={value:'visible draft',side:'unrelated',effects:0,captureError:undefined as Error|undefined};const form={},field={},bindingIdentity={};let currentSnapshot='';
 const cleanup=()=>{runtime.dispose();if(options.native){if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}};
 t.after(async()=>{cleanup();await app.close();});
 runtime.registerAction({name:'save',description:'Save presented form',risk:options.risk??'write',resultMode:'page',inputSchema:{type:'object',properties:{id:{const:'record-1'}},required:['id'],additionalProperties:false},async execute(){model.effects++;await options.hold;if(options.throwError)throw options.throwError;return options.result??{outcome:'completed',observationRequired:true};}});
 runtime.registerView({key:'form',kind:'form',root:()=>form});
 runtime.registerActionBinding({key:'save',viewKey:'form',action:'save',target:()=>form,trigger:()=>field,objectKey:()=>'record-1',argumentBindings:()=>({id:'record-1'}),guard:{scope:'form'}});
 runtime.setPageAdapter({capture(_views,_bindings,refs,actionIdentity){
  if(model.captureError)throw model.captureError;
  const rootRef=refs.ref(form,'form'),fieldRef=refs.ref(field,'field');const binding={ref:refs.ref(_bindings[0]!,'binding',_bindings[0]!.objectKey()),action:'save',targetRef:rootRef,label:'Save',enabled:true,callable:true,argumentBindings:{id:'record-1'}};
  return {page:{url:'https://example.test/form',title:'Form'},nodes:[{ref:rootRef,kind:'form',name:'Edit record',children:[fieldRef],actions:[binding]},{ref:fieldRef,kind:'field',name:'Title',field:{controlType:'text',value:model.value}}],activeDialogRef:null,coverage:{status:'complete',issues:[],truncated:false,nextCursor:null},bindings:[{binding,guardRefs:[rootRef,fieldRef],targetIdentity:rootRef,actionIdentity:actionIdentity('save')!}]};
 }});
 runtime.connect();await until(()=>app.broker.listSessions().length===1&&runtime.isConnected());
 const observe=async()=>{const overview=await runtime.observe();const region=overview.nodes.find(node=>node.kind==='form')!.ref;const snapshot=await runtime.observe({detail:'region',regionRef:region});currentSnapshot=snapshot.snapshotId;const binding=snapshot.nodes.flatMap(node=>node.actions??[]).find(binding=>binding.action==='save')!;assert.equal(binding.callable,true);return {snapshotId:snapshot.snapshotId,bindingRef:binding.ref};};
 const settled=async(id:string)=>{await until(()=>['succeeded','failed','cancelled','rejected'].includes(app.broker.getOperation(id).status));return app.broker.getOperation(id);};
 return {runtime,app,url,model,tools,observe,settled};
}

test('runtime live observations register callable evidence; state changes during visual preparation refuse without effects',async t=>{
 const f=await fixture(t);const observation=await f.observe();
 let release!:()=>void;let preparing=false;
 f.runtime.addBeforeExecuteHook(()=>{preparing=true;return new Promise<void>(resolve=>{release=resolve;});});
 const operation=await f.runtime.invoke('save',{id:'record-1'},'保存当前记录','visual-race',{observation});
 await until(()=>preparing);f.model.value='human changed draft';release();
 const result=await f.settled(operation.id);assert.equal(result.errorCode,'CONTEXT_CHANGED');assert.equal(result.effect,'not_started');assert.equal(f.model.effects,0);
 assert.equal(f.app.broker.invoke({sessionId:'page-test',action:'save',arguments:{id:'record-1'},intent:'保存当前记录',requestId:'visual-race',observation}).id,operation.id);
});

test('final guard follows synchronous executing subscribers and approval waits',async t=>{
 const f=await fixture(t,{risk:'high'});const observation=await f.observe();
 const operation=await f.runtime.invoke('save',{id:'record-1'},'保存批准的记录','approval-race',{observation});assert.equal(operation.status,'waiting_approval');
 f.runtime.subscribe(event=>{if(event.type==='execution'&&event.phase==='executing')f.model.value='subscriber changed draft';});
 f.app.broker.approve(operation.id,'test-human-only');const result=await f.settled(operation.id);
 assert.equal(result.errorCode,'CONTEXT_CHANGED');assert.equal(result.effect,'not_started');assert.equal(f.model.effects,0);
});

test('page callback result never exposes hidden fields in operation or runtime history after execution',async t=>{
 const f=await fixture(t,{result:{outcome:'completed',observationRequired:true,hidden:'BACKEND-SECRET'}});const observation=await f.observe();
 const operation=await f.runtime.invoke('save',{id:'record-1'},'保存页面记录','invalid-result',{observation});const result=await f.settled(operation.id);
 assert.equal(result.errorCode,'ACTION_RESULT_CONTRACT_VIOLATION');assert.equal(result.effect,undefined);assert.equal(f.model.effects,1);
 assert.equal(JSON.stringify(result).includes('BACKEND-SECRET'),false);assert.equal(JSON.stringify(f.runtime.getOperations()).includes('BACKEND-SECRET'),false);
});

test('observation expiry precedes new calls but does not change idempotent original retries or accepted approvals',async t=>{
 const f=await fixture(t,{risk:'high'});const observation=await f.observe();
 const input={sessionId:'page-test',action:'save',arguments:{id:'record-1'},intent:'保存当前表单',requestId:'ttl',observation};const op=f.app.broker.invoke(input);
 const now=Date.now();t.mock.method(Date,'now',()=>now+300_001);
 assert.equal(f.app.broker.invoke(input).id,op.id);
 assert.throws(()=>f.app.broker.invoke({...input,requestId:'new'}),code('OBSERVATION_EXPIRED'));
 t.mock.restoreAll();
 // Evict the original snapshot while the operation retains its copied evidence.
 for(let n=0;n<65;n++)await f.runtime.observe();
 f.app.broker.approve(op.id,'test-human-only');assert.equal((await f.settled(op.id)).status,'succeeded');assert.equal(f.model.effects,1);
});

test('native WebMCP observation and business tools use broker evidence and reject stale or guessed bindings',async t=>{
 const f=await fixture(t,{native:true});const tool=f.tools.get('clearact.page.observe');assert.ok(tool);
 const overview=await tool.execute({});const regionRef=overview.nodes.find((node:any)=>node.kind==='form').ref;
 const snapshot=await tool.execute({detail:'region',regionRef});const binding=snapshot.nodes.flatMap((node:any)=>node.actions??[]).find((binding:any)=>binding.action==='save');
 const save=f.tools.get('save');await assert.rejects(save.execute({intent:'保存当前表单',arguments:{id:'record-1'}}),code('OBSERVATION_REQUIRED'));
 assert.deepEqual(await save.execute({intent:'保存已观察表单',arguments:{id:'record-1'},observation:{snapshotId:snapshot.snapshotId,bindingRef:binding.ref}}),{outcome:'completed',observationRequired:true});
 f.model.value='changed';await assert.rejects(save.execute({intent:'保存当前表单',arguments:{id:'record-1'},observation:{snapshotId:snapshot.snapshotId,bindingRef:binding.ref}}),(error:any)=>error.code==='CONTEXT_CHANGED'&&error.effect==='not_started');
 assert.equal(f.model.effects,1);
});

test('MCP four-tool contract exposes live page regions and structured binding refusal',async t=>{
 const f=await fixture(t);const client=new Client({name:'page-test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',fileURLToPath(new URL('../../mcp/src/cli.ts',import.meta.url))],env:{...process.env as Record<string,string>,CLEARACT_SERVER_URL:f.url,CLEARACT_SESSION_ID:'page-test'},stderr:'pipe'});
 t.after(()=>client.close());await client.connect(transport);
 assert.equal((await client.listTools()).tools.length,4);
 const parsed=(result:any)=>JSON.parse(result.content.find((item:any)=>item.type==='text').text);
 const overview=parsed(await client.callTool({name:'get_context',arguments:{sessionId:'page-test'}}));const regionRef=overview.nodes.find((node:any)=>node.kind==='form').ref;
 const snapshot=parsed(await client.callTool({name:'get_context',arguments:{sessionId:'page-test',detail:'region',regionRef}}));
 assert.equal(snapshot.nodes.find((node:any)=>node.kind==='field').field.value,'visible draft');assert.equal('evidence' in snapshot,false);
 const failed=await client.callTool({name:'invoke_action',arguments:{sessionId:'page-test',action:'save',arguments:{id:'record-1'},intent:'save current',requestId:'mcp-missing'}});
 assert.equal(failed.isError,true);assert.equal(parsed(failed).code,'OBSERVATION_REQUIRED');
 const binding=snapshot.nodes.flatMap((node:any)=>node.actions??[]).find((binding:any)=>binding.action==='save');
 const observation={snapshotId:snapshot.snapshotId,bindingRef:binding.ref};
 const invoked=await client.callTool({name:'invoke_action',arguments:{sessionId:'page-test',action:'save',arguments:{id:'record-1'},intent:'保存已观察表单',requestId:'mcp-valid',observation}});
 assert.notEqual(invoked.isError,true);assert.equal(parsed(invoked).status,'succeeded');assert.deepEqual(parsed(invoked).result,{outcome:'completed',observationRequired:true});assert.equal(f.model.effects,1);
 f.model.value='changed after MCP observation';
 const stale=await client.callTool({name:'invoke_action',arguments:{sessionId:'page-test',action:'save',arguments:{id:'record-1'},intent:'保存当前表单',requestId:'mcp-stale',observation}});
 assert.equal(parsed(stale).errorCode,'CONTEXT_CHANGED');assert.equal(parsed(stale).effect,'not_started');assert.equal(f.model.effects,1);
});

test('focused binding observations cross native WebMCP, MCP and broker schema boundaries',async t=>{
 const f=await fixture(t,{native:true});
 const native=f.tools.get('clearact.page.observe');
 assert.ok(native.inputSchema.properties.bindingRef);
 const broad=await native.execute({});
 const binding=broad.nodes.flatMap((node:any)=>node.actions??[])[0];
 const options={detail:'region',regionRef:binding.targetRef,bindingRef:binding.ref,limit:500};
 const focused=await native.execute(options);
 assert.equal(focused.nodes.flatMap((node:any)=>node.actions??[])[0].callable,true);
 const client=new Client({name:'focus-test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',fileURLToPath(new URL('../../mcp/src/cli.ts',import.meta.url))],env:{...process.env as Record<string,string>,CLEARACT_SERVER_URL:f.url,CLEARACT_SESSION_ID:'page-test'},stderr:'pipe'});
 t.after(()=>client.close());await client.connect(transport);
 const tool=(await client.listTools()).tools.find(tool=>tool.name==='get_context')!;
 assert.ok(tool.inputSchema.properties?.bindingRef);
 const result=await client.callTool({name:'get_context',arguments:{sessionId:'page-test',...options}});
 assert.notEqual(result.isError,true);
 const snapshot=JSON.parse((result.content as any[])[0].text);
 assert.equal(snapshot.nodes.find((node:any)=>node.kind==='field').field.value,'visible draft');
 const action=snapshot.nodes.flatMap((node:any)=>node.actions??[])[0];
 assert.equal(action.callable,true);
 const operation=await f.runtime.invoke('save',{id:'record-1'},'Save the observed form','focused-save',{observation:{snapshotId:snapshot.snapshotId,bindingRef:action.ref}});
 assert.equal((await f.settled(operation.id)).status,'succeeded');assert.equal(f.model.effects,1);
 for(const invalid of [{bindingRef:binding.ref},{...options,bindingRef:''},{...options,bindingRef:42}]) {
  const response=await fetch(f.url+'/api/observe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'page-test',...invalid})});
  assert.equal(response.ok,false);
 }
});


test('page cancellation after callback entry retains the real result and never claims not_started',async t=>{
 let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
 const f=await fixture(t,{hold});t.after(release);const observation=await f.observe();
 const op=await f.runtime.invoke('save',{id:'record-1'},'保存当前表单','page-inflight-cancel',{observation});
 await until(()=>f.model.effects===1);await f.runtime.stop();release();const result=await f.settled(op.id);
 assert.equal(result.status,'succeeded');assert.equal(result.cancelRequested,true);assert.equal(result.effect,undefined);assert.equal(f.model.effects,1);
});


test('reusing a PageError in a later business callback cannot inherit an earlier not_started classification',async t=>{
 const error=new PageError('CONTEXT_CHANGED');const f=await fixture(t,{throwError:error});
 let observation=await f.observe();f.model.captureError=error;
 const rejected=await f.runtime.invoke('save',{id:'record-1'},'保存当前表单','reused-error-before',{observation});
 assert.equal((await f.settled(rejected.id)).effect,'not_started');assert.equal(f.model.effects,0);
 f.model.captureError=undefined;observation=await f.observe();
 const executed=await f.runtime.invoke('save',{id:'record-1'},'保存当前表单','reused-error-after',{observation});
 const result=await f.settled(executed.id);assert.equal(f.model.effects,1);assert.equal(result.effect,undefined);
});
