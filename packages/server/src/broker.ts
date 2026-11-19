// SPDX-License-Identifier: MIT
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import {PageObservationStore,observationOptions,isPageErrorCode,type PageSessionInfo} from './page-observations.ts';
import {PageError} from '@clearact/core';
import {assertPageActionResult} from '@clearact/core';
import type {PageObservationOptions,PageSnapshot,ObservationReference,ExecutionObservation} from '@clearact/core';
import {privateArguments, scrubSecretEcho} from '../../core/src/redaction.ts';
import type { ClearActActionMetadata, ClearActJsonObject, ClearActOperation } from '@clearact/core';

export class ClearActBrokerError extends Error { constructor(public status:number,message:string){super(message);} }
export interface Invocation {sessionId:string; action:string; arguments:ClearActJsonObject; intent:string; requestId:string;observation?:ObservationReference;}
export interface ExecutionBinding {operationId:string; sessionId:string; action:string; arguments:ClearActJsonObject;}
export interface ClearActBrokerOptions {approvalTimeoutMs?:number; executionTimeoutMs?:number;observationTimeoutMs?:number;maxRegisteredActions?:number;}
type Sender=(message:Record<string,unknown>)=>void;
interface Session extends PageSessionInfo {id:string; actions:ClearActActionMetadata[]; context:ClearActJsonObject; send:Sender; connectionId:string; validators:Map<string,ValidateFunction>; revisions:Map<string,number>; queue:Entry[]; active?:Entry; draining:boolean; paused:boolean;}
interface Entry {operation:ClearActOperation;pageMode?:boolean;observation?:ExecutionObservation;knownRefs?:Set<string>; arguments?:ClearActJsonObject; secrets:string[]; signature:string; revision:number; connectionId?:string; executionToken?:string; consumed:boolean; expiresAt:number; timer?:ReturnType<typeof setTimeout>;}
const clone=<T>(value:T):T=>structuredClone(value);
export function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as ClearActJsonObject)[k])).join(',')+'}';
 return JSON.stringify(value);
}
function object(value:unknown):value is ClearActJsonObject {return value!==null&&typeof value==='object'&&!Array.isArray(value);}

/** In-memory localhost MVP coordinator. Restart invalidates all pending capabilities. */
export class ClearActBroker {
 private readonly observations:PageObservationStore;
 private readonly sessions=new Map<string,Session>();
 private readonly stopped=new Set<string>();
 private readonly pageSessionIds=new Set<string>();
 private readonly operations=new Map<string,Entry>();
 private readonly requests=new Map<string,{fingerprint:string;operationId:string}>();
 private readonly ajv=new Ajv({allErrors:true,strict:false});
 private readonly approvalTimeoutMs:number;
 private readonly executionTimeoutMs:number;
 private readonly maxRegisteredActions:number;
 constructor(private readonly approvalToken:string,options:ClearActBrokerOptions={}) {
  this.maxRegisteredActions=options.maxRegisteredActions??100;
  if(!Number.isSafeInteger(this.maxRegisteredActions)||this.maxRegisteredActions<1||this.maxRegisteredActions>500)throw new Error('Invalid action registration limit');
  this.observations=new PageObservationStore(options.observationTimeoutMs??3_000);
  if(!approvalToken)throw new Error('Approval token must not be empty');
  this.approvalTimeoutMs=options.approvalTimeoutMs??300_000;
  this.executionTimeoutMs=options.executionTimeoutMs??120_000;
  for(const duration of [this.approvalTimeoutMs,this.executionTimeoutMs,options.observationTimeoutMs??3_000])if(!Number.isSafeInteger(duration)||duration<1||duration>2_147_483_647)throw new Error('ClearActOperation timeouts must be positive timer durations');
 }
 register(sessionId:string,actions:ClearActActionMetadata[],context:ClearActJsonObject,send:Sender,connectionId:string,enabled?:boolean,page:PageSessionInfo={contextMode:'legacy'}):void {
  if(typeof sessionId!=='string'||!sessionId||sessionId.length>128||!Array.isArray(actions)||actions.length>this.maxRegisteredActions||!object(context))throw new ClearActBrokerError(400,'Invalid registration');
  if(!['legacy','page'].includes(page.contextMode))throw new PageError('PAGE_OBSERVATION_UNSUPPORTED');
  if(page.contextMode==='page'&&(!page.documentId||page.capabilities?.pageObservation!=='1.0'||Object.keys(context).length||actions.some(a=>a.resultMode!=='page'||a.name==='clearact.page.observe')))throw new PageError('PAGE_OBSERVATION_UNSUPPORTED');
  const existing=this.sessions.get(sessionId);
  if(existing&&(existing.contextMode!==page.contextMode||existing.documentId!==page.documentId))throw new PageError('PAGE_DISCONNECTED');
  if(existing&&existing.connectionId!==connectionId)throw new ClearActBrokerError(409,'Session already connected');
  const validators=new Map<string,ValidateFunction>();
  for(const action of actions){
   if(!action||typeof action.name!=='string'||!/^[\w.-]{1,128}$/.test(action.name)||typeof action.description!=='string'||!['read','write','high'].includes(action.risk)||!object(action.inputSchema)||validators.has(action.name))throw new ClearActBrokerError(400,'Invalid or duplicate action metadata');
   try {validators.set(action.name,this.ajv.compile(action.inputSchema));}catch{throw new ClearActBrokerError(400,'Invalid action inputSchema');}
  }
  const revisions=new Map(existing?.revisions);
  // Keep tombstones so removing then restoring identical metadata cannot revive old requests.
  for(const previous of existing?.actions??[])if(!actions.some(action=>action.name===previous.name))revisions.set(previous.name,(revisions.get(previous.name)??0)+1);
  for(const action of actions){
   const previous=existing?.actions.find(candidate=>candidate.name===action.name);
   if(!previous||canonical(previous)!==canonical(action))revisions.set(action.name,(revisions.get(action.name)??0)+1);
  }
  if(existing)Object.assign(existing,{actions:clone(actions),context:clone(context),send,validators,revisions});
  else this.sessions.set(sessionId,{id:sessionId,actions:clone(actions),context:clone(context),send,connectionId,validators,revisions,queue:[],draining:false,paused:false,...clone(page)});
  // Metadata refreshes must not override a page control acknowledgement in flight.
  if(page.contextMode==='page')this.pageSessionIds.add(sessionId);else this.pageSessionIds.delete(sessionId);
  if(!existing&&enabled===false)this.control(sessionId,connectionId,false);
  send({type:'registered',sessionId,enabled:!this.stopped.has(sessionId),...clone(page)});
  if(!existing)for(const entry of [...this.operations.values()].filter(e=>e.operation.sessionId===sessionId).slice(-100)){this.expire(entry);this.emit(entry);}
 }
 unregister(sessionId:string,connectionId:string):void {
  if(this.sessions.get(sessionId)?.connectionId!==connectionId)return;
  this.observations.disconnect(sessionId,connectionId);
  this.sessions.delete(sessionId);
  for(const entry of this.operations.values())if(entry.operation.sessionId===sessionId&&['executing','queued','waiting_approval'].includes(entry.operation.status))this.fail(entry,'Page disconnected; operation is not retried automatically');
 }
 close():void {
  for(const session of this.sessions.values())this.unregister(session.id,session.connectionId);
  for(const entry of this.operations.values())clearTimeout(entry.timer);
 }
 control(sessionId:string,connectionId:string,enabled:boolean,requestId?:string):void {
  const session=this.session(sessionId);
  if(session.connectionId!==connectionId)throw new ClearActBrokerError(403,'Page control requires the registered connection');
  if(typeof enabled!=='boolean')throw new ClearActBrokerError(400,'Page control requires enabled boolean');
  if(enabled)this.stopped.delete(sessionId);
  else {
   this.stopped.add(sessionId);
   for(const entry of this.operations.values())if(entry.operation.sessionId===sessionId){
    if(['waiting_approval','queued'].includes(entry.operation.status))this.cancel(entry,'Cancelled before business execution by page stop');
    else if(entry.operation.status==='executing'){
     entry.executionToken=undefined;entry.operation.cancelRequested=true;entry.operation.updatedAt=new Date().toISOString();this.emit(entry);
     try{session.send({type:'cancel',operationId:entry.operation.id});}catch{}
    }
   }
  }
  session.send({type:'control',enabled, ...(requestId===undefined?{}:{requestId})});
  if(enabled)this.drain(session);
 }
 private assertEnabled(sessionId:string):void {
  if(this.stopped.has(sessionId))throw new ClearActBrokerError(409,'Page agent is stopped; the page must explicitly resume');
 }
 listSessions(){return [...this.sessions.values()].map(s=>({sessionId:s.id,connected:true,actionCount:s.actions.length,enabled:!this.stopped.has(s.id),contextMode:s.contextMode,...(s.contextMode==='page'?{documentId:s.documentId,capabilities:s.capabilities}:{})}));}
 private session(id:string){const session=this.sessions.get(id);if(!session){if(this.pageSessionIds.has(id))throw new PageError('PAGE_DISCONNECTED');throw new ClearActBrokerError(404,'Page session not connected');}return session;}
 getActions(id:string){return clone(this.session(id).actions);}
 getContext(id:string,options?:PageObservationOptions):ClearActJsonObject|Promise<PageSnapshot>{
  const session=this.session(id);
  if(session.contextMode==='page')return this.observe(id,options??{});
  if(options!==undefined)throw new PageError('PAGE_OBSERVATION_UNSUPPORTED');
  return clone(session.context);
 }
 observe(id:string,options:PageObservationOptions={}):Promise<PageSnapshot>{
  const session=this.session(id);if(session.contextMode!=='page'||!session.documentId)throw new PageError('PAGE_OBSERVATION_UNSUPPORTED');
  observationOptions(options);return this.observations.observe(id,session.connectionId,session.documentId,options,session.send);
 }
 observationResult(sessionId:string,connectionId:string,message:unknown):void {
  const session=this.session(sessionId);if(session.connectionId!==connectionId||session.contextMode!=='page')throw new PageError('PAGE_DISCONNECTED');
  this.observations.receive(sessionId,connectionId,message);
 }
 private entry(id:string){const entry=this.operations.get(id);if(!entry)throw new ClearActBrokerError(404,'ClearActOperation not found');this.expire(entry);return entry;}
 getOperation(id:string):ClearActOperation{return clone(this.entry(id).operation);}
 invoke(input:Invocation):ClearActOperation {
  if(!object(input)||typeof input.sessionId!=='string'||typeof input.action!=='string'||!object(input.arguments)||typeof input.intent!=='string'||!input.intent.trim()||input.intent.length>2000||typeof input.requestId!=='string'||!input.requestId||input.requestId.length>200)throw new ClearActBrokerError(400,'Invalid invocation: sessionId, action, arguments, intent and requestId required');
  const key=canonical([input.sessionId,input.requestId]);const fingerprint=createHash('sha256').update(canonical(input)).digest('hex');const previous=this.requests.get(key);
  if(previous){if(previous.fingerprint!==fingerprint)throw new ClearActBrokerError(409,'requestId already used with different arguments or intent');return this.getOperation(previous.operationId);}
  this.assertEnabled(input.sessionId);
  const session=this.session(input.sessionId);const action=session.actions.find(a=>a.name===input.action);if(!action)throw new ClearActBrokerError(404,'Action not registered');
  const validate=session.validators.get(action.name)!;if(!validate(input.arguments))throw new ClearActBrokerError(400,'Invalid arguments: '+this.ajv.errorsText(validate.errors));
  if(session.contextMode==='legacy'&&input.observation!==undefined)throw new PageError('PAGE_OBSERVATION_UNSUPPORTED');
  const observation=session.contextMode==='page'?this.observations.admit(session.connectionId,session.documentId!,input.observation,input.action,input.arguments):undefined;
  if(session.paused)throw new ClearActBrokerError(409,'Session paused after execution timeout; reconnect before invoking');
  const waiting=[...this.operations.values()].filter(e=>e.operation.sessionId===session.id&&['queued','waiting_approval'].includes(e.operation.status)).length;
  if(waiting>=20)throw new ClearActBrokerError(429,'Operation waiting queue capacity reached');
  const privacy=privateArguments(input.arguments,action.inputSchema);
  const now=new Date().toISOString();const operation:ClearActOperation={id:randomUUID(),sessionId:input.sessionId,action:input.action,arguments:privacy.arguments,intent:scrubSecretEcho(input.intent,privacy.secrets),status:action.risk==='high'?'waiting_approval':'queued',createdAt:now,updatedAt:now,...(input.observation?{observation:clone(input.observation)}:{})};
  const entry:Entry={operation,pageMode:session.contextMode==='page',...(observation?{observation,knownRefs:this.observations.knownRefs(session.connectionId)}:{}),arguments:clone(input.arguments),secrets:privacy.secrets,signature:canonical(action),revision:session.revisions.get(action.name)!,connectionId:session.connectionId,consumed:false,expiresAt:0};
  this.operations.set(operation.id,entry);this.requests.set(key,{fingerprint,operationId:operation.id});
  if(action.risk==='high')this.schedule(entry,this.approvalTimeoutMs);
  else session.queue.push(entry);
  this.emit(entry);
  this.drain(session);
  return clone(operation);
 }
 private authorize(token:string){const a=Buffer.from(token||'');const b=Buffer.from(this.approvalToken);if(a.length!==b.length||!timingSafeEqual(a,b))throw new ClearActBrokerError(403,'Human approval credential required');}
 approve(id:string,token:string):ClearActOperation {
  this.authorize(token);const entry=this.entry(id);
  this.assertEnabled(entry.operation.sessionId);
  if(['queued','executing','succeeded','failed'].includes(entry.operation.status))return clone(entry.operation);
  if(entry.operation.status!=='waiting_approval')throw new ClearActBrokerError(409,'ClearActOperation cannot be approved');
  const session=this.session(entry.operation.sessionId);const current=session.actions.find(a=>a.name===entry.operation.action);
  if(!current||canonical(current)!==entry.signature||session.revisions.get(entry.operation.action)!==entry.revision)throw new ClearActBrokerError(409,'Action registration changed; create a new request');
  clearTimeout(entry.timer);entry.expiresAt=0;entry.operation.status='queued';entry.operation.updatedAt=new Date().toISOString();session.queue.push(entry);this.emit(entry);this.drain(session);return clone(entry.operation);
 }
 reject(id:string,token:string):ClearActOperation {
  this.authorize(token);const entry=this.entry(id);if(entry.operation.status==='rejected')return clone(entry.operation);
  if(entry.operation.status!=='waiting_approval')throw new ClearActBrokerError(409,'Only pending approval can be rejected');
  clearTimeout(entry.timer);entry.arguments=undefined;entry.secrets=[];entry.observation=undefined;entry.knownRefs=undefined;entry.operation.status='rejected';entry.operation.updatedAt=new Date().toISOString();this.emit(entry);return clone(entry.operation);
 }
 private drain(session:Session):void {
  if(this.stopped.has(session.id)||session.draining||session.active||session.paused||this.sessions.get(session.id)!==session)return;
  session.draining=true;
  try {
   while(!this.stopped.has(session.id)&&!session.active&&!session.paused&&this.sessions.get(session.id)===session&&session.queue.length){
    const entry=session.queue.shift()!;
    if(entry.operation.status!=='queued')continue;
    const current=session.actions.find(a=>a.name===entry.operation.action);
    if(entry.connectionId!==session.connectionId){this.fail(entry,'Page disconnected; operation is not retried automatically');continue;}
    if(!current||canonical(current)!==entry.signature||session.revisions.get(entry.operation.action)!==entry.revision){this.fail(entry,'Action registration changed; create a new request');continue;}
    session.active=entry;
    entry.operation.status='executing';entry.operation.updatedAt=new Date().toISOString();
    entry.executionToken=randomBytes(32).toString('base64url');this.schedule(entry,this.executionTimeoutMs);
    this.emit(entry);
    // Observer delivery may synchronously disconnect or complete this operation.
    if(this.sessions.get(session.id)!==session||session.active!==entry||entry.operation.status!=='executing')continue;
    if(this.stopped.has(session.id)||entry.operation.cancelRequested){
     this.cancel(entry,'Cancelled before business execution by page stop');
     if(session.active===entry)session.active=undefined;
     continue;
    }
    try {session.send({type:'execute',operationId:entry.operation.id,action:entry.operation.action,arguments:clone(entry.arguments!),executionToken:entry.executionToken,expiresAt:entry.expiresAt,intent:entry.operation.intent,...(entry.observation?{observation:clone(entry.observation)}:{})});}
    catch{if(entry.operation.status==='executing'){this.fail(entry,'Page dispatch failed');session.active=undefined;}}
   }
  } finally {session.draining=false;}
 }
 verifyExecution(token:string,binding:ExecutionBinding):{valid:true;operationId:string}{
  if(!object(binding)||typeof binding.operationId!=='string')throw new ClearActBrokerError(403,'Invalid execution binding');
  const entry=this.entry(binding.operationId);const op=entry.operation;this.assertEnabled(op.sessionId);
  if(!token||entry.executionToken!==token||entry.consumed||entry.expiresAt<Date.now()||op.status!=='executing')throw new ClearActBrokerError(403,'Invalid, expired or consumed execution capability');
  if(binding.sessionId!==op.sessionId||binding.action!==op.action||canonical(binding.arguments)!==canonical(entry.arguments))throw new ClearActBrokerError(403,'Execution capability does not match action and arguments');
  entry.consumed=true;return {valid:true,operationId:op.id};
 }
 result(sessionId:string,connectionId:string,id:string,result?:unknown,error?:string,cancelled=false,errorCode?:string,effect?:string){
  const entry=this.entry(id);if(entry.operation.sessionId!==sessionId||entry.connectionId!==connectionId||entry.operation.status!=='executing')throw new ClearActBrokerError(409,'Unexpected operation result');
  const owner=this.sessions.get(sessionId);
  if(entry.pageMode){
   if(!error&&!cancelled)try{assertPageActionResult(result,ref=>Boolean(entry.knownRefs?.has(ref)));}catch{result=undefined;error='Page action returned an invalid public result; business changes may already have occurred';errorCode='ACTION_RESULT_CONTRACT_VIOLATION';effect=undefined;}
   if(error)error=errorCode==='ACTION_RESULT_CONTRACT_VIOLATION'?'Page action returned an invalid public result; business changes may already have occurred':'Page action failed; observe the current page before retrying';
   if(isPageErrorCode(errorCode))entry.operation.errorCode=errorCode;
   if(effect==='not_started'&&errorCode&&['PAGE_NOT_VISIBLE','PAGE_NOT_READY','PAGE_DISCONNECTED','OBSERVATION_REQUIRED','OBSERVATION_EXPIRED','OBSERVATION_INCOMPLETE','TARGET_CHANGED','CONTEXT_CHANGED','ACTION_UNAVAILABLE','BINDING_MISMATCH','UNKNOWN_REF','ADAPTER_CONTRACT_VIOLATION'].includes(errorCode))entry.operation.effect='not_started';
  }
  entry.operation.status=cancelled?'cancelled':error?'failed':'succeeded';
  if(cancelled)entry.operation.cancelRequested=true;
  if(error||cancelled)entry.operation.error=scrubSecretEcho(String(error??'Action cancelled; cancellation does not imply rollback'),entry.secrets).slice(0,4000);else entry.operation.result=scrubSecretEcho(clone(result??null),entry.secrets);
  clearTimeout(entry.timer);entry.executionToken=undefined;entry.arguments=undefined;entry.secrets=[];entry.observation=undefined;entry.knownRefs=undefined;entry.operation.updatedAt=new Date().toISOString();this.emit(entry);
  // A document may unload only after its result has become authoritative. ACK
  // stays on the result's original connection; it never authorizes a replay.
  const session=this.sessions.get(sessionId);
  if(!error&&!cancelled&&session?.connectionId===connectionId)try{session.send({type:'result_ack',operationId:id});}catch{}
  if(owner?.active===entry){owner.active=undefined;this.drain(owner);}
 }
 private schedule(entry:Entry,duration:number):void {
  clearTimeout(entry.timer);entry.expiresAt=Date.now()+duration;
  const deadline=()=>{
   if(!['waiting_approval','executing'].includes(entry.operation.status))return;
   const remaining=entry.expiresAt-Date.now();
   // Node timers can fire slightly early; keep the original absolute deadline.
   if(remaining>0){entry.timer=setTimeout(deadline,remaining);entry.timer.unref();return;}
   this.expire(entry);
  };
  entry.timer=setTimeout(deadline,duration);entry.timer.unref();
 }
 private expire(entry:Entry):void {
  if(Date.now()<entry.expiresAt)return;
  if(entry.operation.status==='waiting_approval')this.fail(entry,'Approval expired; create a new request');
  else if(entry.operation.status==='executing'){
   const session=this.sessions.get(entry.operation.sessionId);if(session)session.paused=true;
   this.fail(entry,'Execution timed out; business outcome may be unknown. Check business state before retrying');
   for(const pending of this.operations.values())if(pending.operation.sessionId===entry.operation.sessionId&&['queued','waiting_approval'].includes(pending.operation.status))this.fail(pending,'Session paused after execution timeout; reconnect and create a new request');
   if(session)session.queue=[];
  }
 }
 private cancel(entry:Entry,error:string):void {
  clearTimeout(entry.timer);entry.executionToken=undefined;entry.arguments=undefined;entry.secrets=[];entry.observation=undefined;entry.knownRefs=undefined;entry.operation.status='cancelled';entry.operation.cancelRequested=true;entry.operation.error=error;entry.operation.updatedAt=new Date().toISOString();this.emit(entry);
 }
 private fail(entry:Entry,error:string):void {
  clearTimeout(entry.timer);entry.executionToken=undefined;entry.arguments=undefined;entry.secrets=[];entry.observation=undefined;entry.knownRefs=undefined;entry.operation.status='failed';entry.operation.error=error;entry.operation.updatedAt=new Date().toISOString();this.emit(entry);
 }
 private emit(entry:Entry){
  // Delivery is advisory: polling and reconnect replay retain the authoritative state.
  try{this.sessions.get(entry.operation.sessionId)?.send({type:'event',operation:clone(entry.operation)});}catch{}
 }
}
