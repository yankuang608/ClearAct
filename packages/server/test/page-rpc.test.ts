import test from 'node:test';
import assert from 'node:assert/strict';
import {ClearActBroker} from '../src/broker.ts';
const page={contextMode:'page' as const,documentId:'doc-1',capabilities:{pageObservation:'1.0'}};
const code=(expected:string)=>(error:any)=>error?.code===expected;
function result(request:any,id:string){return {type:'observation_result',requestId:request.requestId,documentId:'doc-1',snapshot:{schemaVersion:'1.0',sessionId:'page',documentId:'doc-1',snapshotId:id,capturedAt:'2026-10-19T01:00:00Z',page:{url:'https://test.local/',title:'Presented'},scope:{ref:'page-ref',detail:'overview'},activeDialogRef:null,nodes:[{ref:'page-ref',kind:'page',children:[]}],coverage:{status:'complete',issues:[],truncated:false,nextCursor:null}},evidence:{documentId:'doc-1',snapshotId:id,bindings:[]}};}

test('concurrent observations are correlated and foreign/late documents cannot consume another response',async t=>{
 const broker=new ClearActBroker('test-only');t.after(()=>broker.close());const sent:any[]=[];
 broker.register('page',[],{},m=>sent.push(m),'owner',true,page);
 const a=broker.observe('page'),b=broker.observe('page');const requests=sent.filter(m=>m.type==='observe');
 assert.throws(()=>broker.observationResult('page','foreign',result(requests[0],'foreign')),code('PAGE_DISCONNECTED'));
 assert.throws(()=>broker.observationResult('page','owner',{...result(requests[0],'wrong-document'),documentId:'doc-0'}),code('PAGE_DISCONNECTED'));
 broker.observationResult('page','owner',result(requests[1],'second'));
 broker.observationResult('page','owner',result(requests[0],'first'));
 assert.equal((await a).snapshotId,'first');assert.equal((await b).snapshotId,'second');
 assert.throws(()=>broker.observationResult('page','owner',result(requests[0],'late')),code('PAGE_DISCONNECTED'));
});

test('observation timeout and malformed responses never return prior public state',async t=>{
 const broker=new ClearActBroker('test-only',{observationTimeoutMs:20});t.after(()=>broker.close());const sent:any[]=[];
 broker.register('page',[],{},m=>sent.push(m),'owner',true,page);
 const good=broker.observe('page');broker.observationResult('page','owner',result(sent.at(-1),'good'));assert.equal((await good).snapshotId,'good');
 await assert.rejects(broker.observe('page'),code('OBSERVATION_TIMEOUT'));
 const malformed=broker.observe('page');const failure=assert.rejects(malformed,code('ADAPTER_CONTRACT_VIOLATION'));
 const payload=result(sent.at(-1),'invalid');(payload.snapshot.nodes[0] as any).data={hidden:'not-a-page-fact'};
 broker.observationResult('page','owner',payload);await failure;
});

test('page-only read options validate region and node budget before dispatch',t=>{
 const broker=new ClearActBroker('test-only');t.after(()=>broker.close());const sent:any[]=[];
 broker.register('page',[],{},m=>sent.push(m),'owner',true,page);
 for(const options of [{limit:0},{limit:501},{detail:'region'},{detail:'overview',regionRef:'guess'}])assert.throws(()=>broker.observe('page',options as any));
 assert.equal(sent.filter(m=>m.type==='observe').length,0);
});


test('overview continuation cursors reach the page engine instead of being rejected as region-only options',async t=>{
 const broker=new ClearActBroker('test-only');t.after(()=>broker.close());const sent:any[]=[];
 broker.register('page',[],{},m=>sent.push(m),'owner',true,page);
 let pending:Promise<unknown>|undefined;
 assert.doesNotThrow(()=>{pending=broker.observe('page',{detail:'overview',cursor:'opaque-cursor',limit:50});});
 const failed=assert.rejects(pending!,code('STALE_CURSOR'));
 const request=sent.at(-1);assert.equal(request.type,'observe');assert.deepEqual(request.options,{detail:'overview',cursor:'opaque-cursor',limit:50});
 broker.observationResult('page','owner',{type:'observation_result',requestId:request.requestId,documentId:'doc-1',error:{code:'STALE_CURSOR',message:'protocol status'}});
 await failed;
});
