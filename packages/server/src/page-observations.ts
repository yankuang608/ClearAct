// SPDX-License-Identifier: MIT
import {randomUUID} from 'node:crypto';
import {PageError} from '@clearact/core';
import {assertObservationResult} from '@clearact/core';
import type {PageObservationOptions,PageSnapshot,PageObservationResult,ExecutionObservation,ObservationReference} from '@clearact/core';

export interface PageSessionInfo {contextMode:'legacy'|'page';documentId?:string;capabilities?:{pageObservation?:string};}
type Pending={sessionId:string;connectionId:string;documentId:string;resolve:(snapshot:PageSnapshot)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Delivered={captured:number;result:PageObservationResult};
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value);
const publicErrors=new Set(['PAGE_OBSERVATION_UNSUPPORTED','PAGE_CONTEXT_REQUIRES_OBSERVE','PAGE_NOT_VISIBLE','PAGE_NOT_READY','OBSERVATION_TIMEOUT','PAGE_DISCONNECTED','UNKNOWN_REF','STALE_CURSOR','OBSERVATION_REQUIRED','OBSERVATION_EXPIRED','OBSERVATION_INCOMPLETE','TARGET_CHANGED','CONTEXT_CHANGED','ACTION_UNAVAILABLE','BINDING_MISMATCH','ADAPTER_CONTRACT_VIOLATION','ACTION_RESULT_CONTRACT_VIOLATION','ATTACHMENT_UNAVAILABLE']);
export const isPageErrorCode=(code:unknown):code is string=>typeof code==='string'&&publicErrors.has(code);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function observationOptions(options:unknown):PageObservationOptions {
 if(!object(options)||Object.keys(options).some(k=>!['detail','regionRef','bindingRef','cursor','limit'].includes(k))||
  (options.detail!==undefined&&!['overview','region'].includes(String(options.detail)))||
  (options.regionRef!==undefined&&(typeof options.regionRef!=='string'||!options.regionRef))||
  (options.bindingRef!==undefined&&(typeof options.bindingRef!=='string'||!options.bindingRef||options.detail!=='region'))||
  (options.cursor!==undefined&&(typeof options.cursor!=='string'||!options.cursor))||
  (options.limit!==undefined&&(!Number.isInteger(options.limit)||Number(options.limit)<1||Number(options.limit)>500))||
  (options.detail==='region'&&!options.regionRef)||(options.regionRef&&options.detail!=='region'))throw new PageError('UNKNOWN_REF');
 return options as PageObservationOptions;
}
/** One connection's delivered observations are never a replacement for a fresh page sample. */
export class PageObservationStore {
 private pending=new Map<string,Pending>();
 private records=new Map<string,Map<string,Delivered>>();
 constructor(private timeoutMs=3_000){}
 observe(sessionId:string,connectionId:string,documentId:string,options:PageObservationOptions,send:(message:Record<string,unknown>)=>void):Promise<PageSnapshot>{
  observationOptions(options);
  const requestId=randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new PageError('OBSERVATION_TIMEOUT'));},this.timeoutMs);
   this.pending.set(requestId,{sessionId,connectionId,documentId,resolve,reject,timer});
   try{send({type:'observe',requestId,documentId,options});}catch{clearTimeout(timer);this.pending.delete(requestId);reject(new PageError('PAGE_DISCONNECTED'));}
  });
 }
 receive(sessionId:string,connectionId:string,message:any):void {
  const pending=this.pending.get(message?.requestId);
  // Foreign and late responses cannot consume a legitimate in-flight request.
  if(!pending||pending.sessionId!==sessionId||pending.connectionId!==connectionId||pending.documentId!==message.documentId)throw new PageError('PAGE_DISCONNECTED');
  try{
   if(Buffer.byteLength(JSON.stringify(message))>120*1024)throw new PageError('ADAPTER_CONTRACT_VIOLATION');
   if(message.error){
    if(!object(message.error)||!isPageErrorCode(message.error.code))throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    throw new PageError(message.error.code);
   }
   const result={snapshot:message.snapshot,evidence:message.evidence};assertObservationResult(result);
   if(result.snapshot.sessionId!==sessionId||result.snapshot.documentId!==pending.documentId||result.evidence.documentId!==pending.documentId)throw new PageError('ADAPTER_CONTRACT_VIOLATION');
   const record=this.records.get(connectionId)??new Map<string,Delivered>();this.records.set(connectionId,record);
   this.prune(record);
   if(record.has(result.snapshot.snapshotId))throw new PageError('ADAPTER_CONTRACT_VIOLATION');
   record.set(result.snapshot.snapshotId,{captured:Date.now(),result:structuredClone(result)});
   this.prune(record);
   this.finish(message.requestId);pending.resolve(structuredClone(result.snapshot));
  }catch(error){this.finish(message.requestId);pending.reject(error instanceof PageError?error:new PageError('ADAPTER_CONTRACT_VIOLATION'));}
 }
 admit(connectionId:string,documentId:string,observation:ObservationReference|undefined,action:string,args:Record<string,unknown>):ExecutionObservation {
  if(!observation)throw new PageError('OBSERVATION_REQUIRED');
  if(!object(observation)||Object.keys(observation).some(k=>!['snapshotId','bindingRef'].includes(k))||typeof observation.snapshotId!=='string'||typeof observation.bindingRef!=='string')throw new PageError('OBSERVATION_REQUIRED');
  const records=this.records.get(connectionId);if(records)this.prune(records);
  const record=records?.get(observation.snapshotId);
  if(!record||record.result.evidence.documentId!==documentId)throw new PageError('OBSERVATION_EXPIRED');
  const binding=record.result.evidence.bindings.find(candidate=>candidate.bindingRef===observation.bindingRef);
  if(!binding)throw new PageError('OBSERVATION_INCOMPLETE');
  if(binding.action!==action)throw new PageError('BINDING_MISMATCH');
  for(const [key,value] of Object.entries(binding.argumentBindings))if(canonical(args[key])!==canonical(value))throw new PageError('BINDING_MISMATCH');
  return structuredClone({documentId,snapshotId:observation.snapshotId,binding});
 }
 knownRefs(connectionId:string):Set<string>{return new Set([...this.records.get(connectionId)?.values()??[]].flatMap(record=>record.result.snapshot.nodes.map(node=>node.ref)));}
 disconnect(sessionId:string,connectionId:string):void {
  this.records.delete(connectionId);
  for(const [id,pending] of this.pending)if(pending.sessionId===sessionId&&pending.connectionId===connectionId){this.finish(id);pending.reject(new PageError('PAGE_DISCONNECTED'));}
 }
 private finish(id:string){const pending=this.pending.get(id);if(pending)clearTimeout(pending.timer);this.pending.delete(id);}
 private prune(records:Map<string,Delivered>){for(const [id,record] of records)if(Date.now()-record.captured>=300_000)records.delete(id);while(records.size>64)records.delete(records.keys().next().value!);}
}
