// SPDX-License-Identifier: MIT
import {buildBindingCanonical, PageError} from './page.ts';
import type {PageActionBinding, PageActionResult, PageBindingCapture, PageCapture, PageNode, PageObservationResult} from './page-types.ts';

export const PAGE_PUBLIC_BYTE_LIMIT = 48 * 1024;
export const PAGE_EVIDENCE_BYTE_LIMIT = 48 * 1024;
const string = {type:'string'};
const ref = {type:'string',minLength:1};
const boolean = {type:'boolean'};
const count = {type:'integer',minimum:0};
const strings = {type:'array',items:string};
const refs = {type:'array',items:ref,uniqueItems:true};
const object = (properties:Record<string,unknown>, required:string[] = Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const value = {oneOf:[string,boolean,strings]};
const action = object({ref,action:ref,targetRef:ref,label:string,enabled:boolean,callable:boolean,argumentBindings:{type:'object'},unavailableReason:{const:'observation_incomplete'},disabledReason:string},['ref','action','targetRef','label','enabled','callable','argumentBindings']);
const common = {
  ref,kind:ref,name:string,revision:count,children:refs,detailAvailable:boolean,
  state:object({busy:boolean,selected:boolean,expanded:boolean,disabled:boolean,readOnly:boolean,invalid:boolean,blockedBy:ref},[]),
  actions:{type:'array',items:action},truncation:object({reason:ref}),source:{enum:['rendered','accessible']}
};
const node = (kind:string, properties:Record<string,unknown> = {}, required:string[] = []) => object({...common,kind:{const:kind},...properties},['ref','kind',...required]);
const nodeSchema = {oneOf:[
  ...['page','region','row','form'].map(kind=>node(kind)),
  node('text',{text:string},['text']),
  node('table',{table:object({columns:{type:'array',items:object({key:ref,label:string})},renderedRows:count,totalRows:count,paginationText:string,filterText:string,sortText:string},[])},['table']),
  node('cell',{columnKey:ref,text:string,rowSpan:{type:'integer',minimum:1},columnSpan:{type:'integer',minimum:1}},['columnKey','text']),
  node('field',{field:object({controlType:ref,value,required:boolean,redacted:boolean},['controlType']),messages:strings},['field']),
  node('dialog',{dialog:object({modal:boolean,open:boolean,blocks:refs})},['dialog']),
  node('control',{control:object({controlType:ref,value,href:string},['controlType'])},['control']),
  node('unsupported',{unsupported:object({reason:ref})},['unsupported'])
]};
const issue = object({ref,code:ref,message:string},['code','message']);
const coverage = object({status:{enum:['complete','partial']},issues:{type:'array',items:issue},truncated:boolean,nextCursor:{oneOf:[ref,{type:'null'}]}});
const page = object({url:string,title:string});
export const PAGE_SNAPSHOT_SCHEMA = {
  $schema:'http://json-schema.org/draft-07/schema#',
  ...object({schemaVersion:{const:'1.0'},sessionId:ref,documentId:ref,snapshotId:ref,capturedAt:{type:'string',minLength:1},page,scope:object({ref,detail:{enum:['overview','region']}}),activeDialogRef:{oneOf:[ref,{type:'null'}]},nodes:{type:'array',minItems:1,maxItems:500,items:nodeSchema},coverage})
};
export const PAGE_ACTION_RESULT_SCHEMA = {
  $schema:'http://json-schema.org/draft-07/schema#',
  ...object({outcome:{enum:['completed','validation_failed','in_progress']},message:string,refreshRefs:refs,observationRequired:boolean},['outcome','observationRequired'])
};
const bindingEvidence = object({bindingRef:ref,action:ref,targetRef:ref,targetIdentity:ref,actionIdentity:ref,privateGuardIdentity:ref,canonical:ref,argumentBindings:{type:'object'},guardRefs:{...refs,minItems:1}},['bindingRef','action','targetRef','targetIdentity','actionIdentity','canonical','argumentBindings','guardRefs']);
const evidenceSchema = object({documentId:ref,snapshotId:ref,bindings:{type:'array',items:bindingEvidence}});
const captureBinding = object({binding:action,guardRefs:{...refs,minItems:1},targetIdentity:ref,actionIdentity:ref,privateGuardIdentity:ref},['binding','guardRefs','targetIdentity','actionIdentity']);
const captureSchema = object({page,nodes:{type:'array',minItems:1,items:nodeSchema},activeDialogRef:{oneOf:[ref,{type:'null'}]},coverage,bindings:{type:'array',items:captureBinding}});

/** A small interpreter avoids dynamic schema compilation on pages with strict CSP. */
function matches(input:unknown, schema:any):boolean {
  if(schema.oneOf && schema.oneOf.filter((part:any)=>matches(input,part)).length!==1) return false;
  if('const' in schema && input!==schema.const) return false;
  if(schema.enum && !schema.enum.includes(input)) return false;
  if(schema.type==='null' && input!==null) return false;
  if(schema.type==='string' && (typeof input!=='string' || input.length<(schema.minLength??0))) return false;
  if(schema.type==='boolean' && typeof input!=='boolean') return false;
  if(schema.type==='integer' && (!Number.isInteger(input) || (input as number)<(schema.minimum??-Infinity))) return false;
  if(schema.type==='array') {
    if(!Array.isArray(input) || input.length<(schema.minItems??0) || input.length>(schema.maxItems??Infinity)) return false;
    if(schema.uniqueItems && new Set(input.map(value=>JSON.stringify(value))).size!==input.length) return false;
    if(schema.items && !input.every(item=>matches(item,schema.items))) return false;
  }
  if(schema.type==='object') {
    if(!input || typeof input!=='object' || Array.isArray(input)) return false;
    const value=input as Record<string,unknown>;
    if(schema.required?.some((key:string)=>!Object.hasOwn(value,key))) return false;
    if(schema.additionalProperties===false && Object.keys(value).some(key=>!Object.hasOwn(schema.properties??{},key))) return false;
    if(schema.properties && Object.keys(schema.properties).some(key=>Object.hasOwn(value,key)&&!matches(value[key],schema.properties[key]))) return false;
  }
  return true;
}
function assertJson(value:unknown, active=new Set<object>(), depth=0):void {
  if(depth>64) throw new Error();
  if(value===null || typeof value==='string' || typeof value==='boolean') return;
  if(typeof value==='number' && Number.isFinite(value)) return;
  if(typeof value!=='object' || !value || active.has(value)) throw new Error();
  if(!Array.isArray(value) && Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null) throw new Error();
  if(Array.isArray(value) && (Object.keys(value).length!==value.length || Object.keys(value).some((key,index)=>key!==String(index)))) throw new Error();
  active.add(value);
  for(const key of Object.keys(value)) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor || !('value' in descriptor)) throw new Error();
    assertJson(descriptor.value,active,depth+1);
  }
  active.delete(value);
}
export function pageJsonBytes(value:unknown):number { return new TextEncoder().encode(JSON.stringify(value)).length; }
function checkStructure(value:unknown, schema:unknown):void { assertJson(value); if(!matches(value,schema)) throw new Error(); }
function nodeIndex(nodes:PageNode[]):Map<string,PageNode> {
  const index=new Map<string,PageNode>();
  for(const node of nodes) { if(index.has(node.ref)) throw new Error();index.set(node.ref,node); }
  for(const node of nodes) {
    for(const child of node.children??[]) if(!index.has(child) || child===node.ref) throw new Error();
    if(node.state?.blockedBy && index.get(node.state.blockedBy)?.kind!=='dialog') throw new Error();
    if(node.kind==='dialog') {
      if(!node.dialog.open) throw new Error();
      for(const blocked of node.dialog.blocks) if(!index.has(blocked)) throw new Error();
    }
    if(node.kind==='field' && (node.field.redacted || /password|secret|private/i.test(node.field.controlType)) && 'value' in node.field) throw new Error();
  }
  const complete=new Set<string>(), active=new Set<string>();
  const visit=(ref:string)=>{if(active.has(ref)) throw new Error();if(complete.has(ref)) return;active.add(ref);for(const child of index.get(ref)!.children??[])visit(child);active.delete(ref);complete.add(ref);};
  for(const ref of index.keys()) visit(ref);
  return index;
}
function actionIndex(nodes:PageNode[], index:Map<string,PageNode>):Map<string,PageActionBinding> {
  const actions=new Map<string,PageActionBinding>();
  for(const node of nodes) for(const action of node.actions??[]) {
    if(index.has(action.ref) || actions.has(action.ref) || !index.has(action.targetRef) || (action.callable&&!action.enabled) || (action.callable&&action.unavailableReason)) throw new Error();
    actions.set(action.ref,action);
  }
  return actions;
}
function checkCoverage(value:{coverage:PageCapture['coverage'];activeDialogRef:string|null}, index:Map<string,PageNode>):void {
  if(value.activeDialogRef && index.get(value.activeDialogRef)?.kind!=='dialog') throw new Error();
  for(const issue of value.coverage.issues) if(issue.ref && !index.has(issue.ref)) throw new Error();
  if(value.coverage.status==='complete' && (value.coverage.issues.length || value.coverage.truncated || value.coverage.nextCursor || [...index.values()].some(node=>node.kind==='unsupported'||node.truncation))) throw new Error();
  if(value.coverage.nextCursor && !value.coverage.truncated) throw new Error();
}
function checkGuard(binding:PageBindingCapture,index:Map<string,PageNode>):void {
  const refs=new Set(binding.guardRefs);
  if(refs.size!==binding.guardRefs.length || !refs.has(binding.binding.targetRef) || binding.guardRefs.some(ref=>!index.has(ref))) throw new Error();
  const visit=(ref:string)=>{if(!refs.has(ref)) throw new Error();for(const child of index.get(ref)!.children??[])visit(child);};
  visit(binding.binding.targetRef);
  const containsTarget=(ref:string):boolean=>ref===binding.binding.targetRef||(index.get(ref)!.children??[]).some(containsTarget);
  for(const ref of binding.guardRefs) {
    const kind=index.get(ref)!.kind;
    if(kind==='form'||(['row','field'].includes(kind)&&containsTarget(ref)))visit(ref);
  }
}
/** Raw synchronous captures may be larger than the public response, but never have an open shape. */
export function assertPageCapture(value:unknown):asserts value is PageCapture {
  try {
    checkStructure(value,captureSchema);
    const capture=value as PageCapture,index=nodeIndex(capture.nodes),actions=actionIndex(capture.nodes,index),seen=new Set<string>();
    checkCoverage(capture,index);
    for(const entry of capture.bindings) {
      if(seen.has(entry.binding.ref) || !actions.has(entry.binding.ref) || stableJson(actions.get(entry.binding.ref))!==stableJson(entry.binding)) throw new Error();
      checkGuard(entry,index);seen.add(entry.binding.ref);
    }
    for(const ref of actions.keys()) if(!seen.has(ref)) throw new Error();
  } catch { throw new PageError('ADAPTER_CONTRACT_VIOLATION'); }
}

export function assertObservationResult(value:unknown):asserts value is PageObservationResult {
  try {
    checkStructure(value,object({snapshot:PAGE_SNAPSHOT_SCHEMA,evidence:evidenceSchema}));
    const {snapshot,evidence}=value as PageObservationResult;
    if(pageJsonBytes(snapshot)>PAGE_PUBLIC_BYTE_LIMIT || pageJsonBytes(evidence)>PAGE_EVIDENCE_BYTE_LIMIT || pageJsonBytes(value)>120*1024) throw new Error();
    if(snapshot.documentId!==evidence.documentId || snapshot.snapshotId!==evidence.snapshotId || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error();
    const index=nodeIndex(snapshot.nodes),actions=actionIndex(snapshot.nodes,index),seen=new Set<string>();
    if(!index.has(snapshot.scope.ref)) throw new Error();checkCoverage(snapshot,index);
    for(const entry of evidence.bindings) {
      const binding=actions.get(entry.bindingRef);
      if(seen.has(entry.bindingRef) || !binding?.callable || !binding.enabled || binding.action!==entry.action || binding.targetRef!==entry.targetRef || stableJson(binding.argumentBindings)!==stableJson(entry.argumentBindings)) throw new Error();
      const capture={binding,guardRefs:entry.guardRefs,targetIdentity:entry.targetIdentity,actionIdentity:entry.actionIdentity,...(entry.privateGuardIdentity?{privateGuardIdentity:entry.privateGuardIdentity}:{})};
      checkGuard(capture,index);
      if(entry.guardRefs.some(ref=>index.get(ref)!.truncation || index.get(ref)!.kind==='unsupported') || entry.canonical!==buildBindingCanonical(snapshot,capture)) throw new Error();
      seen.add(entry.bindingRef);
    }
    for(const binding of actions.values()) if(binding.callable && !seen.has(binding.ref)) throw new Error();
  } catch { throw new PageError('ADAPTER_CONTRACT_VIOLATION'); }
}
export function assertPageActionResult(value:unknown,hasRef:(ref:string)=>boolean):asserts value is PageActionResult {
  try {
    checkStructure(value,PAGE_ACTION_RESULT_SCHEMA);
    if(pageJsonBytes(value)>PAGE_PUBLIC_BYTE_LIMIT || (value as PageActionResult).refreshRefs?.some(ref=>!hasRef(ref))) throw new Error();
  } catch { throw new PageError('ACTION_RESULT_CONTRACT_VIOLATION'); }
}
/** Deterministic JSON, never a hash, is used for the final execution comparison. */
export function stableJson(value:unknown):string {
  const sort=(value:any):any=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
  return JSON.stringify(sort(value));
}
