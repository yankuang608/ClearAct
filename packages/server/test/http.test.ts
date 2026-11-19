import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import {createClearActServer} from '../src/http.ts';

test('HTTP/WS boundary requires independent approval and consumes execution credentials',async()=>{
 const app=createClearActServer({approvalToken:'human-test-secret'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const port=(app.server.address() as any).port;const base=`http://127.0.0.1:${port}`;
 const ws=new WebSocket(`ws://127.0.0.1:${port}/page`);const messages:any[]=[];ws.on('message',data=>messages.push(JSON.parse(String(data))));
 const request=async(path:string,body?:unknown,token?:string)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 try {
  await once(ws,'open');ws.send(JSON.stringify({type:'register',sessionId:'test',context:{screen:'cards'},actions:[{name:'delete',description:'Delete a card',risk:'high',inputSchema:{type:'object',properties:{id:{type:'number'}},required:['id'],additionalProperties:false}}]}));
  await once(ws,'message');
  const sessions=await request('/api/sessions');assert.equal(sessions.status,200);
  assert.equal((await fetch(base+'/api/sessions',{headers:{Origin:'https://evil.example'}})).status,403);
  const response=await request('/api/invoke',{sessionId:'test',action:'delete',arguments:{id:9},intent:'Delete card 9',requestId:'http-1'});assert.equal(response.status,200);const op:any=await response.json();
  assert.equal(op.status,'waiting_approval');assert.equal(messages.some(x=>x.type==='execute'),false);
  assert.equal((await request(`/api/operations/${op.id}/approve`,{},'agent-token')).status,403);
  assert.equal((await request(`/api/operations/${op.id}/approve`,{},'human-test-secret')).status,200);
  const execute=messages.find(x=>x.type==='execute')??await new Promise<any>(resolve=>ws.on('message',data=>{const m=JSON.parse(String(data));if(m.type==='execute')resolve(m);}));
  const binding={operationId:op.id,sessionId:'test',action:'delete',arguments:{id:9}};
  assert.equal((await request('/api/verify-execution',{...binding,arguments:{id:10}},execute.executionToken)).status,403);
  assert.equal((await request('/api/verify-execution',binding,execute.executionToken)).status,200);
  assert.equal((await request('/api/verify-execution',binding,execute.executionToken)).status,403);
  assert.equal(JSON.stringify(await (await request(`/api/operations/${op.id}`)).json()).includes(execute.executionToken),false);
 } finally {ws.terminate();await app.close();}
});

test('only the registered page connection can stop and resume; HTTP has no restore authority', async t => {
 const app=createClearActServer({approvalToken:'human-test-secret'});
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 const owner=new WebSocket(base.replace('http','ws')+'/page');
 const foreign=new WebSocket(base.replace('http','ws')+'/page');
 t.after(async()=>{owner.terminate();foreign.terminate();await app.close();});
 await Promise.all([once(owner,'open'),once(foreign,'open')]);
 const message=(ws:WebSocket,body:unknown)=>{
  const response=once(ws,'message').then(([data])=>JSON.parse(String(data)));ws.send(JSON.stringify(body));return response;
 };
 assert.equal((await message(foreign,{type:'control',enabled:false,requestId:'unregistered'})).type,'error');
 assert.equal((await message(owner,{type:'register',sessionId:'owned',actions:[{name:'read',description:'Read',risk:'read',inputSchema:{type:'object'}}]})).enabled,true);
 const ack=await message(owner,{type:'control',sessionId:'another-page',enabled:false,requestId:'stop'});
 assert.equal(ack.type,'control');assert.equal(ack.enabled,false);assert.equal(ack.requestId,'stop');
 assert.equal(app.broker.listSessions()[0]!.enabled,false,'message sessionId cannot redirect controls away from its registered page');
 for(const path of ['/api/resume','/api/control','/api/sessions/owned/resume']){
  const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer human-test-secret'},body:'{"enabled":true}'});
  assert.equal(response.status,404);
 }
 assert.equal((await message(foreign,{type:'register',sessionId:'owned',actions:[]})).type,'error');
 assert.equal((await message(foreign,{type:'control',enabled:true,requestId:'foreign-resume'})).type,'error');
 assert.equal(app.broker.listSessions()[0]!.enabled,false);
 assert.equal((await message(owner,{type:'control',enabled:true,requestId:'resume'})).enabled,true);
 assert.equal(app.broker.listSessions()[0]!.enabled,true);
});
