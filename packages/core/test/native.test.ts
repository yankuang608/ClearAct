import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {createClearActServer} from '../../server/src/http.ts';
import {createClearActRuntime,type ClearActAction} from '../src/index.ts';

async function nativePage(t:TestContext,action:ClearActAction,surface:'document'|'navigator'='document'){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 const previousNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
 let tool:any;
 const registeredTools=new Map<string,unknown>();
 const modelContext={registerTool(value:any,options?:{signal?:AbortSignal}){tool=value;registeredTools.set(value.name,value);options?.signal?.addEventListener('abort',()=>registeredTools.delete(value.name),{once:true});}};
 Object.defineProperty(globalThis,'document',{configurable:true,value:surface==='document'?{modelContext}:{}});
 if(surface==='navigator')Object.defineProperty(globalThis,'navigator',{configurable:true,value:{modelContext}});
 const app=createClearActServer({approvalToken:'human-test-only'});
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const runtime=createClearActRuntime({sessionId:'native-test',serverUrl:`http://127.0.0.1:${(app.server.address() as any).port}`});
 t.after(async()=>{runtime.dispose();await app.close();if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');if(surface==='navigator'){if(previousNavigator)Object.defineProperty(globalThis,'navigator',previousNavigator);else Reflect.deleteProperty(globalThis,'navigator');}});
 const unregister=runtime.registerAction(action);runtime.connect();
 for(let n=0;n<100&&!app.broker.listSessions().length;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(app.broker.listSessions().length,1);
 return {runtime,app,tool,unregister,registeredTools};
}
const action={name:'read',description:'Read actual persisted status',risk:'read' as const,inputSchema:{type:'object'}};

// Missing intent must fail before any broker operation or business effect is created.
test('native invocations require a nonempty user-facing intent before dispatch',async t=>{
 let effects=0;
 const {tool,runtime}=await nativePage(t,{...action,async execute(){effects++;return {};}});
 for(const input of [{arguments:{}},{intent:'   ',arguments:{}},{intent:'x'.repeat(2001),arguments:{}},{intent:'核对当前页面',arguments:[]}])
  await assert.rejects(tool.execute(input,{}),/intent|arguments/i);
 assert.equal(effects,0);assert.equal(runtime.getOperations().length,0);
});

// A wrapper must not overwrite an action's own intent parameter or substitute a fixed phrase.
test('native intent is recorded separately from exact business arguments',async t=>{
 const {tool,runtime}=await nativePage(t,{...action,inputSchema:{type:'object',properties:{intent:{type:'string'}},required:['intent'],additionalProperties:false},async execute(args,context){return {business:args.intent,narrative:context.intent};}});
 const narrative='先核对这条记录，为接下来的安排提供依据。';
 assert.deepEqual(await tool.execute({intent:narrative,arguments:{intent:'business value'}},{}),{business:'business value',narrative});
 assert.equal(runtime.getOperations()[0]!.intent,narrative);
 assert.deepEqual(runtime.getOperations()[0]!.arguments,{intent:'business value'});
});

// Embedding a business schema must preserve its root-local references.
test('native discovery validates the envelope without breaking business schema refs',async t=>{
 const schema={type:'object',definitions:{name:{type:'string',minLength:1}},properties:{name:{$ref:'#/definitions/name'}},required:['name'],additionalProperties:false};
 const {tool}=await nativePage(t,{...action,inputSchema:schema,async execute(args){return args;}});
 const validate=new Ajv({strict:false}).compile(tool.inputSchema);
 assert.equal(validate({intent:'核对记录名称',arguments:{name:'Atlas'}}),true);
 assert.equal(validate({intent:'核对记录名称',arguments:{name:4}}),false);
 assert.equal(validate({arguments:{name:'Atlas'}}),false);
 assert.deepEqual(await tool.execute({intent:'核对记录名称',arguments:{name:'Atlas'}},{}),{name:'Atlas'});
 assert.deepEqual(schema.properties.name,{$ref:'#/definitions/name'},'registration does not mutate the application schema');
});

test('native WebMCP callback returns the actual completed result, not dispatch acknowledgement',async(t)=>{
 let release!:(value:unknown)=>void;
 const {tool}=await nativePage(t,{...action,execute:()=>new Promise(resolve=>{release=resolve;})});
 const result=tool.execute({intent:'核对当前记录',arguments:{}},{});
 assert.equal(await Promise.race([result.then(()=> 'early'),new Promise(resolve=>setTimeout(()=>resolve('pending'),80))]),'pending');
 release({count:7});assert.deepEqual(await result,{count:7});
});

test('native high-risk call waits for independent rejection and never executes',async(t)=>{
 let effects=0;
 const {runtime,app,tool}=await nativePage(t,{...action,risk:'high',async execute(){effects++;return {};}});
 const result=tool.execute({intent:'核对当前记录',arguments:{}},{});const rejection=assert.rejects(result,/reject/i);
 for(let n=0;n<100&&!runtime.getOperations().length;n++)await new Promise(resolve=>setTimeout(resolve,5));
 const operation=runtime.getOperations()[0]!;assert.equal(operation.status,'waiting_approval');assert.equal(effects,0);
 app.broker.reject(operation.id,'human-test-only');await rejection;assert.equal(effects,0);
});

test('aborting a native wait stops waiting without claiming pending business action was rolled back',async(t)=>{
 const {runtime,app,tool}=await nativePage(t,{...action,risk:'high',async execute(){return {};}});
 const controller=new AbortController();const result=tool.execute({intent:'核对当前记录',arguments:{}},{signal:controller.signal});
 const aborted=assert.rejects(result,{name:'AbortError'});
 for(let n=0;n<100&&!runtime.getOperations().length;n++)await new Promise(resolve=>setTimeout(resolve,5));
 controller.abort();await aborted;
 assert.equal(app.broker.getOperation(runtime.getOperations()[0]!.id).status,'waiting_approval');
});

test('native high-risk approval returns the business result through navigator fallback',async(t)=>{
 let effects=0;
 const {runtime,app,tool}=await nativePage(t,{...action,risk:'high',async execute(){effects++;return {deleted:true};}},'navigator');
 const result=tool.execute({intent:'核对当前记录',arguments:{}},{});
 for(let n=0;n<100&&!runtime.getOperations().length;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(effects,0);app.broker.approve(runtime.getOperations()[0]!.id,'human-test-only');
 assert.deepEqual(await result,{deleted:true});assert.equal(effects,1);
});

test('native failed execution rejects with the business error',async(t)=>{
 const {tool}=await nativePage(t,{...action,async execute(){throw new Error('Business service unavailable');}});
 await assert.rejects(tool.execute({intent:'核对当前记录',arguments:{}},{}),/Business service unavailable/);
});

test('native unregister removes discovery without cancelling an already executing callback',async(t)=>{
 let unregisterAction=()=>{};let effects=0;
 const {runtime,app,tool,unregister,registeredTools}=await nativePage(t,{...action,risk:'write',async execute(){effects++;unregisterAction();return {updated:true};}});
 unregisterAction=unregister;
 assert.equal(registeredTools.size,1);
 assert.deepEqual(await tool.execute({intent:'核对当前记录',arguments:{}},{}),{updated:true});
 assert.equal(effects,1);assert.equal(registeredTools.size,0);
 assert.equal(app.broker.getOperation(runtime.getOperations()[0]!.id).status,'succeeded');
});

test('native dispose stops waiting and removes invocation listeners',async(t)=>{
 const {runtime,tool}=await nativePage(t,{...action,risk:'high',async execute(){return {};}});
 const signal=new AbortController().signal;
 let active=0;
 const add=signal.addEventListener.bind(signal);const remove=signal.removeEventListener.bind(signal);
 t.mock.method(signal,'addEventListener',(...args:Parameters<typeof add>)=>{if(args[0]==='abort')active++;return add(...args);});
 t.mock.method(signal,'removeEventListener',(...args:Parameters<typeof remove>)=>{if(args[0]==='abort')active--;return remove(...args);});
 const result=tool.execute({intent:'核对当前记录',arguments:{}},{signal});const aborted=assert.rejects(result,{name:'AbortError'});
 for(let n=0;n<100&&!runtime.getOperations().length;n++)await new Promise(resolve=>setTimeout(resolve,5));
 runtime.dispose();
 await aborted;assert.equal(active,0);
});

test('native pending approval rejects promptly when the page stops', async t => {
 let effects=0;
 const {runtime,app,tool}=await nativePage(t,{...action,risk:'high',async execute(){effects++;return {};}});
 const result=tool.execute({intent:'核对当前记录',arguments:{}},{});const cancelled=assert.rejects(result,/cancel/i);
 for(let n=0;n<100&&!runtime.getOperations().length;n++)await new Promise(resolve=>setTimeout(resolve,5));
 await runtime.stop();await cancelled;
 assert.equal(app.broker.getOperation(runtime.getOperations()[0]!.id).status,'cancelled');assert.equal(effects,0);
});

test('an offline page stop refuses subsequent native invocations locally', async t => {
 let effects=0;
 const {runtime,app,tool}=await nativePage(t,{...action,async execute(){effects++;return {};}});
 runtime.disconnect();
 for(let n=0;n<100&&app.broker.listSessions().length;n++)await new Promise(resolve=>setTimeout(resolve,5));
 await runtime.stop();
 let brokerInvocations=0;app.server.on('request',request=>{if(request.url==='/api/invoke')brokerInvocations++;});
 await assert.rejects(tool.execute({intent:'核对当前记录',arguments:{}},{}));
 assert.equal(brokerInvocations,0,'the stopped page must not submit another native invocation');
 assert.equal(effects,0);
});

test('native callbacks wait through queued state and return each actual result',async(t)=>{
 let release!:(value:unknown)=>void;let calls=0;
 const {runtime,app,tool}=await nativePage(t,{...action,execute:()=>{calls++;return calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({sequence:calls});}});
 runtime.setOperationIntervalMs(0);
 const first=tool.execute({intent:'核对当前记录',arguments:{}},{});
 for(let n=0;n<100&&calls<1;n++)await new Promise(resolve=>setTimeout(resolve,5));
 const second=tool.execute({intent:'核对当前记录',arguments:{}},{});
 for(let n=0;n<100&&runtime.getOperations().length<2;n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(runtime.getOperations().some(operation=>operation.status==='queued'));assert.equal(calls,1);
 release({sequence:1});assert.deepEqual(await first,{sequence:1});assert.deepEqual(await second,{sequence:2});
 assert.equal(calls,2);assert.ok(runtime.getOperations().every(operation=>app.broker.getOperation(operation.id).status==='succeeded'));
});
