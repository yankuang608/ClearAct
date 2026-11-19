import React, { Suspense, useRef, useState, startTransition } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp, h, ref, nextTick } from 'vue';
import { ElTable, ElTableColumn, ElForm, ElFormItem, ElInput, ElDialog, ElButton, ElTableV2, ElDatePicker, ElCascader, ElSelect, ElOption } from 'element-plus';
import 'element-plus/dist/index.css';
import { createClearActRuntime } from '../../core/src/index.ts';
import { installDOMPage } from '../../dom/src/index.ts';
import { ClearActProvider, useClearActView, useClearActActionBinding, useClearActAction } from '../../react/src/index.ts';
import { createClearActPlugin } from '../../vue/src/index.ts';
import { useClearActElementPlusView } from '../src/index.ts';

export function mountReact(base: string) {
  const runtime = createClearActRuntime({ sessionId: 'react-fixture', serverUrl: base, contextMode: 'page', operationIntervalMs: 0 });
  installDOMPage(runtime, { fallback: false });
  const root = createRoot(document.getElementById('app')!);
  let update!: (value: string) => void;
  let toggle!: (value: boolean) => void;
  let callbacks = 0;
  const pending = new Promise(() => {});
  function Form() {
    const [label, setLabel] = useState('Committed label'); update = setLabel;
    const form = useRef<HTMLFormElement>(null), button = useRef<HTMLButtonElement>(null);
    const viewKey = useClearActView({ key: 'same-key', kind: 'form', root: () => form.current, read: reader => reader.form() });
    useClearActAction({ name: 'save', description: 'Save current form', risk: 'write', resultMode: 'page', inputSchema: { type: 'object' }, async execute() { callbacks++; return { outcome: 'completed', observationRequired: true }; } });
    useClearActActionBinding({ key: 'save', viewKey, action: 'save', target: () => form.current, trigger: () => button.current, objectKey: () => 'record', guard: { scope: 'form' } });
    if (label === 'Abandoned label') throw pending;
    return <form ref={form} aria-label={label}><label>Draft<input aria-label="Draft" defaultValue="Unsaved DOM draft" /></label><button ref={button} type="button">Save</button></form>;
  }
  function Host() {
    const [show, setShow] = useState(true); toggle = setShow;
    return <Suspense fallback={<p>Busy</p>}>{show ? <Form /> : <p>Unmounted form</p>}</Suspense>;
  }
  root.render(<ClearActProvider runtime={runtime}><Host /></ClearActProvider>);
  return { runtime, update: (value: string) => startTransition(() => update(value)), hide: () => toggle(false), show: () => toggle(true), get callbacks() { return callbacks; }, dispose: () => { root.unmount(); runtime.dispose(); } };
}

export function mountVue(base: string) {
  const runtime = createClearActRuntime({ sessionId: 'vue-fixture', serverUrl: base, contextMode: 'page', operationIntervalMs: 0 });
  installDOMPage(runtime, { fallback: false });
  const open = ref(false), second = ref(false), address = ref('Unsaved address');
  const rows = Array.from({ length: 100 }, (_, n) => ({ number: n + 1, amount: 100000 + n, hidden: 'HIDDEN-MODEL-' + n }));
  const Table = { setup() {
    const table = ref<any>(); useClearActElementPlusView({ key: 'shared-table', kind: 'table', root: () => table.value?.$el ?? null });
    return () => h(ElTable, { ref: table, data: rows.slice(second.value ? 2 : 0, second.value ? 4 : 2), rowKey: 'number', 'aria-label': second.value ? 'Second business page' : 'First business page' }, () => [
      h(ElTableColumn, { prop: 'number', label: 'Order' }), h(ElTableColumn, { prop: 'amount', label: 'Amount', formatter: (row: any) => `¥${(row.amount / 100).toFixed(2)}` }),
    ]);
  } };
  const Form = { setup() {
    const form = ref<any>(); useClearActElementPlusView({ key: 'shared-form', kind: 'form', root: () => form.value?.$el ?? null });
    return () => h(ElForm, { ref: form, model: { address: address.value }, 'aria-label': 'Delivery form' }, () => [
      h(ElFormItem, { label: 'Address', required: true, error: address.value ? '' : 'Please enter address' }, () => h(ElInput, { modelValue: address.value, 'onUpdate:modelValue': (value: string) => address.value = value })),
      h(ElButton, () => 'Submit'),
    ]);
  } };
  const Dialog = { setup() {
    useClearActElementPlusView({ key: 'shared-dialog', kind: 'dialog', root: () => document.querySelector('.el-dialog') });
    return () => h(ElDialog, { modelValue: open.value, 'onUpdate:modelValue': (value: boolean) => open.value = value, title: 'Edit rendered order', appendToBody: true, destroyOnClose: true }, () => h(Form));
  } };
  const app = createApp({ setup() { return () => [h(Table), h(Dialog), h('p', 'Business page text')]; } });
  app.use(createClearActPlugin(runtime)); app.mount('#app');
  return { runtime, open: async () => { open.value = true; await nextTick(); }, second: async () => { second.value = true; await nextTick(); }, clear: async () => { address.value = ''; await nextTick(); }, close: async () => { open.value = false; await nextTick(); }, dispose: () => { app.unmount(); runtime.dispose(); } };
}


export function mountUnsupported(base:string) {
  const runtime=createClearActRuntime({sessionId:'unsupported-fixture',serverUrl:base,contextMode:'page',operationIntervalMs:0});
  installDOMPage(runtime,{fallback:false});
  const Unsupported={setup(){
    const table=ref<any>(),form=ref<any>();
    useClearActElementPlusView({key:'v2',kind:'table',root:()=>table.value?.$el??null});
    useClearActElementPlusView({key:'complex-form',kind:'form',root:()=>form.value?.$el??null});
    return ()=>[
      h(ElTableV2,{ref:table,width:600,height:140,columns:[{key:'number',dataKey:'number',title:'Order',width:200}],data:[{number:'Current V2 row'}]}),
      h(ElForm,{ref:form,'aria-label':'Composite controls'},()=>[
        h(ElFormItem,{label:'Date'},()=>h(ElDatePicker,{modelValue:'2026-10-19',valueFormat:'YYYY-MM-DD'})),
        h(ElFormItem,{label:'Hierarchy'},()=>h(ElCascader,{options:[{value:'hidden',label:'UNEXPANDED_CASCADER_OPTION'}]})),
        h(ElFormItem,{label:'Choice'},()=>h(ElSelect,{},()=>h(ElOption,{value:'hidden',label:'UNEXPANDED_SELECT_OPTION'}))),
      ]),
    ];
  }};
  const app=createApp(Unsupported);app.use(createClearActPlugin(runtime));app.mount('#app');
  return {runtime,dispose:()=>{app.unmount();runtime.dispose();}};
}

export function mountNativeModals(base:string) {
  const runtime=createClearActRuntime({sessionId:'native-modals-fixture',serverUrl:base,contextMode:'page',operationIntervalMs:0});
  installDOMPage(runtime,{fallback:false});
  const host=document.getElementById('app')!;
  host.innerHTML='<dialog id="native-a" aria-label="Native A"><button>A confirm</button></dialog><dialog id="native-b" aria-label="Native B"><button>B confirm</button></dialog>';
  const a=host.querySelector('#native-a') as HTMLDialogElement,b=host.querySelector('#native-b') as HTMLDialogElement;
  const callbacks={a:0,b:0};
  runtime.registerAction({name:'confirm',description:'Confirm the current modal',risk:'write',resultMode:'page',inputSchema:{type:'object',properties:{id:{type:'string',enum:['a','b']}},required:['id'],additionalProperties:false},async execute(args){callbacks[args.id as 'a'|'b']++;return {outcome:'completed',observationRequired:true};}});
  for(const [id,dialog] of [['a',a],['b',b]] as const) {
    runtime.registerView({key:id,kind:'dialog',root:()=>dialog});
    runtime.registerActionBinding({key:'confirm',viewKey:id,action:'confirm',target:()=>dialog,trigger:()=>dialog.querySelector('button'),objectKey:()=>id,argumentBindings:()=>({id}),guard:{scope:'target'}});
  }
  b.showModal();a.showModal();runtime.connect();
  return {runtime,callbacks,revealB:()=>a.close(),coverB:()=>a.showModal(),dispose:()=>{runtime.dispose();host.replaceChildren();}};
}
