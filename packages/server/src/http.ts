// SPDX-License-Identifier: MIT
import {PageError} from '@clearact/core';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {ClearActBroker,ClearActBrokerError,type ClearActBrokerOptions,type Invocation,type ExecutionBinding} from './broker.ts';
const localHosts=new Set(['localhost','127.0.0.1','[::1]']);
function allowedOrigin(origin:string|undefined,extra:string[]):boolean {
 if(!origin)return true;if(extra.includes(origin))return true;
 try{const url=new URL(origin);return localHosts.has(url.hostname)&&['http:','https:'].includes(url.protocol);}catch{return false;}
}
function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>128*1024)throw new ClearActBrokerError(413,'Request body too large');}try{return JSON.parse(raw||'{}');}catch{throw new ClearActBrokerError(400,'Invalid JSON');}}
function bearer(req:IncomingMessage){return req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';}
export function createClearActServer(options:{approvalToken:string;allowedOrigins?:string[];brokerOptions?:ClearActBrokerOptions}){
 const broker=new ClearActBroker(options.approvalToken,options.brokerOptions);const origins=options.allowedOrigins??[];
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`);
   if(!localHosts.has(url.hostname)||!allowedOrigin(req.headers.origin,origins))throw new ClearActBrokerError(403,'Origin or host not allowed');
   if(req.headers.origin)res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
   res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
   if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
   const sessionId=url.searchParams.get('sessionId')??'';
   if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{ok:true,storage:'memory',version:'0.1.0'});return;}
   if(req.method==='GET'&&url.pathname==='/api/sessions'){json(res,200,broker.listSessions());return;}
   if(req.method==='GET'&&url.pathname==='/api/actions'){const session=broker.listSessions().find(candidate=>candidate.sessionId===sessionId);const actions=broker.getActions(sessionId);json(res,200,session?.contextMode==='page'?{...session,actions,observationRequired:true}:actions);return;}
   if(req.method==='GET'&&url.pathname==='/api/context'){json(res,200,await broker.getContext(sessionId));return;}
   if(req.method==='POST'&&url.pathname==='/api/observe'){const {sessionId,...options}=await body(req);json(res,200,await broker.observe(sessionId,options));return;}
   if(req.method==='POST'&&url.pathname==='/api/invoke'){json(res,200,broker.invoke(await body(req) as Invocation));return;}
   if(req.method==='POST'&&url.pathname==='/api/verify-execution'){
    try{json(res,200,broker.verifyExecution(bearer(req),await body(req) as ExecutionBinding));}catch(error){throw new ClearActBrokerError(403,error instanceof Error?error.message:'Execution denied');}return;
   }
   const match=url.pathname.match(/^\/api\/operations\/([^/]+)(?:\/(approve|reject))?$/);
   if(match){const id=decodeURIComponent(match[1]!);if(req.method==='GET'&&!match[2]){json(res,200,broker.getOperation(id));return;}
    if(req.method==='POST'&&match[2]){await body(req);json(res,200,match[2]==='approve'?broker.approve(id,bearer(req)):broker.reject(id,bearer(req)));return;}}
   throw new ClearActBrokerError(404,'Route not found');
  }catch(error){json(res,error instanceof ClearActBrokerError?error.status:error instanceof PageError?409:500,{error:error instanceof PageError?error.message:error instanceof Error?error.message:'Internal error',...(error instanceof PageError?{code:error.code,message:error.message,...(error.refreshRefs?{refreshRefs:error.refreshRefs}:{})}:{})});}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
 server.on('upgrade',(req,socket,head)=>{
  let valid=false;try{const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`);valid=url.pathname==='/page'&&localHosts.has(url.hostname)&&allowedOrigin(req.headers.origin,origins);}catch{}
  if(!valid){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
 });
 wss.on('connection',ws=>{
  const connectionId=randomUUID();let sessionId:string|undefined;
  const send=(message:Record<string,unknown>)=>{if(ws.readyState!==WebSocket.OPEN)throw new Error('Page not connected');ws.send(JSON.stringify(message));};
  ws.on('message',data=>{
   let message:any;
   try{message=JSON.parse(String(data));
    if(message.type==='register'){
     if(sessionId&&sessionId!==message.sessionId)throw new ClearActBrokerError(409,'Cannot change page session identity');
     broker.register(message.sessionId,message.actions,message.context??{},send,connectionId,message.enabled,{contextMode:message.contextMode??'legacy',documentId:message.documentId,capabilities:message.capabilities});sessionId=message.sessionId;
    }else if(message.type==='observation_result'&&sessionId)broker.observationResult(sessionId,connectionId,message);
    else if(message.type==='result'&&sessionId)broker.result(sessionId,connectionId,message.operationId,message.result,message.error,message.cancelled===true,message.errorCode,message.effect);
    else if(message.type==='control'&&sessionId)broker.control(sessionId,connectionId,message.enabled,message.requestId);
    else throw new ClearActBrokerError(400,'Unknown page message');
   }catch(error){send({type:'error',error:error instanceof Error?error.message:'Invalid page message',...(error instanceof PageError?{code:error.code}:{}),...(message?.requestId?{requestId:message.requestId}:{})});}
  });
  ws.on('close',()=>{if(sessionId)broker.unregister(sessionId,connectionId);});
  ws.on('error',()=>{});
 });
 return {server,broker,wss,close:async()=>{broker.close();for(const ws of wss.clients)ws.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
