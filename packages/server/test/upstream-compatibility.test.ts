import test from 'node:test';
import assert from 'node:assert/strict';
import {ClearActBroker} from '../src/broker.ts';
import {observationOptions, isPageErrorCode} from '../src/page-observations.ts';
import type {ClearActActionMetadata} from '../../core/src/types.ts';
const actions=(n:number):ClearActActionMetadata[]=>Array.from({length:n},(_,i)=>({name:`read_${i}`,description:'Read fixture',risk:'read',inputSchema:{type:'object',additionalProperties:false}}));
test('registration limit stays 100 by default; trusted host can choose up to 500',()=>{
 const normal=new ClearActBroker('test');const expanded=new ClearActBroker('test',{maxRegisteredActions:500});
 try {
  normal.register('default',actions(100),{},()=>{},'a');
  assert.throws(()=>normal.register('oversized',actions(101),{},()=>{},'b'),/registration/i);
  expanded.register('large',actions(500),{},()=>{},'c');
  assert.throws(()=>expanded.register('too-large',actions(501),{},()=>{},'d'),/registration/i);
  for(const limit of [0,-1,501,1.5,NaN,Infinity])assert.throws(()=>new ClearActBroker('test',{maxRegisteredActions:limit}),/limit/i);
 } finally {normal.close();expanded.close();}
});
test('focused observation transport accepts binding only with a region',()=>{
 assert.deepEqual(observationOptions({detail:'region',regionRef:'r',bindingRef:'b'}),{detail:'region',regionRef:'r',bindingRef:'b'});
 for(const input of [{bindingRef:'b'},{detail:'overview',bindingRef:'b'},{detail:'region',regionRef:'r',bindingRef:''},{detail:'region',regionRef:'r',bindingRef:1}])assert.throws(()=>observationOptions(input));
});
test('attachment failure code is public but arbitrary adapter errors are not',()=>{
 assert.equal(isPageErrorCode('ATTACHMENT_UNAVAILABLE'),true);
 assert.equal(isPageErrorCode('secret-file-path'),false);
});
