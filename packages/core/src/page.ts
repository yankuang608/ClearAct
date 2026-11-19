// SPDX-License-Identifier: MIT
import {assertObservationResult, assertPageCapture, PAGE_EVIDENCE_BYTE_LIMIT, PAGE_PUBLIC_BYTE_LIMIT, pageJsonBytes, stableJson} from './page-schema.ts';
import type {ExecutionObservation, PageActionBinding, PageActionBindingRegistration, PageAdapter, PageBindingCapture, PageBindingEvidence, PageCapture, PageCoverageIssue, PageNode, PageObservationOptions, PageObservationResult, PageReferences, PageSnapshot, PageViewRegistration} from './page-types.ts';

const messages:Record<string,string> = {
  PAGE_OBSERVATION_UNSUPPORTED:'Page observation is not supported.', PAGE_CONTEXT_REQUIRES_OBSERVE:'Use asynchronous page observation.',
  PAGE_NOT_VISIBLE:'The page is not visible.', PAGE_NOT_READY:'The page is not ready.', OBSERVATION_TIMEOUT:'Page observation timed out.', PAGE_DISCONNECTED:'The page is disconnected.',
  UNKNOWN_REF:'The requested page reference is unavailable.', STALE_CURSOR:'The rendered region or read options changed. Read the region again.',
  OBSERVATION_REQUIRED:'A delivered page observation is required.', OBSERVATION_EXPIRED:'The page observation expired.', OBSERVATION_INCOMPLETE:'Read the complete related region before invoking this action.',
  TARGET_CHANGED:'The observed page object is no longer the same.', CONTEXT_CHANGED:'The related page context changed. Observe it again.',
  ACTION_UNAVAILABLE:'The page action is currently unavailable.', BINDING_MISMATCH:'The action or fixed arguments do not match the observed page object.',
  ADAPTER_CONTRACT_VIOLATION:'The page adapter did not produce a valid synchronous observation.',
  ACTION_RESULT_CONTRACT_VIOLATION:'The action returned an invalid page result. The business action may already have run.'
};
export class PageError extends Error {
  readonly code:string;
  readonly refreshRefs?:string[];
  constructor(code:string,refreshRefs?:string[]) {
    super(messages[code]??'Page perception could not complete.');this.name='PageError';this.code=code;
    if(refreshRefs?.length) this.refreshRefs=[...refreshRefs];
  }
}
function normalizedBinding(binding:PageActionBinding):Record<string,unknown> {
  const {callable:_callable,unavailableReason:_unavailable,...facts}=binding;return facts;
}
function normalizedNode(node:PageNode,guard:Set<string>):Record<string,unknown> {
  const {revision:_revision,detailAvailable:_detail,actions:_actions,...facts}=node;
  return {...facts,...(node.children?{children:node.children.filter(ref=>guard.has(ref))}:{}),...(node.kind==='dialog'?{dialog:{...node.dialog,blocks:node.dialog.blocks.filter(ref=>guard.has(ref))}}:{})};
}
/** Compare full deterministic public facts and opaque browser-local private-guard identity; never private values or hashes. */
export function buildBindingCanonical(snapshot:Pick<PageSnapshot,'page'|'activeDialogRef'|'nodes'>,capture:PageBindingCapture):string {
  const guard=new Set(capture.guardRefs),index=new Map(snapshot.nodes.map(node=>[node.ref,node]));
  if(!guard.has(capture.binding.targetRef) || capture.guardRefs.some(ref=>!index.has(ref))) throw new PageError('ADAPTER_CONTRACT_VIOLATION');
  return stableJson({page:{url:snapshot.page.url},activeDialogRef:snapshot.activeDialogRef,binding:normalizedBinding(capture.binding),targetIdentity:capture.targetIdentity,actionIdentity:capture.actionIdentity,...(capture.privateGuardIdentity?{privateGuardIdentity:capture.privateGuardIdentity}:{}),nodes:[...guard].sort().map(ref=>normalizedNode(index.get(ref)!,guard))});
}
interface Cursor {documentId:string;scopeRef:string;detail:'overview'|'region';limit:number;offset:number;fingerprint:string;createdAt:number}
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const kinds=new Set(['page','region','text','table','row','cell','form','field','dialog','control','unsupported']);

export class PagePerception {
  private instanceId=crypto.randomUUID();
  get documentId():string { return this.instanceId; }
  private adapter?:PageAdapter;
  private views=new Map<string,PageViewRegistration>();
  private bindings=new Map<string,PageActionBindingRegistration>();
  private references=new WeakMap<object,Map<string,{objectKey:string|undefined;ref:string}>>();
  private issued=new Set<string>();
  private exposed=new Set<string>();
  private current=new Set<string>();
  private currentBindings=new Map<string,PageActionBindingRegistration>();
  private cursors=new Map<string,Cursor>();
  private readonly refs:PageReferences={ref:(identity,kind,objectKey)=>{
    if(!identity || typeof identity!=='object' || !kind || (objectKey!==undefined&&typeof objectKey!=='string')) throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    let kinds=this.references.get(identity);if(!kinds) {kinds=new Map();this.references.set(identity,kinds);}
    const previous=kinds.get(kind);if(previous&&previous.objectKey===objectKey) return previous.ref;
    const ref=crypto.randomUUID();kinds.set(kind,{objectKey,ref});this.issued.add(ref);return ref;
  }};
  constructor(private readonly sessionId:string,private readonly actionIdentity:(name:string)=>string|undefined) {}
  setAdapter(adapter:PageAdapter):void {
    if(!adapter || typeof adapter.capture!=='function') throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    this.adapter=adapter;
  }
  registerView(view:PageViewRegistration):()=>void {
    if(!view || !view.key || !kinds.has(view.kind) || typeof view.root!=='function' || (view.read!==undefined&&typeof view.read!=='function') || this.views.has(view.key) || (view.ownerKey!==undefined&&(typeof view.ownerKey!=='string'||!view.ownerKey))) throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    this.views.set(view.key,view);
    return ()=>{if(this.views.get(view.key)!==view)return;this.views.delete(view.key);for(const [key,binding] of this.bindings)if(binding.viewKey===view.key)this.bindings.delete(key);this.currentBindings.clear();};
  }
  registerActionBinding(binding:PageActionBindingRegistration):()=>void {
    if(!binding || !binding.key || !binding.action || !this.views.has(binding.viewKey) || !['target','row','form','selection'].includes(binding.guard?.scope) || [binding.target,binding.trigger,binding.objectKey].some(value=>typeof value!=='function') || (binding.argumentBindings!==undefined&&typeof binding.argumentBindings!=='function')) throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    const key=JSON.stringify([binding.viewKey,binding.key]);if(this.bindings.has(key))throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    this.bindings.set(key,binding);
    return ()=>{if(this.bindings.get(key)===binding){this.bindings.delete(key);for(const [ref,current] of this.currentBindings)if(current===binding)this.currentBindings.delete(ref);}};
  }
  hasRef(ref:string):boolean { return this.exposed.has(ref)&&this.current.has(ref); }
  resetDocument():void {
    this.instanceId=crypto.randomUUID();this.references=new WeakMap();this.issued.clear();this.exposed.clear();this.current.clear();this.currentBindings.clear();this.cursors.clear();
    try {this.adapter?.reset?.();} catch {throw new PageError('ADAPTER_CONTRACT_VIOLATION');}
  }
  private capture():PageCapture {
    if(!this.adapter)throw new PageError('PAGE_NOT_READY');
    try {
      const capture=this.adapter.capture([...this.views.values()],[...this.bindings.values()],this.refs,this.actionIdentity);
      if(capture&&typeof (capture as unknown as {then?:unknown}).then==='function') {void Promise.resolve(capture).catch(()=>{});throw new PageError('ADAPTER_CONTRACT_VIOLATION');}
      assertPageCapture(capture);
      for(const node of capture.nodes)if(!this.issued.has(node.ref))throw new PageError('ADAPTER_CONTRACT_VIOLATION');
      const registrations=new Map<string,PageActionBindingRegistration>();
      for(const binding of this.bindings.values())registrations.set(this.refs.ref(binding,'binding',binding.objectKey()),binding);
      for(const entry of capture.bindings) {
        const registration=registrations.get(entry.binding.ref);
        if(!registration || registration.action!==entry.binding.action || this.actionIdentity(entry.binding.action)!==entry.actionIdentity)throw new PageError('ADAPTER_CONTRACT_VIOLATION');
      }
      this.current=new Set(capture.nodes.map(node=>node.ref));
      this.currentBindings=new Map(capture.bindings.map(entry=>[entry.binding.ref,registrations.get(entry.binding.ref)!]));
      return capture;
    } catch(error) {
      if(error instanceof PageError)throw error;
      const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
      if(code==='PAGE_NOT_VISIBLE'||code==='PAGE_NOT_READY')throw new PageError(code);
      throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    }
  }
  resolveTrigger(bindingRef:string):object|null {
    if(!this.exposed.has(bindingRef))return null;
    try {
      const capture=this.capture();if(!capture.bindings.some(entry=>entry.binding.ref===bindingRef))return null;
      const registration=this.currentBindings.get(bindingRef);return registration?(this.adapter?.resolveTrigger?this.adapter.resolveTrigger(registration):registration.trigger()):null;
    } catch {return null;}
  }
  validate(evidence:ExecutionObservation,action:string,args:Record<string,unknown>):void {
    if(!evidence?.binding || !evidence.snapshotId)throw new PageError('OBSERVATION_REQUIRED');
    if(evidence.documentId!==this.documentId)throw new PageError('TARGET_CHANGED');
    const observed=evidence.binding;
    if(observed.action!==action || !args || typeof args!=='object' || Array.isArray(args) || Object.entries(observed.argumentBindings).some(([key,value])=>!Object.hasOwn(args,key)||stableJson(args[key])!==stableJson(value)))throw new PageError('BINDING_MISMATCH');
    const capture=this.capture(),binding=capture.bindings.find(entry=>entry.binding.ref===observed.bindingRef);
    if(!binding || binding.targetIdentity!==observed.targetIdentity || binding.binding.targetRef!==observed.targetRef)throw new PageError('TARGET_CHANGED');
    if(binding.actionIdentity!==observed.actionIdentity)throw new PageError('CONTEXT_CHANGED',[binding.binding.targetRef]);
    let prior:{page?:{url?:string};activeDialogRef?:string|null};
    try {prior=JSON.parse(observed.canonical);}catch {throw new PageError('CONTEXT_CHANGED');}
    if(prior.page?.url!==capture.page.url || prior.activeDialogRef!==capture.activeDialogRef)throw new PageError('CONTEXT_CHANGED',[binding.binding.targetRef]);
    if(!binding.binding.enabled)throw new PageError('ACTION_UNAVAILABLE',[binding.binding.targetRef]);
    if(!binding.binding.callable || !this.completeGuard(binding,new Map(capture.nodes.map(node=>[node.ref,node])),capture.coverage.issues))throw new PageError('OBSERVATION_INCOMPLETE',[binding.binding.targetRef]);
    if(buildBindingCanonical(capture,binding)!==observed.canonical)throw new PageError('CONTEXT_CHANGED',[binding.binding.targetRef]);
  }
  private completeGuard(binding:PageBindingCapture,nodes:Map<string,PageNode>,issues:PageCoverageIssue[]):boolean {
    const refs=new Set(binding.guardRefs);
    return binding.guardRefs.every(ref=>nodes.has(ref)&&!nodes.get(ref)!.truncation&&nodes.get(ref)!.kind!=='unsupported') && !issues.some(issue=>!issue.ref||refs.has(issue.ref));
  }
  observe(options:PageObservationOptions={}):PageObservationResult {
    if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(key=>!['detail','regionRef','bindingRef','cursor','limit'].includes(key)))throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    const detail=options.detail??'overview',limit=options.limit??200;
    if(!['overview','region'].includes(detail) || !Number.isInteger(limit) || limit<1 || limit>500 || (detail==='region'&&(!options.regionRef||typeof options.regionRef!=='string')) || (detail==='overview'&&options.regionRef!==undefined) || (options.cursor!==undefined&&(typeof options.cursor!=='string'||!options.cursor)))throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    if(options.bindingRef!==undefined&&(detail!=='region'||typeof options.bindingRef!=='string'||!options.bindingRef))throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    const capture=this.capture(),index=new Map(capture.nodes.map(node=>[node.ref,node]));
    const root=detail==='region'?index.get(options.regionRef!):(capture.nodes.find(node=>node.kind==='page')??capture.nodes[0]);
    if(!root || (detail==='region'&&!this.hasRef(root.ref)))throw new PageError('UNKNOWN_REF');
    const ordered:PageNode[]=[],visited=new Set<string>();
    const visit=(ref:string,hidden=false)=>{
      if(visited.has(ref))return;visited.add(ref);const node=index.get(ref)!;
      const omit=detail==='overview'&&(hidden||['row','cell','field'].includes(node.kind));
      if(!omit)ordered.push(node);
      const hideChildren=detail==='overview'&&(omit||node.kind==='form');
      for(const child of node.children??[])visit(child,hideChildren);
    };
    visit(root.ref);
    // Portals and top-level directories can be siblings of the page root in adapter output.
    if(detail==='overview')for(const node of capture.nodes)if(!visited.has(node.ref)&&['region','table','form','dialog','unsupported'].includes(node.kind))visit(node.ref);
    // A focused read delivers all guard facts while omitting other action catalogs.
    // It still obeys the same response budgets and never assembles evidence across pages.
    if(options.bindingRef) {
      const focused=capture.bindings.find(entry=>entry.binding.ref===options.bindingRef);
      if(!this.exposed.has(options.bindingRef)||!focused||!visited.has(focused.binding.targetRef))throw new PageError('UNKNOWN_REF');
      for(const ref of focused.guardRefs)if(!visited.has(ref)){visited.add(ref);ordered.push(index.get(ref)!);}
    }
    const scopeRefs=new Set(ordered.map(node=>node.ref));
    const supports=[root];
    const support=(ref:string|null|undefined)=>{if(ref&&!supports.some(node=>node.ref===ref)&&index.has(ref))supports.push(index.get(ref)!);};
    support(capture.activeDialogRef);for(const node of ordered)support(node.state?.blockedBy);
    if(supports.length>limit)throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    const fingerprint=sha256(stableJson({page:{url:capture.page.url},activeDialogRef:capture.activeDialogRef,bindingRef:options.bindingRef??null,nodes:ordered.map(node=>normalizedNode(node,scopeRefs)),bindings:capture.bindings.filter(entry=>scopeRefs.has(entry.binding.targetRef)).map(entry=>({...entry,binding:normalizedBinding(entry.binding)})),coverage:capture.coverage}));
    const now=Date.now();for(const [id,cursor]of this.cursors)if(now-cursor.createdAt>300000)this.cursors.delete(id);
    let offset=0;
    if(options.cursor) {
      const cursor=this.cursors.get(options.cursor);
      if(!cursor || cursor.documentId!==this.documentId || cursor.scopeRef!==root.ref || cursor.detail!==detail || cursor.limit!==limit || cursor.fingerprint!==fingerprint)throw new PageError('STALE_CURSOR');
      offset=cursor.offset;
    }
    const snapshotId=crypto.randomUUID(),capturedAt=new Date(now).toISOString(),nextCursorId=crypto.randomUUID();
    const selected=new Map(supports.map(node=>[node.ref,copy(node)]));
    let position=offset,stoppedBy:'NODE_LIMIT'|'PUBLIC_BYTE_LIMIT'|undefined;
    const assemble=(hasMore:boolean):PageObservationResult=>{
      const refs=new Set(selected.keys()),delivered=new Map<string,PageNode>();
      for(const original of selected.values()) {
        const node=copy(original);
        if(node.children) {node.children=node.children.filter(ref=>refs.has(ref));if(node.children.length!==(index.get(node.ref)?.children?.length??0))node.detailAvailable=true;}
        if(node.kind==='dialog')node.dialog.blocks=node.dialog.blocks.filter(ref=>refs.has(ref));
        if(node.state?.blockedBy&&!refs.has(node.state.blockedBy))delete node.state.blockedBy;
        if(node.actions) {
          node.actions=node.actions.filter(binding=>refs.has(binding.targetRef)&&(!options.bindingRef||binding.ref===options.bindingRef));
          if(options.bindingRef&&node.actions.length!==(index.get(node.ref)?.actions?.length??0))node.detailAvailable=true;
          if(!node.actions.length)delete node.actions;
        }
        delivered.set(node.ref,node);
      }
      const issues:PageCoverageIssue[]=capture.coverage.issues.filter(issue=>!issue.ref||scopeRefs.has(issue.ref)).map(issue=>issue.ref&&!refs.has(issue.ref)?{code:issue.code,message:issue.message}:copy(issue));
      for(const node of delivered.values())if(node.truncation)issues.push({ref:node.ref,code:'TRUNCATED_NODE',message:'This node exceeded the response budget; its content is truncated.'});
      if(hasMore||offset>0)issues.push({ref:root.ref,code:stoppedBy??'NODE_LIMIT',message:`Rendered node range ${offset}–${position} of ${ordered.length} is included. Read another protocol page for omitted nodes.`});
      const snapshot:PageSnapshot={schemaVersion:'1.0',sessionId:this.sessionId,documentId:this.documentId,snapshotId,capturedAt,page:copy(capture.page),scope:{ref:root.ref,detail},activeDialogRef:capture.activeDialogRef,nodes:[...delivered.values()],coverage:{status:'complete',issues,truncated:hasMore||offset>0||[...delivered.values()].some(node=>!!node.truncation),nextCursor:hasMore&&limit>supports.length?nextCursorId:null}};
      const evidence:PageObservationResult['evidence']={documentId:this.documentId,snapshotId,bindings:[]};
      for(const node of delivered.values())for(const action of node.actions??[]) {
        const entry=capture.bindings.find(entry=>entry.binding.ref===action.ref);
        action.callable=!!entry&&action.enabled&&entry.binding.callable&&this.completeGuard(entry,delivered,capture.coverage.issues);
        delete action.unavailableReason;
        if(!action.callable) {if(action.enabled)action.unavailableReason='observation_incomplete';continue;}
        const observed:PageBindingEvidence={bindingRef:entry!.binding.ref,action:entry!.binding.action,targetRef:entry!.binding.targetRef,targetIdentity:entry!.targetIdentity,actionIdentity:entry!.actionIdentity,...(entry!.privateGuardIdentity?{privateGuardIdentity:entry!.privateGuardIdentity}:{}),canonical:'',argumentBindings:copy(entry!.binding.argumentBindings),guardRefs:[...entry!.guardRefs]};
        observed.canonical=buildBindingCanonical(snapshot,entry!);
        if(pageJsonBytes({...evidence,bindings:[...evidence.bindings,observed]})>PAGE_EVIDENCE_BYTE_LIMIT) {
          action.callable=false;action.unavailableReason='observation_incomplete';issues.push({ref:action.targetRef,code:'EVIDENCE_LIMIT',message:'The complete action evidence does not fit in this observation.'});
        } else evidence.bindings.push(observed);
      }
      // Callable and its protocol reason are excluded from all canonical comparisons.
      for(const observed of evidence.bindings)observed.canonical=buildBindingCanonical(snapshot,{binding:delivered.get(observed.targetRef)?.actions?.find(action=>action.ref===observed.bindingRef)??capture.bindings.find(entry=>entry.binding.ref===observed.bindingRef)!.binding,guardRefs:observed.guardRefs,targetIdentity:observed.targetIdentity,actionIdentity:observed.actionIdentity,...(observed.privateGuardIdentity?{privateGuardIdentity:observed.privateGuardIdentity}:{})});
      if(issues.length||snapshot.coverage.truncated||snapshot.nodes.some(node=>node.kind==='unsupported')||(capture.coverage.status==='partial'&&!capture.coverage.issues.length))snapshot.coverage.status='partial';
      return {snapshot,evidence};
    };
    let initial=assemble(true),attempts=0;
    while(pageJsonBytes(initial.snapshot)>PAGE_PUBLIC_BYTE_LIMIT&&attempts++<64) {for(const node of selected.values())shrinkNode(node);initial=assemble(true);}
    if(pageJsonBytes(initial.snapshot)>PAGE_PUBLIC_BYTE_LIMIT)throw new PageError('ADAPTER_CONTRACT_VIOLATION');
    while(position<ordered.length) {
      const node=ordered[position]!;
      if(selected.has(node.ref)){position++;continue;}
      if(selected.size>=limit){stoppedBy='NODE_LIMIT';break;}
      selected.set(node.ref,copy(node));
      let candidate=assemble(position+1<ordered.length);
      if(pageJsonBytes(candidate.snapshot)>PAGE_PUBLIC_BYTE_LIMIT) {
        if(selected.size>supports.length+1 && pageJsonBytes(node)<PAGE_PUBLIC_BYTE_LIMIT-2048) {selected.delete(node.ref);stoppedBy='PUBLIC_BYTE_LIMIT';break;}
        let trims=0;
        while(pageJsonBytes(candidate.snapshot)>PAGE_PUBLIC_BYTE_LIMIT&&trims++<64){shrinkNode(selected.get(node.ref)!);candidate=assemble(position+1<ordered.length);}
        if(pageJsonBytes(candidate.snapshot)>PAGE_PUBLIC_BYTE_LIMIT){selected.delete(node.ref);stoppedBy='PUBLIC_BYTE_LIMIT';break;}
      }
      position++;
    }
    let result=assemble(position<ordered.length);
    // A longer omission explanation must not push an otherwise full response over its cap.
    while(pageJsonBytes(result.snapshot)>PAGE_PUBLIC_BYTE_LIMIT&&selected.size>supports.length) {
      const last=[...selected.keys()].at(-1)!;selected.delete(last);position=Math.max(offset,ordered.findIndex(node=>node.ref===last));stoppedBy='PUBLIC_BYTE_LIMIT';result=assemble(true);
    }
    if(result.snapshot.coverage.nextCursor) {
      this.cursors.set(nextCursorId,{documentId:this.documentId,scopeRef:root.ref,detail,limit,offset:position,fingerprint,createdAt:now});
      while(this.cursors.size>64)this.cursors.delete(this.cursors.keys().next().value!);
    }
    assertObservationResult(result);
    for(const node of result.snapshot.nodes){this.exposed.add(node.ref);for(const action of node.actions??[])this.exposed.add(action.ref);}
    return result;
  }
}

/** A node is never split into invalid JSON; all omitted content is marked on that node. */
function shrinkNode(node:PageNode):void {
  node.truncation={reason:'content_budget'};
  const candidates:{container:any;key:string|number;size:number;array?:boolean}[]=[];
  const protectedKeys=new Set(['ref','kind','columnKey','controlType','key','action','targetRef','unavailableReason','source','reason','argumentBindings','children','blocks']);
  const visit=(value:any)=>{
    for(const key of Object.keys(value)) {
      if(protectedKeys.has(key))continue;
      const field=value[key];
      if(typeof field==='string'&&field.length)candidates.push({container:value,key,size:field.length});
      else if(Array.isArray(field)&&field.length>1)candidates.push({container:value,key,size:JSON.stringify(field).length,array:true});
      else if(field&&typeof field==='object')visit(field);
    }
  };
  visit(node);candidates.sort((a,b)=>b.size-a.size);
  const largest=candidates[0];
  if(largest) {
    const value=largest.container[largest.key];
    largest.container[largest.key]=largest.array?value.slice(0,Math.floor(value.length/2)):Array.from(value).slice(0,Math.floor(Array.from(value).length/2)).join('');
    return;
  }
  if(node.actions?.length){delete node.actions;return;}
  if(node.kind==='table'&&node.table.columns?.length){node.table.columns=[];return;}
  if(node.kind==='field')delete node.field.value;
  if(node.kind==='control')delete node.control.value;
}

/** SHA-256 is only a cursor content fingerprint; execution always compares the full canonical JSON. */
function sha256(value:string):string {
  const bytes=new TextEncoder().encode(value),length=bytes.length,padded=new Uint8Array(Math.ceil((length+9)/64)*64);padded.set(bytes);padded[length]=0x80;
  const view=new DataView(padded.buffer);view.setUint32(padded.length-8,Math.floor(length/0x20000000));view.setUint32(padded.length-4,(length*8)>>>0);
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Uint32Array(64),rotr=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
  for(let offset=0;offset<padded.length;offset+=64) {
    for(let i=0;i<16;i++)w[i]=view.getUint32(offset+4*i);
    for(let i=16;i<64;i++){const a=w[i-15]!,b=w[i-2]!;w[i]=((rotr(a,7)^rotr(a,18)^(a>>>3))+w[i-16]!+(rotr(b,17)^rotr(b,19)^(b>>>10))+w[i-7]!)>>>0;}
    let [a,b,c,d,e,f,g,hh]=h as [number,number,number,number,number,number,number,number];
    for(let i=0;i<64;i++){const t1=(hh+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+k[i]!+w[i]!)>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    const state=[a,b,c,d,e,f,g,hh];for(let i=0;i<8;i++)h[i]=(h[i]!+state[i]!)>>>0;
  }
  return h.map(value=>value.toString(16).padStart(8,'0')).join('');
}
