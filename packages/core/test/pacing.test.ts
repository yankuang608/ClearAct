import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {OperationPacer} from '../src/pacing.ts';
import {createClearActRuntime} from '../src/index.ts';

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function deferred<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('pacer keeps callbacks serial even at zero interval',async()=>{
 const pacer=new OperationPacer(0);const hold=deferred();const started=deferred();const order:string[]=[];
 const first=pacer.run(async()=>{order.push('first-start');started.resolve();await hold.promise;order.push('first-end');});
 const second=pacer.run(async()=>{order.push('second');});
 await started.promise;await sleep(10);assert.deepEqual(order,['first-start']);
 hold.resolve();await Promise.all([first,second]);assert.deepEqual(order,['first-start','first-end','second']);
});

test('pacer measures the minimum interval at actual callback starts',async()=>{
 const pacer=new OperationPacer(45);const starts:number[]=[];
 await Promise.all(Array.from({length:3},()=>pacer.run(async()=>{starts.push(performance.now());})));
 assert.equal(starts.length,3);
 assert.ok(starts[1]-starts[0]>=45);assert.ok(starts[2]-starts[1]>=45);
});

test('a slow callback does not add another whole interval after completion',async()=>{
 const pacer=new OperationPacer(40);const hold=deferred();const started=deferred();let end=0;let next=0;
 const first=pacer.run(async()=>{started.resolve();await hold.promise;end=performance.now();});
 const second=pacer.run(async()=>{next=performance.now();});
 await started.promise;await sleep(60);hold.resolve();await Promise.all([first,second]);
 assert.ok(next>=end);assert.ok(next-end<35,'a completed slow callback should not restart a 40ms cooldown');
});

test('reducing the interval wakes an operation already waiting to start',async()=>{
 const pacer=new OperationPacer(5000);await pacer.run(async()=>{});let started=false;
 const next=pacer.run(async()=>{started=true;});await sleep(15);assert.equal(started,false);
 pacer.setInterval(0);await Promise.race([next,sleep(100).then(()=>{throw new Error('old timer was not woken');})]);assert.equal(started,true);
});

test('increasing the interval rechecks the original start timestamp',async()=>{
 const pacer=new OperationPacer(50);let first=0;let next=0;
 await pacer.run(async()=>{first=performance.now();});const pending=pacer.run(async()=>{next=performance.now();});
 await sleep(10);pacer.setInterval(90);await pending;assert.ok(next-first>=90);
});

test('cancelling a queued callback does not release an unfinished execution lock',async()=>{
 const pacer=new OperationPacer(0);const hold=deferred();const started=deferred();const abort=new AbortController();let thirdStarted=false;
 const first=pacer.run(async()=>{started.resolve();await hold.promise;});
 const second=pacer.run(async()=>{throw new Error('cancelled callback ran');},abort.signal);const rejected=assert.rejects(second,/cancel|abort/i);
 await started.promise;abort.abort(new Error('Operation cancelled'));await rejected;
 const third=pacer.run(async()=>{thirdStarted=true;});await sleep(10);assert.equal(thirdStarted,false);
 hold.resolve();await Promise.all([first,third]);
});

test('a callback failure releases the actual execution lock',async()=>{
 const pacer=new OperationPacer(0);const first=pacer.run(async()=>{throw new Error('Business failure');});
 const second=pacer.run(async()=>42);await assert.rejects(first,/Business failure/);assert.equal(await second,42);
});

test('runtime validates its interval and emits changes without mutating initial options',()=>{
 const runtime=createClearActRuntime({sessionId:'pacing-options',serverUrl:'http://localhost:1',operationIntervalMs:500});
 const changes:number[]=[];runtime.subscribe(event=>{if(event.type==='interval')changes.push(event.operationIntervalMs!);});
 assert.equal(runtime.getOperationIntervalMs(),500);runtime.setOperationIntervalMs(1000);runtime.setOperationIntervalMs(1000);
 assert.equal(runtime.getOperationIntervalMs(),1000);assert.equal(runtime.options.operationIntervalMs,500);assert.deepEqual(changes,[1000]);
 for(const invalid of [-1,5001,NaN,Infinity,1.5])assert.throws(()=>runtime.setOperationIntervalMs(invalid),/interval/i);
 runtime.dispose();assert.throws(()=>runtime.setOperationIntervalMs(0),/disposed/i);
});

test('runtime serializes actual WebSocket callbacks and cancels stale registrations',async(t)=>{
 const server=new WebSocketServer({port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
 const runtime=createClearActRuntime({sessionId:'pacing-runtime',serverUrl:`http://127.0.0.1:${(server.address() as any).port}`,operationIntervalMs:0});
 t.after(()=>{runtime.dispose();for(const socket of server.clients)socket.terminate();server.close();});
 const hold=deferred();const started=deferred();let active=0;let peak=0;const names:string[]=[];
 const unregister=runtime.registerAction({name:'work',description:'Work',risk:'write',inputSchema:{type:'object'},async execute(args){active++;peak=Math.max(peak,active);names.push(String(args.id));if(args.id===1){started.resolve();await hold.promise;}active--;return args;}});
 const connected=new Promise<any>(resolve=>server.once('connection',resolve));runtime.connect();const socket=await connected;
 await new Promise<void>(resolve=>socket.once('message',()=>resolve()));
 const results:any[]=[];socket.on('message',(data:any)=>{const m=JSON.parse(String(data));if(m.type==='result')results.push(m);});
 const send=(id:number)=>socket.send(JSON.stringify({type:'execute',operationId:String(id),action:'work',arguments:{id}}));
 send(1);send(2);await started.promise;await sleep(10);assert.deepEqual(names,['1']);
 unregister();runtime.registerAction({name:'work',description:'Replacement work',risk:'write',inputSchema:{type:'object'},async execute(){names.push('replacement');return {};}});
 hold.resolve();for(let i=0;i<100&&results.length<2;i++)await sleep(5);
 assert.equal(peak,1);assert.deepEqual(names,['1']);assert.equal(results.length,2);assert.match(results.find(m=>m.operationId==='2').error,/changed|available|unregistered/i);
});

test('reconnecting preserves the running callback lock and current interval',async(t)=>{
 const server=new WebSocketServer({port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
 const runtime=createClearActRuntime({sessionId:'pacing-reconnect',serverUrl:`http://127.0.0.1:${(server.address() as any).port}`,operationIntervalMs:0});
 const hold=deferred();t.after(()=>{hold.resolve();runtime.dispose();for(const socket of server.clients)socket.terminate();server.close();});
 const started=deferred();const names:number[]=[];
 runtime.registerAction({name:'work',description:'Work',risk:'write',inputSchema:{type:'object'},async execute(args){names.push(Number(args.id));if(args.id===1){started.resolve();await hold.promise;}return args;}});
 const connect=async()=>{const next=new Promise<any>(resolve=>server.once('connection',resolve));runtime.connect();const socket=await next;await new Promise<void>(resolve=>socket.once('message',()=>resolve()));return socket;};
 const send=(socket:any,id:number)=>socket.send(JSON.stringify({type:'execute',operationId:String(id),action:'work',arguments:{id}}));
 const original=await connect();send(original,1);send(original,2);await started.promise;
 runtime.setOperationIntervalMs(1);runtime.disconnect();const replacement=await connect();
 assert.equal(runtime.getOperationIntervalMs(),1);send(replacement,3);await sleep(15);assert.deepEqual(names,[1]);
 const result=new Promise<any>(resolve=>replacement.on('message',(data:any)=>{const message=JSON.parse(String(data));if(message.type==='result')resolve(message);}));
 hold.resolve();assert.equal((await result).operationId,'3');assert.deepEqual(names,[1,3]);
});

test('an expired command never enters the action callback',async()=>{
 const runtime=createClearActRuntime({sessionId:'expired',serverUrl:'http://localhost:1',operationIntervalMs:0});let calls=0;
 runtime.registerAction({name:'work',description:'Work',risk:'write',inputSchema:{type:'object'},async execute(){calls++;return {};}});
 await assert.rejects(()=>(runtime as any).execute({operationId:'expired',action:'work',arguments:{},expiresAt:Date.now()-1}),/expired/i);
 assert.equal(calls,0);runtime.dispose();
});

test('runtime anchors the interval after execution guards and before the actual callback',async()=>{
 const runtime=createClearActRuntime({sessionId:'start-boundary',serverUrl:'http://localhost:1',operationIntervalMs:40});const starts:number[]=[];
 runtime.registerAction({name:'work',description:'Work',risk:'write',inputSchema:{type:'object'},async execute(){starts.push(performance.now());return {};}});
 const first:any={operationId:'first-boundary',action:'work',arguments:{}};
 Object.defineProperty(first,'expiresAt',{get(){const end=performance.now()+30;while(performance.now()<end){};return Date.now()+60_000;}});
 await Promise.all([(runtime as any).execute(first),(runtime as any).execute({operationId:'second-boundary',action:'work',arguments:{}})]);
 assert.ok(starts[1]-starts[0]>=40,`actual callback start delta was ${starts[1]-starts[0]}ms`);runtime.dispose();
});

test('runtime serializes visual preparation with actual callbacks and settled events',async t=>{
 const server=new WebSocketServer({port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
 const runtime=createClearActRuntime({sessionId:'paced-cursor',serverUrl:`http://127.0.0.1:${(server.address() as any).port}`,operationIntervalMs:80});
 t.after(()=>{runtime.dispose();for(const socket of server.clients)socket.terminate();server.close();});
 const order:string[]=[];const starts:number[]=[];
 runtime.addBeforeExecuteHook(async operation=>{order.push('prepare-'+operation.id);await sleep(operation.id==='1'?100:10);});
 runtime.subscribe(event=>{if(event.type==='execution'&&event.phase==='settled')order.push('settled-'+event.operation!.id);});
 runtime.registerAction({name:'work',description:'Ordered visual work',risk:'write',inputSchema:{type:'object'},async execute(_args,context){order.push('work-'+context.operationId);starts.push(performance.now());return {};}});
 const connected=new Promise<any>(resolve=>server.once('connection',resolve));runtime.connect();const socket=await connected;
 await new Promise<void>(resolve=>socket.once('message',()=>resolve()));
 const results:any[]=[];socket.on('message',(data:any)=>{const message=JSON.parse(String(data));if(message.type==='result')results.push(message);});
 for(const id of ['1','2'])socket.send(JSON.stringify({type:'execute',operationId:id,action:'work',arguments:{}}));
 for(let attempt=0;attempt<200&&results.length<2;attempt++)await sleep(5);
 assert.equal(results.length,2);
 assert.deepEqual(order,['prepare-1','work-1','settled-1','prepare-2','work-2','settled-2']);
 assert.ok(starts[1]-starts[0]>=80,'visual travel must not compress the actual callback interval');
});

test('a pacing change during visual preparation applies before actual execution',async()=>{
 const pacer=new OperationPacer(20);let first=0,next=0;
 await pacer.run(async()=>{first=performance.now();});
 const preparing=deferred();const release=deferred();
 const pending=pacer.run(async()=>{next=performance.now();},undefined,undefined,async()=>{preparing.resolve();await release.promise;});
 await Promise.race([preparing.promise,sleep(200).then(()=>{throw new Error('visual preparation was skipped');})]);pacer.setInterval(100);await sleep(25);release.resolve();await pending;
 assert.ok(next-first>=100,'the current interval must be re-read after preparation');
});
