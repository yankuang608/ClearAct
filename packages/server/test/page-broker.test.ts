import test from 'node:test';
import assert from 'node:assert/strict';
import {ClearActBroker} from '../src/broker.ts';

const action={name:'save',description:'Save current form',risk:'write' as const,resultMode:'page' as const,inputSchema:{type:'object'}};
const page={contextMode:'page' as const,documentId:'document-1',capabilities:{pageObservation:'1.0' as const}};
const code=(expected:string)=>(error:any)=>error?.code===expected;

test('page registration rejects legacy context/actions and exposes negotiated document capability',()=>{
 const broker=new ClearActBroker('test-only');
 try {
  assert.throws(()=> (broker.register as any)('page',[{...action,resultMode:undefined}],{},()=>{},'socket',true,page),code('PAGE_OBSERVATION_UNSUPPORTED'));
  assert.throws(()=> (broker.register as any)('page',[action],{hidden:'secret'},()=>{},'socket',true,page),code('PAGE_OBSERVATION_UNSUPPORTED'));
  (broker.register as any)('page',[action],{},()=>{},'socket',true,page);
  assert.deepEqual((broker.listSessions()[0] as any).capabilities,{pageObservation:'1.0'});
  assert.equal((broker.listSessions()[0] as any).documentId,'document-1');
  assert.throws(()=>broker.invoke({sessionId:'page',action:'save',arguments:{},intent:'保存页面表单',requestId:'r1'}),code('OBSERVATION_REQUIRED'));
 } finally {broker.close();}
});

test('page reads request live observations with distinct correlation IDs and disconnect rejects without cached fallback',async()=>{
 const broker=new ClearActBroker('test-only');const sent:any[]=[];
 try {
  (broker.register as any)('page',[action],{},(m:any)=>sent.push(m),'socket',true,page);
  const a=(broker as any).observe('page');const b=(broker as any).getContext('page');
  const rejectedA=assert.rejects(a,code('PAGE_DISCONNECTED'));const rejectedB=assert.rejects(b,code('PAGE_DISCONNECTED'));
  const reads=sent.filter(m=>m.type==='observe');assert.equal(reads.length,2);
  assert.notEqual(reads[0].requestId,reads[1].requestId);
  broker.unregister('page','socket');await Promise.all([rejectedA,rejectedB]);
  assert.throws(()=>broker.getContext('page'),code('PAGE_DISCONNECTED'));
  assert.throws(()=>(broker as any).observe('page'),code('PAGE_DISCONNECTED'));
 } finally {broker.close();}
});

test('legacy sessions explicitly reject page-only reads and observation arguments',()=>{
 const broker=new ClearActBroker('test-only');
 try {
  broker.register('old',[action],{message:'cached'},()=>{},'legacy');
  assert.deepEqual(broker.getContext('old'),{message:'cached'});
  assert.throws(()=>(broker.getContext as any)('old',{detail:'overview'}),code('PAGE_OBSERVATION_UNSUPPORTED'));
  assert.throws(()=>broker.invoke({sessionId:'old',action:'save',arguments:{},intent:'save',requestId:'r',observation:{snapshotId:'guess',bindingRef:'guess'}} as any),code('PAGE_OBSERVATION_UNSUPPORTED'));
 } finally {broker.close();}
});
