import test from 'node:test';
import assert from 'node:assert/strict';
import {createClearActRuntime} from '../src/index.ts';
const code=(expected:string)=>(error:any)=>error?.code===expected;

test('page runtime rejects second state channel and legacy-result actions before connecting',()=>{
 assert.throws(()=>createClearActRuntime({sessionId:'page',serverUrl:'http://127.0.0.1:1',contextMode:'page',context:{hidden:1}} as any),code('PAGE_OBSERVATION_UNSUPPORTED'));
 const runtime=createClearActRuntime({sessionId:'page',serverUrl:'http://127.0.0.1:1',contextMode:'page'} as any);
 try {
  assert.throws(()=>runtime.getContext(),code('PAGE_CONTEXT_REQUIRES_OBSERVE'));
  assert.throws(()=>runtime.setContext({}),code('PAGE_OBSERVATION_UNSUPPORTED'));
  assert.throws(()=>runtime.registerAction({name:'old',description:'old query',risk:'read',inputSchema:{type:'object'},async execute(){return {hidden:1};}}),code('PAGE_OBSERVATION_UNSUPPORTED'));
  assert.throws(()=>runtime.registerAction({name:'clearact.page.observe',description:'collision',risk:'read',resultMode:'page',inputSchema:{type:'object'},async execute(){return {outcome:'completed',observationRequired:true};}} as any),code('PAGE_OBSERVATION_UNSUPPORTED'));
 } finally {runtime.dispose();}
});
