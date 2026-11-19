import {test} from 'node:test';
import assert from 'node:assert/strict';

async function api() {
  const page = await import('../src/page.ts').catch(() => undefined);
  const schema = await import('../src/page-schema.ts').catch(() => undefined);
  assert.ok(page?.PagePerception && schema?.assertObservationResult, 'Page perception protocol must be available without DOM globals');
  const validateObservation:(value:unknown)=>void=schema.assertObservationResult;
  const validateResult:(value:unknown,hasRef:(ref:string)=>boolean)=>void=schema.assertPageActionResult;
  return {...page, ...schema,assertObservationResult:validateObservation,assertPageActionResult:validateResult};
}

function completeCoverage() { return {status:'complete' as const,issues:[],truncated:false,nextCursor:null}; }
function errorCode(code:string) { return (error:unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code; }

async function fixture(rowCount=2) {
  const {PagePerception, ...rest} = await api();
  let route='https://example.test/orders', notice='Saved', filter='Open', currentId='1048', amount='¥12.50', enabled=true, modal=false, identity='edit-handler-1';
  const pageRoot={}, tableRoot={}, noticeRoot={}, trigger={}, modalRoot={};
  const rows=Array.from({length:rowCount},()=>({row:{},cell:{}}));
  let version=1;
  const engine = new PagePerception('orders-page', name => name==='orders.edit' ? identity : undefined);
  engine.registerView({key:'orders',kind:'table',root:()=>tableRoot});
  const registration={key:'edit',viewKey:'orders',action:'orders.edit',target:()=>rows[0]!.row,trigger:()=>trigger,objectKey:()=>currentId,guard:{scope:'row' as const}};
  engine.registerActionBinding(registration);
  const adapter={
    capture(_views:any[],bindings:any[],refs:any, actionIdentity:(name:string)=>string|undefined) {
      const pageRef=refs.ref(pageRoot,'page'), tableRef=refs.ref(tableRoot,'table'), noticeRef=refs.ref(noticeRoot,'region');
      const rowRefs=rows.map((objects,index)=>refs.ref(objects.row,'row',index===0 ? currentId : `other-${index}`));
      const cellRefs=rows.map((objects,index)=>refs.ref(objects.cell,'cell',index===0 ? currentId : `other-${index}`));
      const binding={ref:refs.ref(bindings[0],'binding',currentId),action:'orders.edit',targetRef:rowRefs[0],label:'Edit',enabled,callable:enabled,argumentBindings:{orderId:currentId}};
      const nodes:any[]=[
        {ref:pageRef,kind:'page',children:[tableRef,noticeRef]},
        {ref:tableRef,kind:'table',revision:version,name:'Orders',table:{filterText:filter,renderedRows:rowCount},children:rowRefs},
        ...rows.flatMap((_objects,index)=>[
          {ref:rowRefs[index],kind:'row',children:[cellRefs[index]],...(index===0?{actions:[binding]}:{})},
          {ref:cellRefs[index],kind:'cell',columnKey:'amount',text:index===0?amount:`Other ${index}`}
        ]),
        {ref:noticeRef,kind:'region',name:notice}
      ];
      const dialogRef=modal?refs.ref(modalRoot,'dialog'):null;
      if(dialogRef) nodes.push({ref:dialogRef,kind:'dialog',name:'Confirmation',dialog:{open:true,modal:true,blocks:[tableRef]}});
      return {page:{url:route,title:'Orders'},nodes,activeDialogRef:dialogRef,coverage:completeCoverage(),bindings:[{binding,guardRefs:[tableRef,rowRefs[0],cellRefs[0]],targetIdentity:currentId,actionIdentity:actionIdentity('orders.edit')!}]};
    },
    resolveTrigger(binding:any) { return binding.trigger(); }
  };
  engine.setAdapter(adapter);
  return {engine,adapter,...rest,change(values:Record<string,unknown>) {
    if('route' in values) route=values.route as string;
    if('notice' in values) notice=values.notice as string;
    if('filter' in values) filter=values.filter as string;
    if('currentId' in values) currentId=values.currentId as string;
    if('amount' in values) amount=values.amount as string;
    if('enabled' in values) enabled=values.enabled as boolean;
    if('modal' in values) modal=values.modal as boolean;
    if('identity' in values) identity=values.identity as string;
    version++;
  },trigger};
}
function tableRef(result:any) { return result.snapshot.nodes.find((node:any)=>node.kind==='table')!.ref as string; }
function execution(result:any) { return {documentId:result.evidence.documentId,snapshotId:result.evidence.snapshotId,binding:result.evidence.bindings[0]}; }
function bytes(value:unknown) { return new TextEncoder().encode(JSON.stringify(value)).length; }
function assertClosed(snapshot:any) {
  const refs=new Set(snapshot.nodes.map((node:any)=>node.ref));
  assert.ok(refs.has(snapshot.scope.ref));
  for(const node of snapshot.nodes) {
    for(const child of node.children??[]) assert.ok(refs.has(child),`missing child ${child}`);
    for(const action of node.actions??[]) assert.ok(refs.has(action.targetRef));
    for(const ref of node.dialog?.blocks??[]) assert.ok(refs.has(ref));
    if(node.state?.blockedBy) assert.ok(refs.has(node.state.blockedBy));
  }
  if(snapshot.activeDialogRef) assert.ok(refs.has(snapshot.activeDialogRef));
}

// Missing exports or eager browser reads break server-only imports.
test('page perception imports in Node and overview does not disclose row details',async()=>{
  const {engine,assertObservationResult}=await fixture();
  const result=engine.observe();
  assert.deepEqual(result.snapshot.nodes.map(node=>node.kind),['page','table','region']);
  assert.equal(result.snapshot.scope.detail,'overview');
  assert.equal(result.snapshot.nodes.find(node=>node.kind==='table')!.detailAvailable,true);
  assert.equal(JSON.stringify(result).includes('¥12.50'),false);
  assert.equal(result.evidence.bindings.length,0);
  assertClosed(result.snapshot); assertObservationResult(result);
});

// Region reads must reveal currently rendered descendants and keep evidence tied to delivered objects.
test('region read supplies complete row evidence and resolves the observed trigger',async()=>{
  const {engine,assertObservationResult,trigger}=await fixture();
  const overview=engine.observe();
  const result=engine.observe({detail:'region',regionRef:tableRef(overview)});
  assert.deepEqual(result.snapshot.nodes.map(node=>node.kind),['table','row','cell','row','cell']);
  assert.equal(result.snapshot.nodes.find(node=>node.kind==='cell')!.text,'¥12.50');
  assert.equal(result.evidence.bindings.length,1);
  assert.equal(result.snapshot.nodes.find(node=>node.kind==='row')!.actions![0]!.callable,true);
  engine.validate(execution(result),'orders.edit',{orderId:'1048',newAddress:'User supplied'});
  assert.equal(engine.resolveTrigger(result.evidence.bindings[0]!.bindingRef),trigger);
  assertClosed(result.snapshot); assertObservationResult(result);
});

// Revision counters and independent area updates cannot be used as global invalidation.
test('final comparison ignores independent notices and revision changes',async()=>{
  const {engine,change}=await fixture(); const overview=engine.observe();
  const result=engine.observe({detail:'region',regionRef:tableRef(overview)});
  change({notice:'A new notification'});
  assert.doesNotThrow(()=>engine.validate(execution(result),'orders.edit',{orderId:'1048'}));
});

// Related rendered facts, filter conditions and identity changes must prevent the actual handler boundary.
for(const [label,changeValue] of [
  ['target display',{amount:'¥99.00'}],['table filter',{filter:'Closed'}],['soft route',{route:'https://example.test/archived'}],
  ['top modal',{modal:true}],['availability',{enabled:false}],['recycled target',{currentId:'9999'}],['action registration',{identity:'edit-handler-2'}]
] as const) test(`final comparison rejects changed ${label}`,async()=>{
  const {engine,change}=await fixture();const overview=engine.observe();const result=engine.observe({detail:'region',regionRef:tableRef(overview)});
  change(changeValue);
  assert.throws(()=>engine.validate(execution(result),'orders.edit',{orderId:'1048'}),errorCode(label==='recycled target'?'TARGET_CHANGED':label==='availability'?'ACTION_UNAVAILABLE':'CONTEXT_CHANGED'));
});

test('fixed arguments and action names cannot be replaced in an observation',async()=>{
  const {engine}=await fixture();const result=engine.observe({detail:'region',regionRef:tableRef(engine.observe())});
  assert.throws(()=>engine.validate(execution(result),'orders.edit',{orderId:'9999'}),errorCode('BINDING_MISMATCH'));
  assert.throws(()=>engine.validate(execution(result),'orders.delete',{orderId:'1048'}),errorCode('BINDING_MISMATCH'));
  assert.throws(()=>engine.validate({...execution(result),binding:{...execution(result).binding,bindingRef:'guessed'}},'orders.edit',{orderId:'1048'}),errorCode('TARGET_CHANGED'));
});

// A guard missing a cell cannot be authorized by bytes retained only inside the SDK.
test('node pagination marks incomplete guards uncallable without hidden evidence',async()=>{
  const {engine,assertObservationResult}=await fixture(3);const ref=tableRef(engine.observe());
  const first=engine.observe({detail:'region',regionRef:ref,limit:2});
  assert.deepEqual(first.snapshot.nodes.map(node=>node.kind),['table','row']);
  assert.equal(first.snapshot.nodes[1]!.actions![0]!.enabled,true);
  assert.equal(first.snapshot.nodes[1]!.actions![0]!.callable,false);
  assert.equal(first.snapshot.nodes[1]!.actions![0]!.unavailableReason,'observation_incomplete');
  assert.equal(first.evidence.bindings.length,0);
  assert.equal(first.snapshot.coverage.status,'partial');
  assert.equal(first.snapshot.coverage.truncated,true);
  assert.ok(first.snapshot.coverage.nextCursor);
  assert.ok(first.snapshot.coverage.issues.some(issue=>issue.code==='NODE_LIMIT'));
  assertClosed(first.snapshot); assertObservationResult(first);
  let cursor:string|null=first.snapshot.coverage.nextCursor;const delivered=new Set(first.snapshot.nodes.map(node=>node.ref));let pages=0;
  while(cursor) {
    const next=engine.observe({detail:'region',regionRef:ref,limit:2,cursor});
    assertClosed(next.snapshot);assertObservationResult(next);
    assert.ok(next.snapshot.nodes.some(node=>!delivered.has(node.ref)),'a cursor must make progress');
    next.snapshot.nodes.forEach(node=>delivered.add(node.ref));cursor=next.snapshot.coverage.nextCursor;
    assert.ok(++pages<10);
  }
  assert.equal(delivered.size,7);
});

test('cursor rejects changed content and different read options',async()=>{
  const {engine,change}=await fixture(3);const ref=tableRef(engine.observe());
  const first=engine.observe({detail:'region',regionRef:ref,limit:2});
  const cursor=first.snapshot.coverage.nextCursor!;
  assert.throws(()=>engine.observe({detail:'region',regionRef:ref,limit:3,cursor}),errorCode('STALE_CURSOR'));
  change({amount:'Changed after first page'});
  assert.throws(()=>engine.observe({detail:'region',regionRef:ref,limit:2,cursor}),errorCode('STALE_CURSOR'));
});

test('node defaults stop at 200 and hard limit cannot exceed 500',async()=>{
  const {engine}=await fixture(300);const ref=tableRef(engine.observe());
  assert.equal(engine.observe({detail:'region',regionRef:ref}).snapshot.nodes.length,200);
  const large=engine.observe({detail:'region',regionRef:ref,limit:500});
  assert.ok(large.snapshot.nodes.length>200&&large.snapshot.nodes.length<=500);
  assert.ok(bytes(large.snapshot)<=48*1024);
  assert.equal(large.snapshot.coverage.status,'partial');
  for(const options of [{limit:501},{limit:0},{limit:1.5},{detail:'region'}, {detail:'overview',regionRef:ref}, {limit:2,unknown:true}])
    assert.throws(()=>engine.observe(options as any),errorCode('ADAPTER_CONTRACT_VIOLATION'));
});

test('single oversized text is explicitly truncated and cannot authorize its binding',async()=>{
  const {engine,change,assertObservationResult}=await fixture(1);const ref=tableRef(engine.observe());
  change({amount:'保密边界 '.repeat(20000)});
  const result=engine.observe({detail:'region',regionRef:ref});
  assert.ok(bytes(result.snapshot)<=48*1024);
  assert.ok(bytes(result.evidence)<=48*1024);
  assert.ok(bytes({type:'observation_result',requestId:'request',...result})<=120*1024);
  const cell=result.snapshot.nodes.find(node=>node.kind==='cell')!;
  assert.ok(cell.truncation?.reason);
  assert.equal(result.snapshot.coverage.status,'partial');
  assert.equal(result.snapshot.coverage.nextCursor,null,'one oversized node cannot yield an endless continuation');
  assert.equal(result.snapshot.nodes.find(node=>node.kind==='row')!.actions![0]!.callable,false);
  assert.equal(result.evidence.bindings.length,0);
  assertClosed(result.snapshot);assertObservationResult(result);
});

// Broker-side validation must reject untrusted data even when the adapter is buggy or forged.
test('strict snapshot validation rejects extra business data, dangling refs and forged evidence',async()=>{
  const {engine,assertObservationResult}=await fixture();const result=engine.observe({detail:'region',regionRef:tableRef(engine.observe())});
  const copy=()=>structuredClone(result) as any;
  for(const mutate of [
    (value:any)=>value.snapshot.nodes[0].data={hidden:'secret'},
    (value:any)=>value.snapshot.nodes[0].state={permission:'admin'},
    (value:any)=>value.snapshot.nodes[0].children.push('missing'),
    (value:any)=>value.snapshot.nodes.push({...value.snapshot.nodes[0]}),
    (value:any)=>value.evidence.bindings[0].guardRefs.push('missing'),
    (value:any)=>value.evidence.bindings[0].canonical='forged',
    (value:any)=>value.evidence.bindings[0].argumentBindings.orderId='9999',
    (value:any)=>value.evidence.bindings=[],
    (value:any)=>value.snapshot.nodes.find((node:any)=>node.kind==='cell').text='Changed only in public output'
  ]) {const value=copy();mutate(value);assert.throws(()=>assertObservationResult(value),errorCode('ADAPTER_CONTRACT_VIOLATION'));}
});

test('adapter errors are sanitized and async captures cannot masquerade as a synchronous read',async()=>{
  const {engine}=await fixture();
  engine.setAdapter({capture(){throw new Error('SECRET BACKEND RESPONSE');}});
  assert.throws(()=>engine.observe(),(error:any)=>error.code==='ADAPTER_CONTRACT_VIOLATION'&&!error.message.includes('SECRET'));
  engine.setAdapter({capture(){return Promise.resolve({secret:'SECRET'});}} as any);
  assert.throws(()=>engine.observe(),errorCode('ADAPTER_CONTRACT_VIOLATION'));
  engine.setAdapter({capture(){throw Object.assign(new Error('Hidden raw adapter details'),{code:'PAGE_NOT_VISIBLE'});}});
  assert.throws(()=>engine.observe(),(error:any)=>error.code==='PAGE_NOT_VISIBLE'&&!error.message.includes('Hidden'));
});

test('refs use object identity plus objectKey and reset across document instances',async()=>{
  const {engine,adapter}=await fixture();const before=engine.observe();const ref=tableRef(before);
  assert.equal(tableRef(engine.observe()),ref);assert.equal(engine.hasRef(ref),true);
  engine.resetDocument();const after=engine.observe();
  assert.notEqual(after.snapshot.documentId,before.snapshot.documentId);
  assert.notEqual(tableRef(after),ref);assert.equal(engine.hasRef(ref),false);
  const result=engine.observe({detail:'region',regionRef:tableRef(after)});
  const evidence=execution(result);engine.resetDocument();
  assert.throws(()=>engine.validate(evidence,'orders.edit',{orderId:'1048'}),errorCode('TARGET_CHANGED'));
  engine.setAdapter(adapter);
});

test('duplicate registrations and duplicate ownership keys fail explicitly',async()=>{
  const {engine}=await fixture();
  assert.throws(()=>engine.registerView({key:'orders',kind:'table',root:()=>({})}),errorCode('ADAPTER_CONTRACT_VIOLATION'));
  assert.throws(()=>engine.registerActionBinding({key:'edit',viewKey:'orders',action:'orders.edit',target:()=>({}),trigger:()=>({}),objectKey:()=>'',guard:{scope:'row'}}),errorCode('ADAPTER_CONTRACT_VIOLATION'));
  assert.throws(()=>engine.registerActionBinding({key:'no-view',viewKey:'missing',action:'orders.edit',target:()=>({}),trigger:()=>({}),objectKey:()=>'',guard:{scope:'target'}}),errorCode('ADAPTER_CONTRACT_VIOLATION'));
});

test('page action result is strict and refresh refs must belong to the current document',async()=>{
  const {assertPageActionResult}=await api();
  assert.doesNotThrow(()=>assertPageActionResult({outcome:'validation_failed',message:'Address required',refreshRefs:['known'],observationRequired:true},ref=>ref==='known'));
  for(const result of [
    {outcome:'completed',observationRequired:true,data:{secret:'hidden'}},
    {outcome:'completed',observationRequired:true,refreshRefs:['old']},
    {outcome:'completed'}, {outcome:'completed',observationRequired:'yes'},
    {outcome:'completed',observationRequired:true,message:'x'.repeat(50*1024)},
    {outcome:'completed',observationRequired:true,refreshRefs:Array(1)}
  ]) assert.throws(()=>assertPageActionResult(result,ref=>ref==='known'),errorCode('ACTION_RESULT_CONTRACT_VIOLATION'));
});


// A dialog can block a background region outside the requested form without changing that form's guard.
test('a complete modal form remains callable with unrelated blocked regions omitted',async()=>{
  const {PagePerception}=await api();const page={},background={},dialog={},form={},field={},button={};
  const engine=new PagePerception('modal-form',()=> 'submit-1');
  engine.registerView({key:'form',kind:'form',root:()=>form});
  engine.registerActionBinding({key:'save',viewKey:'form',action:'save',target:()=>form,trigger:()=>button,objectKey:()=> 'draft',guard:{scope:'form'}});
  engine.setAdapter({capture(_views,bindings,refs){
    const p=refs.ref(page,'page'),b=refs.ref(background,'region'),d=refs.ref(dialog,'dialog'),f=refs.ref(form,'form'),v=refs.ref(field,'field');
    const binding={ref:refs.ref(bindings[0]!,'binding','draft'),action:'save',targetRef:f,label:'Save',enabled:true,callable:true,argumentBindings:{}};
    return {page:{url:'https://example.test/edit',title:'Edit'},activeDialogRef:d,coverage:completeCoverage(),nodes:[
      {ref:p,kind:'page',children:[b,d]},{ref:b,kind:'region',name:'Background'},
      {ref:d,kind:'dialog',dialog:{modal:true,open:true,blocks:[b]},children:[f]},
      {ref:f,kind:'form',children:[v],actions:[binding]},
      {ref:v,kind:'field',field:{controlType:'text',value:'Current draft'}}
    ],bindings:[{binding,guardRefs:[d,f,v],targetIdentity:'draft',actionIdentity:'submit-1'}]};
  }});
  const formRef=engine.observe().snapshot.nodes.find(node=>node.kind==='form')!.ref;
  const result=engine.observe({detail:'region',regionRef:formRef});
  assert.equal(result.evidence.bindings.length,1);
  assert.doesNotThrow(()=>engine.validate(execution(result),'save',{}));
});

// Two complete bindings can exceed evidence bytes even while their public nodes fit comfortably.
test('evidence budget disables only the binding that cannot fit',async()=>{
  const {engine,adapter,change,assertObservationResult}=await fixture(1);
  const secondTarget={},secondTrigger={};
  engine.registerActionBinding({key:'second-edit',viewKey:'orders',action:'orders.edit',target:()=>secondTarget,trigger:()=>secondTrigger,objectKey:()=> '1048',guard:{scope:'row'}});
  engine.setAdapter({capture(views,bindings,refs,identity){
    const capture=adapter.capture(views,bindings,refs,identity),first=capture.bindings[0]!;
    const second={...first.binding,ref:refs.ref(bindings[1]!,'binding','1048'),label:'Edit again'};
    capture.nodes.find(node=>node.kind==='row')!.actions!.push(second);
    capture.bindings.push({...first,binding:second});return capture;
  }});
  const ref=tableRef(engine.observe());change({amount:'A'.repeat(26000)});
  const result=engine.observe({detail:'region',regionRef:ref});
  assert.deepEqual(result.snapshot.nodes.find(node=>node.kind==='row')!.actions!.map(action=>action.callable),[true,false]);
  assert.equal(result.evidence.bindings.length,1);
  assert.ok(bytes(result.evidence)<=48*1024);
  assert.ok(result.snapshot.coverage.issues.some(issue=>issue.code==='EVIDENCE_LIMIT'));
  engine.validate(execution(result),'orders.edit',{orderId:'1048'});assertObservationResult(result);
});

// A row action depends on the selection set without guarding every other selected row's cell contents.
test('selected sibling identity and state are guarded without unrelated sibling text',async()=>{
  const {engine,adapter}=await fixture(2);let selected=true,otherText='Other 1';
  engine.setAdapter({capture(views,bindings,refs,identity){
    const capture=adapter.capture(views,bindings,refs,identity),rows=capture.nodes.filter(node=>node.kind==='row'),cells=capture.nodes.filter(node=>node.kind==='cell');
    rows[1]!.state={selected};cells[1]!.text=otherText;capture.bindings[0]!.guardRefs.push(rows[1]!.ref);return capture;
  }});
  const result=engine.observe({detail:'region',regionRef:tableRef(engine.observe())});
  otherText='An unrelated value changed';
  assert.doesNotThrow(()=>engine.validate(execution(result),'orders.edit',{orderId:'1048'}));
  selected=false;
  assert.throws(()=>engine.validate(execution(result),'orders.edit',{orderId:'1048'}),errorCode('CONTEXT_CHANGED'));
});


test('logical portal ownership can register before its parent commit',async()=>{
  const {engine}=await fixture();
  assert.doesNotThrow(()=>engine.registerView({key:'portal',kind:'dialog',ownerKey:'later-owner',root:()=>null}));
  engine.registerView({key:'later-owner',kind:'region',root:()=>null});
});
