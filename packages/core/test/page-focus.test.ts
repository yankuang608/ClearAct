import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PagePerception} from '../src/page.ts';
import {assertObservationResult, pageJsonBytes} from '../src/page-schema.ts';

const code=(expected:string)=>(error:any)=>error?.code===expected;
function fixture() {
 const engine=new PagePerception('large-form',()=> 'handler');
 const page={}, form={}, fields=Array.from({length:90},()=>({}));
 let value='Visible draft', issue=false;
 engine.registerView({key:'form',kind:'form',root:()=>form});
 for(let i=0;i<fields.length;i++)for(const action of ['click','fill','press'])engine.registerActionBinding({key:`${i}-${action}`,action,viewKey:'form',target:()=>fields[i]!,trigger:()=>fields[i]!,objectKey:()=>String(i),guard:{scope:'form'}});
 engine.setAdapter({capture(_views,registrations,refs){
  const pageRef=refs.ref(page,'page'),formRef=refs.ref(form,'form'),fieldRefs=fields.map(field=>refs.ref(field,'field'));
  const bindings=registrations.map(registration=>{const i=Number(registration.objectKey());return {binding:{ref:refs.ref(registration,'binding',registration.objectKey()),action:registration.action,targetRef:fieldRefs[i]!,label:`Field ${i}`,enabled:true,callable:true,argumentBindings:{controlId:String(i)}},guardRefs:[formRef,...fieldRefs],targetIdentity:fieldRefs[i]!,actionIdentity:'handler'};});
  return {page:{url:'https://example.test/edit',title:'Large editor'},activeDialogRef:null,coverage:{status:issue?'partial':'complete',issues:issue?[{ref:fieldRefs[89]!,code:'clipped_text',message:'Partially clipped text'}]:[],truncated:false,nextCursor:null},nodes:[{ref:pageRef,kind:'page',children:[formRef]},{ref:formRef,kind:'form',children:fieldRefs},...fields.map((_field,i)=>({ref:fieldRefs[i]!,kind:'field' as const,name:`Field ${i}`,field:{controlType:'text',value:i===89?value:'A complete rendered field with a visible draft value.'},actions:bindings.filter(entry=>entry.binding.targetRef===fieldRefs[i]).map(entry=>entry.binding)}))],bindings};
 }});
 const overview=engine.observe();
 const broad=engine.observe({detail:'region',regionRef:overview.snapshot.nodes.find(node=>node.kind==='form')!.ref,limit:500});
 const target=broad.snapshot.nodes.find(node=>node.kind==='field')!;
 const binding=target.actions!.find(action=>action.action==='fill')!;
 const options={detail:'region' as const,regionRef:target.ref,bindingRef:binding.ref,limit:500};
 return {engine,broad,target,binding,options,change(next:string){value=next;},clip(){issue=true;}};
}
function execution(result:ReturnType<PagePerception['observe']>) {return {documentId:result.evidence.documentId,snapshotId:result.evidence.snapshotId,binding:result.evidence.bindings[0]!};}

test('focused observation delivers every form fact and only the selected binding within the original budgets',()=>{
 const f=fixture();
 assert.equal(f.broad.evidence.bindings.length,0);
 assert.equal(f.engine.observe({detail:'region',regionRef:f.target.ref}).evidence.bindings.length,0);
 const result=f.engine.observe(f.options);
 assert.equal(result.snapshot.nodes.filter(node=>node.kind==='field').length,90);
 assert.equal(result.snapshot.nodes.flatMap(node=>node.actions??[]).length,1);
 assert.equal(result.evidence.bindings.length,1);
 assert.equal(result.evidence.bindings[0]!.bindingRef,f.binding.ref);
 assert.ok(pageJsonBytes(result.snapshot)<=48*1024 && pageJsonBytes(result.evidence)<=48*1024);
 assert.equal(result.snapshot.coverage.truncated,false);
 assertObservationResult(result);
 assert.doesNotThrow(()=>f.engine.validate(execution(result),'fill',{controlId:'0',value:'new draft'}));
 f.change('Another field changed');
 assert.throws(()=>f.engine.validate(execution(result),'fill',{controlId:'0'}),code('CONTEXT_CHANGED'));
});

test('focused pagination cannot authorize omitted guard facts or reuse a cursor for another binding',()=>{
 const f=fixture(),options={...f.options,limit:10};
 const result=f.engine.observe(options);
 assert.equal(result.snapshot.nodes.length,10);
 assert.equal(result.evidence.bindings.length,0);
 assert.ok(result.snapshot.coverage.nextCursor);
 const cursor=result.snapshot.coverage.nextCursor!;
 assert.throws(()=>f.engine.observe({...options,bindingRef:f.target.actions![0]!.ref,cursor}),code('STALE_CURSOR'));
 const seen=new Set(result.snapshot.nodes.map(node=>node.ref));let next:string|null=result.snapshot.coverage.nextCursor;
 while(next){const page=f.engine.observe({...options,cursor:next});assertObservationResult(page);assert.equal(page.evidence.bindings.length,0);assert.ok(page.snapshot.nodes.some(node=>!seen.has(node.ref)));page.snapshot.nodes.forEach(node=>seen.add(node.ref));next=page.snapshot.coverage.nextCursor;}
 assert.equal(seen.size,91);
});

test('focused reads preserve clipped and oversized guard refusals',()=>{
 const f=fixture();f.clip();
 const result=f.engine.observe(f.options);
 assert.equal(result.evidence.bindings.length,0);
 assert.ok(result.snapshot.coverage.issues.some(issue=>issue.code==='clipped_text'));
 const oversized=fixture();oversized.change('Rendered long draft '.repeat(10000));
 const partial=oversized.engine.observe(oversized.options);
 assert.equal(partial.evidence.bindings.length,0);assertObservationResult(partial);
});

test('focused reads reject guessed, out-of-region and malformed binding references',()=>{
 const f=fixture();
 assert.throws(()=>f.engine.observe({...f.options,bindingRef:'guessed'}),code('UNKNOWN_REF'));
 const other=f.broad.snapshot.nodes.filter(node=>node.kind==='field')[1]!;
 assert.throws(()=>f.engine.observe({...f.options,bindingRef:other.actions![0]!.ref}),code('UNKNOWN_REF'));
 for(const options of [{bindingRef:f.binding.ref},{detail:'overview',bindingRef:f.binding.ref},{...f.options,bindingRef:''},{...f.options,bindingRef:4}])assert.throws(()=>f.engine.observe(options as any),code('ADAPTER_CONTRACT_VIOLATION'));
});
