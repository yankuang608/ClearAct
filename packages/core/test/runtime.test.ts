import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createClearActRuntime } from "../src/index.ts";

test("page registers structured actions and executes a validated broker request only once", async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const address = server.address() as { port: number };
  const runtime = createClearActRuntime({
    sessionId: "test",
    serverUrl: `http://127.0.0.1:${address.port}`,
  });
  t.after(() => {
    runtime.dispose();
    for (const client of server.clients) client.terminate();
    server.close();
  });
  let effects = 0;
  runtime.registerAction({
    name: "create_card",
    description: "Create a draft card",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(input) {
      effects++;
      return { id: 4, title: input.title };
    },
  });
  const connected = new Promise<any>((r) =>
    server.on("connection", (socket) => r(socket)),
  );
  runtime.connect();
  const socket = await connected;
  const next = () =>
    new Promise<any>((r) =>
      socket.once("message", (data: any) => r(JSON.parse(data.toString()))),
    );
  const registration = await next();
  assert.equal(registration.actions[0].name, "create_card");
  assert.equal(registration.actions[0].execute, undefined);
  const request = {
    type: "execute",
    operationId: "op1",
    action: "create_card",
    arguments: { title: "Launch" },
    intent: "Create requested task",
  };
  let received = next();
  socket.send(JSON.stringify(request));
  assert.deepEqual((await received).result, { id: 4, title: "Launch" });
  received = next();
  socket.send(JSON.stringify(request));
  await received;
  assert.equal(
    effects,
    1,
    "replayed execution must not duplicate the business effect",
  );
  received = next();
  socket.send(
    JSON.stringify({
      ...request,
      operationId: "op2",
      arguments: { title: 12 },
    }),
  );
  assert.match((await received).error, /invalid/i);
  assert.equal(effects, 1);
  runtime.dispose();
  server.close();
});

test("disconnect releases the page connection while retaining registered actions", async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const runtime = createClearActRuntime({
    sessionId: "lifecycle",
    serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  });
  t.after(() => {
    runtime.dispose();
    for (const client of server.clients) client.terminate();
    server.close();
  });
  runtime.registerAction({
    name: "read",
    description: "Read",
    risk: "read",
    inputSchema: { type: "object" },
    async execute() {
      return {};
    },
  });
  const ready = new Promise<void>((resolve) =>
    runtime.subscribe((event) => {
      if (event.connected) resolve();
    }),
  );
  runtime.connect();
  await ready;
  runtime.disconnect();
  assert.equal(runtime.isConnected(), false);
  assert.equal(runtime.getActions().length, 1);
});

test("unregister removes an action and duplicate names are rejected", () => {
  const runtime = createClearActRuntime({
    sessionId: "test",
    serverUrl: "http://localhost:1",
  });
  const action = {
    name: "read",
    description: "Read",
    risk: "read" as const,
    inputSchema: { type: "object" },
    async execute() {
      return {};
    },
  };
  const unregister = runtime.registerAction(action);
  assert.throws(() => runtime.registerAction(action), /already registered/);
  unregister();
  assert.equal(runtime.getActions().length, 0);
  runtime.dispose();
});

test("approval HTTP response refreshes observer state even without a socket event", async (t) => {
  const operation = {
    id: "pending",
    sessionId: "test",
    action: "delete",
    arguments: {},
    intent: "Remove selected draft",
    status: "failed" as const,
    error: "Page disconnected",
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:01Z",
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(operation), { status: 200 }),
  );
  const runtime = createClearActRuntime({
    sessionId: "test",
    serverUrl: "http://localhost:1",
    approvalToken: "test-only",
  });
  let observed = false;
  runtime.subscribe((event) => {
    if (event.operation?.status === "failed") observed = true;
  });
  await runtime.approve("pending");
  assert.equal(runtime.getOperations()[0]?.status, "failed");
  assert.equal(observed, true);
  runtime.dispose();
});

test("an action from a closed socket never sends its result through a replacement socket", async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const runtime = createClearActRuntime({sessionId:"socket-owner",serverUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  t.after(() => {runtime.dispose();for(const client of server.clients)client.terminate();server.close();});
  let release!:(result:unknown)=>void;
  let started!:()=>void;const actionStarted=new Promise<void>(resolve=>{started=resolve;});
  runtime.registerAction({name:"slow",description:"Read slow result",risk:"read",inputSchema:{type:"object"},execute(){started();return new Promise(resolve=>{release=resolve;});}});
  const connection=()=>new Promise<import('ws').WebSocket>(resolve=>server.once('connection',socket=>resolve(socket)));
  let connected=connection();runtime.connect();const oldSocket=await connected;
  await new Promise<void>(resolve=>oldSocket.once('message',()=>resolve()));
  oldSocket.send(JSON.stringify({type:'execute',operationId:'old-operation',action:'slow',arguments:{},intent:'Read data'}));
  await actionStarted;
  runtime.disconnect();connected=connection();runtime.connect();const replacement=await connected;
  const received:any[]=[];replacement.on('message',data=>received.push(JSON.parse(String(data))));
  while(!received.some(message=>message.type==='register'))await new Promise(resolve=>setTimeout(resolve,5));
  release({from:'old-socket'});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(received.some(message=>message.type==='result'),false);
});

test("afterResult waits for the matching acknowledged result and never crosses a connection", async t => {
  const server = new WebSocketServer({port: 0});
  await new Promise<void>(resolve => server.once('listening', resolve));
  const runtime = createClearActRuntime({sessionId: 'navigation', serverUrl: `http://127.0.0.1:${(server.address() as {port:number}).port}`});
  t.after(() => {runtime.dispose();for (const socket of server.clients) socket.terminate();server.close();});
  let writes = 0, navigations = 0, release!: () => void, started!: () => void;
  let began = new Promise<void>(resolve => {started = resolve;});
  runtime.registerAction({name:'save',description:'Save and navigate',risk:'write',inputSchema:{type:'object'},async execute(_args, context) {
    writes++;
    context.afterResult!(() => {navigations++;});
    started();
    await new Promise<void>(resolve => {release = resolve;});
    return {saved:true};
  }});
  const connection = () => new Promise<import('ws').WebSocket>(resolve => server.once('connection', resolve));
  let connected = connection();runtime.connect();let socket = await connected;
  const next = () => new Promise<any>(resolve => socket.once('message', data => resolve(JSON.parse(String(data)))));
  await next();
  const execution = {type:'execute',operationId:'first',action:'save',arguments:{},intent:'Save requested changes'};
  socket.send(JSON.stringify(execution));await began;
  socket.send(JSON.stringify({type:'result_ack',operationId:'first'}));
  await new Promise(resolve => setTimeout(resolve,20));assert.equal(navigations,0,'early ACK is not a result receipt');
  let result = next();release();assert.deepEqual((await result).result,{saved:true});assert.equal(navigations,0);
  socket.send(JSON.stringify({type:'result_ack',operationId:'unrelated'}));
  await new Promise(resolve => setTimeout(resolve,20));assert.equal(navigations,0);
  socket.send(JSON.stringify({type:'result_ack',operationId:'first'}));
  socket.send(JSON.stringify({type:'result_ack',operationId:'first'}));
  await new Promise(resolve => setTimeout(resolve,20));assert.equal(navigations,1);
  result=next();socket.send(JSON.stringify(execution));await result;assert.equal(writes,1,'duplicate dispatch is not another write');
  began=new Promise<void>(resolve=>{started=resolve;});socket.send(JSON.stringify({...execution,operationId:'second'}));await began;
  result=next();release();await result;runtime.disconnect();
  connected=connection();runtime.connect();socket=await connected;await next();
  socket.send(JSON.stringify({type:'result_ack',operationId:'second'}));
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(navigations,1,'old ACK cannot navigate a replacement connection');assert.equal(writes,2);
  const registered=next();runtime.registerAction({name:'fail',description:'Fail before result',risk:'write',inputSchema:{type:'object'},async execute(_args,context){context.afterResult!(()=>{navigations++;});throw new Error('native failure');}});await registered;
  result=next();socket.send(JSON.stringify({...execution,action:'fail',operationId:'failed'}));assert.match((await result).error,/native failure/);
  socket.send(JSON.stringify({type:'result_ack',operationId:'failed'}));await new Promise(resolve=>setTimeout(resolve,20));assert.equal(navigations,1,'failed action has no post-result side effect');
});

test('writeOnly dispatch reaches the executor but stays out of preparation, execution events and returned results', async t => {
  const server = new WebSocketServer({port:0});
  await new Promise<void>(resolve => server.once('listening',resolve));
  const runtime = createClearActRuntime({sessionId:'secret-page',serverUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
  t.after(() => {runtime.dispose();for(const socket of server.clients)socket.terminate();server.close();});
  const events: unknown[] = []; const preparations: unknown[] = []; let actualInput: unknown;
  runtime.subscribe(event => events.push(event));
  runtime.addBeforeExecuteHook(operation => {preparations.push(operation);});
  runtime.registerAction({name:'fill_password',description:'Fill native password',risk:'write',inputSchema:{type:'object',properties:{password:{type:'string',writeOnly:true}},required:['password']},async execute(input){actualInput=input;return {echo:input.password,filled:true};}});
  const connected = new Promise<import('ws').WebSocket>(resolve => server.once('connection',resolve));
  runtime.connect(); const socket = await connected;
  const next = () => new Promise<any>(resolve => socket.once('message',data => resolve(JSON.parse(String(data)))));
  await next();
  const execution = {type:'execute',operationId:'secret-op',action:'fill_password',arguments:{password:'fake-runtime-password'},intent:'Fill fake-runtime-password'};
  const response = next(); socket.send(JSON.stringify(execution));
  assert.deepEqual((await response).result,{echo:'[REDACTED]',filled:true});
  assert.deepEqual(actualInput,{password:'fake-runtime-password'});
  assert.equal(JSON.stringify(events).includes('fake-runtime-password'),false);
  assert.equal(JSON.stringify(preparations).includes('fake-runtime-password'),false);
  socket.send(JSON.stringify({type:'event',operation:{id:'secret-op',sessionId:'secret-page',action:'fill_password',arguments:execution.arguments,intent:execution.intent,status:'succeeded',result:{echo:'fake-runtime-password'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}));
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(JSON.stringify(runtime.getOperations()).includes('fake-runtime-password'),false);
  socket.send(JSON.stringify({type:'event',operation:{id:'succeeded',sessionId:'secret-page',action:'fill_password',arguments:{password:'succeeded',note:'succeeded'},intent:'Requested value succeeded',status:'succeeded',result:{accepted:true},createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'}}));
  await new Promise(resolve => setTimeout(resolve,20));
  const sameAsStatus = runtime.getOperations().find(operation => operation.id === 'succeeded');
  assert.equal(sameAsStatus?.status,'succeeded','sensitive input matching protocol fields cannot corrupt operation identity or status');
  assert.deepEqual(sameAsStatus?.arguments,{password:'[REDACTED]',note:'[REDACTED]'});
  const failedResponse = next();
  runtime.registerAction({name:'fail_password',description:'Fail with native password',risk:'write',inputSchema:{type:'object',properties:{password:{type:'string',writeOnly:true}},required:['password']},async execute(input){throw new Error(`Rejected ${input.password}`);}});
  await failedResponse;
  const failed = next();socket.send(JSON.stringify({...execution,operationId:'secret-error',action:'fail_password'}));
  assert.equal((await failed).error,'Rejected [REDACTED]');
});
