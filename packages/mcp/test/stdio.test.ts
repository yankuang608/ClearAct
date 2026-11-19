import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClearActServer} from '../../server/src/http.ts';
import WebSocket from 'ws';

test('stdio exposes only business protocol tools and invokes a registered page action',async()=>{
 const app=createClearActServer({approvalToken:'never-given-to-agent'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const base=`http://127.0.0.1:${(app.server.address() as any).port}`;const ws=new WebSocket(base.replace('http','ws')+'/page');
 ws.on('message',data=>{const m=JSON.parse(String(data));if(m.type==='execute')ws.send(JSON.stringify({type:'result',operationId:m.operationId,result:{total:7}}));});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','packages/mcp/src/cli.ts'],cwd:process.cwd(),env:{CLEARACT_SERVER_URL:base},stderr:'pipe'});
 const client=new Client({name:'clearact-integration-test',version:'1.0.0'});
 try {
  await once(ws,'open');ws.send(JSON.stringify({type:'register',sessionId:'fixture',context:{page:'dashboard'},actions:[{name:'get_total',description:'Read total cards',risk:'read',inputSchema:{type:'object',additionalProperties:false}}]}));await once(ws,'message');
  await client.connect(transport);const tools=await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['get_context','get_operation','invoke_action','list_actions']);
  const listed:any=await client.callTool({name:'list_actions',arguments:{sessionId:'fixture'}});assert.match(listed.content[0].text,/get_total/);
  const result:any=await client.callTool({name:'invoke_action',arguments:{sessionId:'fixture',action:'get_total',arguments:{},intent:'Read dashboard total',requestId:'mcp-test-1'}});
  const op=JSON.parse(result.content[0].text);assert.equal(op.status,'succeeded');assert.equal(op.result.total,7);assert.equal('executionToken' in op,false);
  const denied:any=await client.callTool({name:'approve',arguments:{}});assert.equal(denied.isError,true);
  // Concurrent evaluations see only their bound page, including operation readback.
  const restricted=new Client({name:'bound-evaluation',version:'1.0.0'});
  const restrictedTransport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','packages/mcp/src/cli.ts'],cwd:process.cwd(),env:{CLEARACT_SERVER_URL:base,CLEARACT_SESSION_ID:'different-evaluation'},stderr:'pipe'});
  try {
   await restricted.connect(restrictedTransport);
   const sessions:any=await restricted.callTool({name:'list_actions',arguments:{}});
   assert.deepEqual(JSON.parse(sessions.content[0].text),[]);
   for(const request of [
    {name:'get_context',arguments:{sessionId:'fixture'}},
    {name:'list_actions',arguments:{sessionId:'fixture'}},
    {name:'invoke_action',arguments:{sessionId:'fixture',action:'get_total',arguments:{},intent:'cross-session attempt',requestId:'cross-session'}},
    {name:'get_operation',arguments:{operationId:op.id}},
   ]){
    const blocked:any=await restricted.callTool(request);assert.equal(blocked.isError,true,request.name);
    assert.doesNotMatch(blocked.content[0].text,/"total":7/);
   }
  }finally{await restricted.close();}
 } finally {await client.close();ws.terminate();await app.close();}
});
