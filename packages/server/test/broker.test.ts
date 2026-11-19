import test from 'node:test';
import assert from 'node:assert/strict';
import { ClearActBroker } from '../src/broker.ts';
import type { ClearActActionMetadata } from '../../core/src/types.ts';

const action: ClearActActionMetadata = {name:'delete_card',description:'Delete exactly one card',risk:'high',inputSchema:{type:'object',properties:{cardId:{type:'string'}},required:['cardId'],additionalProperties:false}};
function fixture() {const sent: any[]=[]; const broker=new ClearActBroker('human-secret'); broker.register('kan',[action],{},m=>sent.push(m),'socket-1'); return {broker,sent};}
const invocation={sessionId:'kan',action:'delete_card',arguments:{cardId:'card-1'},intent:'User requested deletion',requestId:'request-1'};

test('high risk is not dispatched until approved and credentials never enter operations',()=>{
 const {broker,sent}=fixture(); const op=broker.invoke(invocation);
 assert.equal(op.status,'waiting_approval'); assert.equal(sent.filter(x=>x.type==='execute').length,0);
 assert.throws(()=>broker.approve(op.id,'agent-token'),/approval/i);
 broker.approve(op.id,'human-secret'); broker.approve(op.id,'human-secret');
 const executions=sent.filter(x=>x.type==='execute'); assert.equal(executions.length,1);
 assert.ok(executions[0].executionToken); assert.equal(JSON.stringify(broker.getOperation(op.id)).includes(executions[0].executionToken),false);
 assert.equal(JSON.stringify(sent.filter(x=>x.type==='event')).includes(executions[0].executionToken),false);
});
test('rejection never dispatches and cannot later be approved',()=>{
 const {broker,sent}=fixture(); const op=broker.invoke(invocation); broker.reject(op.id,'human-secret');
 assert.equal(broker.getOperation(op.id).status,'rejected'); assert.throws(()=>broker.approve(op.id,'human-secret'));
 assert.equal(sent.filter(x=>x.type==='execute').length,0);
});
test('invalid arguments and conflicting duplicate request IDs are rejected',()=>{
 const {broker}=fixture(); assert.throws(()=>broker.invoke({...invocation,arguments:{cardId:4}}),/argument/i);
 const op=broker.invoke(invocation); assert.equal(broker.invoke(invocation).id,op.id);
 assert.throws(()=>broker.invoke({...invocation,arguments:{cardId:'card-2'}}),/requestId/i);
});
test('execution capability is bound to parameters and consumed exactly once',()=>{
 const {broker,sent}=fixture(); const op=broker.invoke(invocation); broker.approve(op.id,'human-secret');
 const {executionToken}=sent.find(x=>x.type==='execute');
 const binding={operationId:op.id,sessionId:'kan',action:'delete_card',arguments:{cardId:'card-1'}};
 assert.throws(()=>broker.verifyExecution(executionToken,{...binding,arguments:{cardId:'card-2'}}));
 assert.equal(broker.verifyExecution(executionToken,binding).valid,true);
 assert.throws(()=>broker.verifyExecution(executionToken,binding),/consumed|invalid/i);
 broker.result('kan','socket-1',op.id,{deleted:true}); assert.equal(broker.getOperation(op.id).status,'succeeded');
});
test('changed action registration invalidates pending approval',()=>{
 const {broker,sent}=fixture(); const op=broker.invoke(invocation);
 broker.register('kan',[{...action,description:'Changed business semantics'}],{},m=>sent.push(m),'socket-1');
 assert.throws(()=>broker.approve(op.id,'human-secret'),/changed/i);
 assert.equal(sent.filter(x=>x.type==='execute').length,0);
});
test('reconnecting page receives failed pending-operation state instead of stale approval',()=>{
 const {broker}=fixture();const op=broker.invoke(invocation);broker.unregister('kan','socket-1');
 const replay:any[]=[];broker.register('kan',[action],{},m=>replay.push(m),'socket-2');
 assert.equal(replay.find(m=>m.type==='event'&&m.operation.id===op.id)?.operation.status,'failed');
 assert.equal(replay.some(m=>m.type==='execute'),false);
});

test('approval expires into a replayable failed state without dispatch',async(t)=>{
 const sent:any[]=[];const broker=new ClearActBroker('human-secret',{approvalTimeoutMs:20});
 t.after(()=>broker.close());
 broker.register('kan',[action],{},m=>sent.push(m),'socket-1');
 const op=broker.invoke(invocation);
 await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(sent.filter(m=>m.type==='event').at(-1).operation.status,'failed');
 assert.match(broker.getOperation(op.id).error??'',/approval expired/i);
 assert.equal(broker.approve(op.id,'human-secret').status,'failed');
 assert.equal(sent.some(m=>m.type==='execute'),false);
 assert.equal(broker.invoke(invocation).id,op.id);
});

test('execution timeout invalidates capability and rejects a late result',async(t)=>{
 const sent:any[]=[];const broker=new ClearActBroker('human-secret',{executionTimeoutMs:20});
 t.after(()=>broker.close());
 broker.register('kan',[action],{},m=>sent.push(m),'socket-1');
 const op=broker.invoke(invocation);broker.approve(op.id,'human-secret');
 const execution=sent.find(m=>m.type==='execute');
 await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(sent.filter(m=>m.type==='event').at(-1).operation.status,'failed');
 assert.match(broker.getOperation(op.id).error??'',/timed out/i);
 assert.throws(()=>broker.verifyExecution(execution.executionToken,{operationId:op.id,sessionId:'kan',action:action.name,arguments:invocation.arguments}));
 assert.throws(()=>broker.result('kan','socket-1',op.id,{deleted:true}),/unexpected/i);
 assert.equal(broker.getOperation(op.id).status,'failed');
});

test('failed event delivery cannot prevent execution or leave dispatch failure executing',t=>{
 const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());let executions=0;
 broker.register('kan',[{...action,risk:'write'}],{},message=>{
  if(message.type==='event')throw new Error('Observer unavailable');
  if(message.type==='execute')executions++;
 },'socket-1');
 const op=broker.invoke(invocation);assert.equal(executions,1);assert.equal(op.status,'executing');
 broker.result('kan','socket-1',op.id,{deleted:true});assert.equal(broker.getOperation(op.id).status,'succeeded');
 broker.register('kan',[{...action,risk:'write'}],{},message=>{
  if(message.type!=='registered')throw new Error('Transport unavailable');
 },'socket-1');
 const failed=broker.invoke({...invocation,requestId:'dispatch-failure'});
 assert.equal(failed.status,'failed');assert.match(failed.error??'',/dispatch failed/i);
});

test('deadline is enforced even before the event-loop timeout callback runs',t=>{
 const sent:any[]=[];const broker=new ClearActBroker('human-secret',{executionTimeoutMs:1_000});
 t.after(()=>broker.close());broker.register('kan',[action],{},m=>sent.push(m),'socket-1');
 const op=broker.invoke(invocation);broker.approve(op.id,'human-secret');
 const now=Date.now();t.mock.method(Date,'now',()=>now+1_001);
 assert.throws(()=>broker.result('kan','socket-1',op.id,{deleted:true}),/unexpected/i);
 assert.equal(broker.getOperation(op.id).status,'failed');
});

test('duplicate sessions cannot replace the owner and disconnect invalidates its capability',t=>{
 const {broker,sent}=fixture();t.after(()=>broker.close());
 assert.throws(()=>broker.register('kan',[action],{},()=>{},'socket-2'),/already connected/i);
 broker.unregister('kan','socket-2');assert.equal(broker.listSessions().length,1);
 const op=broker.invoke(invocation);broker.approve(op.id,'human-secret');
 const execution=sent.find(m=>m.type==='execute');broker.unregister('kan','socket-1');
 assert.equal(broker.getOperation(op.id).status,'failed');
 assert.throws(()=>broker.verifyExecution(execution.executionToken,{operationId:op.id,sessionId:'kan',action:action.name,arguments:invocation.arguments}));
 const replay:any[]=[];broker.register('kan',[action],{},m=>replay.push(m),'socket-2');
 assert.equal(replay.find(m=>m.type==='event').operation.status,'failed');
 assert.equal(replay.some(m=>m.type==='execute'),false);
 assert.throws(()=>broker.result('kan','socket-1',op.id,{deleted:true}),/unexpected/i);
});

test('capability binding and idempotency ignore object key order but not nested values',t=>{
 const sent:any[]=[];const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());
 broker.register('kan',[{...action,inputSchema:{type:'object'}}],{},m=>sent.push(m),'socket-1');
 const args={cardId:'card-1',settings:{x:1,y:2}};
 const op=broker.invoke({...invocation,arguments:args});
 assert.equal(broker.invoke({...invocation,arguments:{settings:{y:2,x:1},cardId:'card-1'}}).id,op.id);
 assert.throws(()=>broker.invoke({...invocation,arguments:{...args,settings:{x:1,y:3}}}),/requestId/i);
 broker.approve(op.id,'human-secret');const execution=sent.find(m=>m.type==='execute');
 assert.throws(()=>broker.verifyExecution(execution.executionToken,{operationId:op.id,sessionId:'kan',action:action.name,arguments:{...args,settings:{x:1,y:3}}}));
 assert.equal(broker.verifyExecution(execution.executionToken,{operationId:op.id,sessionId:'kan',action:action.name,arguments:{settings:{y:2,x:1},cardId:'card-1'}}).valid,true);
 broker.close();assert.equal(broker.getOperation(op.id).status,'failed');assert.equal(broker.listSessions().length,0);
});

test('result ACK follows authoritative in-memory completion on the original connection only',t=>{
 const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());const acks:string[]=[];
 broker.register('kan',[{...action,risk:'write'}],{},message=>{
  if(message.type==='result_ack'){
   assert.equal(broker.getOperation(String(message.operationId)).status,'succeeded');
   acks.push(String(message.operationId));
  }
 },'socket-1');
 const op=broker.invoke(invocation);assert.deepEqual(acks,[]);
 assert.throws(()=>broker.result('kan','socket-2',op.id,{saved:true}),/unexpected/i);
 broker.result('kan','socket-1',op.id,{saved:true});assert.deepEqual(acks,[op.id]);
 assert.throws(()=>broker.result('kan','socket-1',op.id,{saved:true}),/unexpected/i);assert.equal(acks.length,1);
 const failed=broker.invoke({...invocation,requestId:'failed-result'});broker.result('kan','socket-1',failed.id,undefined,'native save failed');assert.equal(acks.length,1);
 const disconnected=broker.invoke({...invocation,requestId:'disconnected-result'});broker.unregister('kan','socket-1');
 broker.register('kan',[{...action,risk:'write'}],{},message=>{if(message.type==='result_ack')throw new Error('must not acknowledge old result');},'socket-2');
 assert.throws(()=>broker.result('kan','socket-1',disconnected.id,{saved:true}),/unexpected/i);assert.equal(broker.getOperation(disconnected.id).status,'failed');
});

test('page stop cancels approval, invalidates unused capabilities and persists across reconnect', t => {
 const {broker, sent} = fixture(); t.after(() => broker.close());
 const pending = broker.invoke(invocation);
 const executing = broker.invoke({...invocation, requestId:'approved-before-stop'}); broker.approve(executing.id, 'human-secret');
 const token = sent.find(message => message.type === 'execute').executionToken;
 assert.throws(() => broker.control('kan', 'foreign-socket', false), /connection|page/i);
 broker.control('kan', 'socket-1', false);
 assert.equal(broker.getOperation(pending.id).status, 'cancelled');
 assert.equal(broker.getOperation(executing.id).cancelRequested, true);
 assert.throws(() => broker.verifyExecution(token, {operationId:executing.id,sessionId:'kan',action:action.name,arguments:invocation.arguments}), /invalid|stopp/i);
 assert.throws(() => broker.approve(pending.id, 'human-secret'), /stopp|approved/i);
 assert.throws(() => broker.invoke({...invocation, requestId:'blocked'}), /stopp|disabled/i);
 assert.ok(sent.some(message => message.type === 'cancel' && message.operationId === executing.id));
 broker.unregister('kan', 'socket-1');
 const replay: any[] = []; broker.register('kan', [action], {}, message => replay.push(message), 'socket-2');
 assert.equal(replay.find(message => message.type === 'registered').enabled, false);
 assert.throws(() => broker.invoke({...invocation, requestId:'still-blocked'}), /stopp|disabled/i);
 assert.throws(() => broker.control('kan', 'socket-1', true), /connection|page/i);
 broker.control('kan', 'socket-2', true);
 assert.equal(broker.invoke({...invocation, requestId:'explicitly-resumed'}).status, 'waiting_approval');
});

test('stopped execution keeps the real in-flight success and cancellation acknowledgement is terminal', t => {
 const sent: any[] = []; const broker = new ClearActBroker('human-secret'); t.after(() => broker.close());
 broker.register('kan', [{...action, risk:'write'}], {}, message => sent.push(message), 'socket-1');
 const successful = broker.invoke(invocation);
 broker.control('kan', 'socket-1', false);
 broker.result('kan', 'socket-1', successful.id, {deleted:true});
 assert.equal(broker.getOperation(successful.id).status, 'succeeded');
 assert.equal(broker.getOperation(successful.id).cancelRequested, true);
 broker.control('kan', 'socket-1', true);
 const cancelled = broker.invoke({...invocation, requestId:'cancel-before-execution'});
 broker.control('kan', 'socket-1', false);
 broker.result('kan', 'socket-1', cancelled.id, undefined, 'Cancelled before business execution', true);
 assert.equal(broker.getOperation(cancelled.id).status, 'cancelled');
 assert.equal(sent.filter(message => message.type === 'result_ack').length, 1);
 assert.throws(() => broker.result('kan', 'socket-1', cancelled.id, {deleted:true}), /unexpected/i);
});

test('writeOnly inputs stay private while approved dispatch and capability binding use the originals', t => {
 const sent: any[] = []; const broker = new ClearActBroker('human-secret'); t.after(() => broker.close());
 const sensitiveAction: ClearActActionMetadata = {name:'login',description:'Native login',risk:'high',inputSchema:{
  type:'object', properties:{username:{type:'string'},password:{type:'string',writeOnly:true},
   options:{type:'object',properties:{recovery:{type:'string',writeOnly:true}}},
   credentials:{type:'array',items:{type:'object',properties:{secret:{type:'string',writeOnly:true},kind:{type:'string'}}}}},
  required:['username','password']}};
 broker.register('login-page', [sensitiveAction], {}, message => sent.push(message), 'login-socket');
 const args = {username:'fake-password-sentinel',password:'fake-password-sentinel',options:{recovery:'fake-recovery-sentinel'},credentials:[{secret:'fake-extra-sentinel',kind:'totp'}]};
 const input = {sessionId:'login-page',action:'login',arguments:args,intent:'Sign in with fake-password-sentinel',requestId:'login-request'};
 const op = broker.invoke(input);
 assert.deepEqual(op.arguments, {username:'[REDACTED]',password:'[REDACTED]',options:{recovery:'[REDACTED]'},credentials:[{secret:'[REDACTED]',kind:'totp'}]});
 assert.equal(op.intent, 'Sign in with [REDACTED]');
 assert.equal(JSON.stringify(sent.filter(message => message.type === 'event')).includes('fake-password-sentinel'), false);
 assert.equal(broker.invoke(input).id, op.id);
 assert.throws(() => broker.invoke({...input,arguments:{...args,password:'different-secret'}}), /requestId/i);
 broker.approve(op.id, 'human-secret');
 const execution = sent.find(message => message.type === 'execute');
 assert.deepEqual(execution.arguments, args);
 const binding = {operationId:op.id,sessionId:input.sessionId,action:input.action,arguments:args};
 assert.throws(() => broker.verifyExecution(execution.executionToken, {...binding,arguments:op.arguments}), /arguments/i);
 assert.throws(() => broker.verifyExecution(execution.executionToken, {...binding,arguments:{...args,password:'wrong-secret'}}), /arguments/i);
 assert.equal(broker.verifyExecution(execution.executionToken,binding).valid, true);
 broker.result('login-page', 'login-socket', op.id, {echo:{password:args.password},message:'Accepted fake-recovery-sentinel',items:[args.credentials[0]!.secret],authenticated:true});
 const settled = broker.getOperation(op.id);
 assert.deepEqual(settled.result, {echo:{password:'[REDACTED]'},message:'Accepted [REDACTED]',items:['[REDACTED]'],authenticated:true});
 assert.equal(JSON.stringify(settled).includes('fake-password-sentinel'), false);
 assert.deepEqual(args.password, 'fake-password-sentinel', 'redaction never mutates caller input');
});

test('secret input errors are scrubbed and nested combined schemas are conservatively redacted', t => {
 const sent: any[] = []; const broker = new ClearActBroker('human-secret'); t.after(() => broker.close());
 broker.register('login-page', [{name:'fill',description:'Fill native secret',risk:'write',inputSchema:{type:'object',properties:{
  secret:{$ref:'#/$defs/password'},nested:{allOf:[{type:'object',properties:{token:{type:'string',writeOnly:true}}}]},
  entries:{type:'array',items:{anyOf:[{type:'string',writeOnly:true},{type:'string'}]}}},$defs:{password:{type:'string',writeOnly:true}}}}], {}, message => sent.push(message), 'socket');
 const op = broker.invoke({sessionId:'login-page',action:'fill',arguments:{secret:'fake-secret-error',nested:{token:'fake-token-error'},entries:['fake-array-error']},intent:'Fill requested fields',requestId:'error-case'});
 assert.deepEqual(op.arguments, {secret:'[REDACTED]',nested:{token:'[REDACTED]'},entries:['[REDACTED]']});
 broker.result('login-page','socket',op.id,undefined,'Native login rejected fake-secret-error and fake-token-error');
 assert.equal(broker.getOperation(op.id).error,'Native login rejected [REDACTED] and [REDACTED]');
 assert.equal(JSON.stringify(sent.filter(message => message.type === 'event')).includes('fake-secret-error'),false);
});

test('actions without writeOnly inputs keep their existing result serialization', t => {
 const {broker}=fixture(); t.after(() => broker.close());
 const op = broker.invoke(invocation); broker.approve(op.id,'human-secret');
 broker.result('kan','socket-1',op.id,{savedAt:new Date('2026-01-01T00:00:00.000Z')});
 assert.equal(JSON.stringify(broker.getOperation(op.id).result),'{"savedAt":"2026-01-01T00:00:00.000Z"}');
});

test('an early deadline timer re-arms the remaining delay and expires without polling', t => {
 const scheduled: {callback: () => void; delay: number}[] = [];
 let now = 10_000;
 t.mock.method(Date, 'now', () => now);
 t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => {
  scheduled.push({callback, delay});
  return {unref() {}} as ReturnType<typeof setTimeout>;
 });
 const sent: any[] = []; const broker = new ClearActBroker('human-secret', {approvalTimeoutMs:20});
 t.after(() => broker.close());
 broker.register('kan', [action], {}, message => sent.push(message), 'socket-1');
 const op = broker.invoke(invocation);
 assert.equal(scheduled[0]?.delay, 20);
 now = 10_019;
 scheduled[0]!.callback();
 assert.equal(sent.filter(message => message.type === 'event').at(-1).operation.status, 'waiting_approval');
 assert.equal(scheduled[1]?.delay, 1, 'a timer firing early must retain the original deadline');
 now = 10_020;
 scheduled[1]!.callback();
 const terminal = sent.filter(message => message.type === 'event').at(-1).operation;
 assert.equal(terminal.id, op.id);
 assert.equal(terminal.status, 'failed', 'deadline emits terminal state without an opportunistic getOperation');
 assert.match(terminal.error, /approval expired/i);
 assert.equal(sent.some(message => message.type === 'execute'), false);
});

function queueFixture(t:any, options={}) {
 const sent:any[]=[];const broker=new ClearActBroker('human-secret',options);t.after(()=>broker.close());
 broker.register('kan',[{...action,risk:'write'},{...action,name:'high'}],{},m=>sent.push(m),'socket-1');
 const invoke=(requestId:string, name=action.name)=>broker.invoke({...invocation,action:name,requestId});
 return {broker,sent,invoke};
}
test('session FIFO queues approved operations without letting approval occupy the slot',t=>{
 const {broker,sent,invoke}=queueFixture(t);const high=invoke('high','high');const first=invoke('first');const second=invoke('second');
 assert.equal(second.status,'queued');broker.approve(high.id,'human-secret');assert.equal(broker.getOperation(high.id).status,'queued');
 assert.deepEqual(sent.filter(m=>m.type==='execute').map(m=>m.operationId),[first.id]);
 broker.result('kan','socket-1',first.id,{});assert.deepEqual(sent.filter(m=>m.type==='execute').map(m=>m.operationId),[first.id,second.id]);
 const ack=sent.findIndex(m=>m.type==='result_ack'&&m.operationId===first.id);const next=sent.findIndex(m=>m.type==='execute'&&m.operationId===second.id);assert.ok(ack<next);
 broker.result('kan','socket-1',second.id,{});assert.equal(sent.filter(m=>m.type==='execute').at(-1).operationId,high.id);
});
test('capacity includes approval and queued entries, excludes executing, and checks dedupe first',t=>{
 const {broker,invoke}=queueFixture(t);invoke('running');const waiting=Array.from({length:20},(_,i)=>invoke('waiting-'+i,i===0?'high':action.name));
 assert.throws(()=>invoke('overflow'),/queue|capacity|waiting/i);assert.equal(invoke('waiting-0','high').id,waiting[0].id);
 broker.reject(waiting[0].id,'human-secret');assert.equal(invoke('space').status,'queued');
});
test('disconnect fails queued operations and changed registration fails at dequeue',t=>{
 const {broker,sent,invoke}=queueFixture(t);const first=invoke('first');const second=invoke('second');
 broker.register('kan',[{...action,risk:'write',description:'Changed'}],{},m=>sent.push(m),'socket-1');
 broker.result('kan','socket-1',first.id,{});assert.equal(broker.getOperation(second.id).status,'failed');assert.match(broker.getOperation(second.id).error??'',/changed/i);
 const running=invoke('third');const queued=invoke('fourth');broker.unregister('kan','socket-1');assert.equal(broker.getOperation(queued.id).status,'failed');assert.equal(broker.getOperation(running.id).status,'failed');
});
test('execution timeout pauses dispatch until reconnect and fails all waiting requests',async t=>{
 const {broker,sent,invoke}=queueFixture(t,{executionTimeoutMs:20});const first=invoke('first');const queued=invoke('queued');const approval=invoke('approval','high');
 await new Promise(r=>setTimeout(r,60));assert.equal(broker.getOperation(queued.id).status,'failed');assert.equal(broker.getOperation(approval.id).status,'failed');
 assert.equal(sent.filter(m=>m.type==='execute').length,1);assert.throws(()=>invoke('paused'),/paused|reconnect/i);assert.throws(()=>broker.result('kan','socket-1',first.id,{}),/unexpected/i);
 broker.unregister('kan','socket-1');broker.register('kan',[{...action,risk:'write'}],{},m=>sent.push(m),'socket-2');assert.equal(invoke('reconnected').status,'executing');
});
test('synchronous observer and ACK reentry cannot dispatch before ACK completes',t=>{
 const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());const sent:any[]=[];let injected=false;let firstId='';let inAck=false;
 broker.register('kan',[{...action,risk:'write'}],{},m=>{
  sent.push(m);if(m.type==='execute')assert.equal(inAck,false);
  if(m.type==='event'&&(m.operation as any).status==='executing'&&!injected){injected=true;broker.invoke({...invocation,requestId:'reentrant'});}
  if(m.type==='result_ack'){inAck=true;broker.invoke({...invocation,requestId:'ack-reentrant'});assert.equal(sent.filter(m=>m.type==='execute').length,1);inAck=false;}
 },'socket-1');
 const first=broker.invoke(invocation);firstId=first.id;assert.deepEqual(sent.filter(m=>m.type==='execute').map(m=>m.operationId),[firstId]);
 broker.result('kan','socket-1',firstId,{});assert.equal(sent.filter(m=>m.type==='execute').length,2);
});
test('registration refresh during executing event does not strand the reserved slot',t=>{
 const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());const sent:any[]=[];let refreshed=false;
 const send=(m:any)=>{sent.push(m);if(m.type==='event'&&m.operation.status==='executing'&&!refreshed){refreshed=true;broker.register('kan',[{...action,risk:'write'}],{},send,'socket-1');}};
 broker.register('kan',[{...action,risk:'write'}],{},send,'socket-1');const first=broker.invoke(invocation);
 assert.deepEqual(sent.filter(m=>m.type==='execute').map(m=>m.operationId),[first.id]);
 broker.result('kan','socket-1',first.id,{});assert.equal(broker.invoke({...invocation,requestId:'next'}).status,'executing');
});
test('queued execution receives a fresh dispatch deadline and capability only when dequeued',t=>{
 const {broker,sent,invoke}=queueFixture(t,{executionTimeoutMs:1000});const first=invoke('first');const second=invoke('second');
 const now=Date.now();t.mock.method(Date,'now',()=>now+900);
 broker.result('kan','socket-1',first.id,{});const execution=sent.filter(m=>m.type==='execute').at(-1);
 assert.equal(execution.operationId,second.id);assert.equal(execution.expiresAt,now+1900);
 assert.equal(broker.verifyExecution(execution.executionToken,{operationId:second.id,sessionId:'kan',action:action.name,arguments:invocation.arguments}).valid,true);
});

test('unregistering and restoring identical metadata cannot revive queued invocations',t=>{
 const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());const sent:any[]=[];
 const actions=[{...action,risk:'write' as const}];const send=(message:any)=>sent.push(message);
 broker.register('kan',actions,{},send,'socket-1');
 const first=broker.invoke(invocation);const queued=broker.invoke({...invocation,requestId:'old-registration'});
 assert.equal(queued.status,'queued');broker.register('kan',[],{},send,'socket-1');broker.register('kan',actions,{},send,'socket-1');
 broker.result('kan','socket-1',first.id,{done:true});
 assert.equal(broker.getOperation(queued.id).status,'failed');
 assert.equal(sent.some(message=>message.type==='execute'&&message.operationId===queued.id),false);
 const fresh=broker.invoke({...invocation,requestId:'new-registration'});assert.equal(fresh.status,'executing');
});

test('an approval cannot authorize an action from an earlier identical registration',t=>{
 const {broker,sent}=fixture();t.after(()=>broker.close());const pending=broker.invoke(invocation);
 broker.register('kan',[],{},message=>sent.push(message),'socket-1');broker.register('kan',[action],{},message=>sent.push(message),'socket-1');
 assert.throws(()=>broker.approve(pending.id,'human-secret'),/changed/i);
 assert.equal(sent.some(message=>message.type==='execute'),false);
});

test('page stop cancels queued and approval entries and never replays them on resume',t=>{
 const {broker,sent,invoke}=queueFixture(t);
 const first=invoke('running');const queued=invoke('queued');const approval=invoke('approval','high');
 broker.control('kan','socket-1',false);
 assert.equal(broker.getOperation(queued.id).status,'cancelled');
 assert.equal(broker.getOperation(approval.id).status,'cancelled');
 broker.result('kan','socket-1',first.id,{saved:true});
 broker.control('kan','socket-1',true);
 assert.equal(sent.filter(message=>message.type==='execute').length,1);
 const fresh=invoke('fresh-after-resume');assert.equal(fresh.status,'executing');
 assert.equal(sent.filter(message=>message.type==='execute').at(-1).operationId,fresh.id);
});

test('a synchronous page stop before dispatch cancels the reserved entry',t=>{
 const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());const sent:any[]=[];let stopped=false;
 broker.register('kan',[{...action,risk:'write'}],{},message=>{
  sent.push(message);
  if(message.type==='event'&&(message.operation as any).status==='executing'&&!stopped){stopped=true;broker.control('kan','socket-1',false);}
 },'socket-1');
 const operation=broker.invoke(invocation);
 assert.equal(sent.some(message=>message.type==='execute'),false);
 assert.equal(broker.getOperation(operation.id).status,'cancelled');
});

test('a private action retains unrelated Date results while scrubbing recursive inputs',t=>{
 const sent:any[]=[];const broker=new ClearActBroker('human-secret');t.after(()=>broker.close());
 const schema={type:'object',properties:{privateField:{type:'string',writeOnly:true},child:{$ref:'#'}}};
 broker.register('recursive',[{name:'save',description:'Save synthetic private input',risk:'write',inputSchema:schema}],{},message=>sent.push(message),'socket');
 const args={privateField:'synthetic-private-root',child:{privateField:'synthetic-private-child'}};
 const operation=broker.invoke({sessionId:'recursive',action:'save',arguments:args,intent:'Save synthetic data',requestId:'recursive-private'});
 assert.deepEqual(operation.arguments,{privateField:'[REDACTED]',child:{privateField:'[REDACTED]'}});
 const execution=sent.find(message=>message.type==='execute');assert.deepEqual(execution.arguments,args);
 broker.result('recursive','socket',operation.id,{savedAt:new Date('2026-01-01T00:00:00.000Z'),echo:args.child.privateField});
 assert.deepEqual(broker.getOperation(operation.id).result,{savedAt:'2026-01-01T00:00:00.000Z',echo:'[REDACTED]'});
});
