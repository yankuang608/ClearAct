import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createClearActRuntime, type ClearActAction, type ClearActEvent} from '../src/index.ts';
import {createClearActServer} from '../../server/src/http.ts';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'observable transition timed out');
    await delay(5);
  }
}
async function page(t: TestContext, execute: ClearActAction['execute']) {
  const app = createClearActServer({approvalToken: 'human-only'});
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const runtime = createClearActRuntime({sessionId: 'execution', serverUrl: `http://127.0.0.1:${(app.server.address() as {port: number}).port}`});
  t.after(async () => {runtime.dispose(); await app.close();});
  const unregister = runtime.registerAction({name: 'save', description: 'Save actual business state', risk: 'write', inputSchema: {type: 'object'}, execute});
  runtime.connect();
  await until(() => app.broker.listSessions().length === 1);
  return {runtime, app, unregister};
}

test('business execution waits for preparation and exposes its own signal with ordered phases', async t => {
  const preparation = deferred();
  let effects = 0, signal: AbortSignal | undefined;
  const {runtime, app} = await page(t, async (_args, context) => {effects++; signal = context.signal; return {saved: true};});
  const events: ClearActEvent[] = [];
  runtime.subscribe(event => events.push(event));
  let preparing = false;
  const remove = runtime.addBeforeExecuteHook(async (operation, context) => {
    assert.equal(operation.action, 'save');
    assert.equal(context.signal.aborted, false);
    preparing = true;
    await preparation.promise;
  });
  const operation = await runtime.invoke('save', {}, 'Save requested state');
  await until(() => preparing);
  assert.equal(effects, 0);
  preparation.resolve();
  await until(() => app.broker.getOperation(operation.id).status === 'succeeded');
  assert.equal(effects, 1);
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(events.filter(event => event.type === 'execution').map(event => event.phase), ['preparing', 'executing', 'settled']);
  remove();
  const next = await runtime.invoke('save', {}, 'Save another requested state');
  await until(() => app.broker.getOperation(next.id).status === 'succeeded');
  assert.equal(effects, 2);
});

test('stop during an uncooperative preparation cancels it without business effects', async t => {
  let effects = 0, preparationSignal: AbortSignal | undefined;
  const {runtime, app} = await page(t, async () => {effects++; return {saved: true};});
  runtime.addBeforeExecuteHook((_operation, context) => {preparationSignal = context.signal; return new Promise(() => {});});
  const operation = await runtime.invoke('save', {}, 'Save requested state');
  await until(() => Boolean(preparationSignal));
  await runtime.stop();
  await until(() => app.broker.getOperation(operation.id).status === 'cancelled');
  assert.equal(preparationSignal!.aborted, true);
  assert.equal(effects, 0);
  assert.equal(runtime.isAgentEnabled(), false);
  await assert.rejects(runtime.invoke('save', {}, 'Must remain stopped'), /stopp|disabled/i);
  await runtime.resume();
  assert.equal(runtime.isAgentEnabled(), true);
});

test('visual preparation errors do not fail an otherwise valid business action', async t => {
  let effects = 0;
  const {runtime, app} = await page(t, async () => {effects++; return {saved: true};});
  runtime.addBeforeExecuteHook(() => {throw new Error('visual target unavailable');});
  const operation = await runtime.invoke('save', {}, 'Save requested state');
  await until(() => app.broker.getOperation(operation.id).status === 'succeeded');
  assert.equal(effects, 1);
});

test('an uncooperative preparation has a total 1000ms budget and releases its visual signal', async t => {
  let effects = 0, preparationSignal: AbortSignal | undefined, executionSignal: AbortSignal | undefined;
  const {runtime, app} = await page(t, async (_args, context) => {effects++; executionSignal = context.signal; return {saved: true};});
  runtime.addBeforeExecuteHook((_operation, context) => {preparationSignal = context.signal; return new Promise(() => {});});
  const started = Date.now();
  const operation = await runtime.invoke('save', {}, 'Save requested state');
  await until(() => app.broker.getOperation(operation.id).status === 'succeeded');
  assert.ok(Date.now() - started >= 950, 'the full visual preparation budget is available');
  assert.ok(Date.now() - started < 1_500, 'visual feedback cannot suspend business indefinitely');
  assert.equal(effects, 1);
  assert.equal(preparationSignal!.aborted, true);
  assert.equal(executionSignal!.aborted, false, 'a visual timeout does not request business cancellation');
});

for (const invalidation of ['unregister', 'disconnect', 'dispose'] as const) {
  test(`${invalidation} during preparation never starts the stale business action`, async t => {
    let effects = 0, preparationSignal: AbortSignal | undefined;
    const {runtime, app, unregister} = await page(t, async () => {effects++; return {saved: true};});
    runtime.addBeforeExecuteHook((_operation, context) => {preparationSignal = context.signal; return new Promise(() => {});});
    const operation = await runtime.invoke('save', {}, 'Save requested state');
    await until(() => Boolean(preparationSignal));
    if (invalidation === 'unregister') unregister();
    else runtime[invalidation]();
    await until(() => ['cancelled', 'failed'].includes(app.broker.getOperation(operation.id).status));
    assert.equal(preparationSignal!.aborted, true);
    await delay(550);
    assert.equal(effects, 0);
    if (invalidation === 'disconnect') {
      await until(() => app.broker.listSessions().length === 0);
      runtime.connect();
      await until(() => app.broker.listSessions().length === 1);
      assert.equal(effects, 0, 'a replacement connection cannot execute the old preparation');
    }
  });
}

test('broker queued invocations prepare and execute in order', async t => {
  const firstPreparation = deferred();
  let firstId: string | undefined;
  const effects: string[] = [];
  const {runtime, app} = await page(t, async args => {effects.push(String(args.label)); return {saved: true};});
  runtime.setOperationIntervalMs(0);
  runtime.addBeforeExecuteHook(operation => {
    if (operation.arguments.label === 'first') {firstId = operation.id; return firstPreparation.promise;}
  });
  const first = await runtime.invoke('save', {label: 'first'}, 'First save');
  await until(() => Boolean(firstId));
  const second = await runtime.invoke('save', {label: 'second'}, 'Second save');
  assert.equal(second.status, 'queued');
  await delay(20);
  assert.deepEqual(effects, []);
  firstPreparation.resolve();
  await until(() => app.broker.getOperation(second.id).status === 'succeeded');
  assert.equal(app.broker.getOperation(first.id).status, 'succeeded');
  assert.deepEqual(effects, ['first', 'second']);
});

test('stop requests in-flight cancellation while preserving an actual successful result', async t => {
  const completed = deferred();
  let executionSignal: AbortSignal | undefined;
  const {runtime, app} = await page(t, async (_args, context) => {executionSignal = context.signal; await completed.promise; return {saved: true};});
  const operation = await runtime.invoke('save', {}, 'Save requested state');
  await until(() => Boolean(executionSignal));
  await runtime.stop();
  assert.equal(executionSignal!.aborted, true);
  assert.equal(app.broker.getOperation(operation.id).cancelRequested, true);
  assert.equal(app.broker.getOperation(operation.id).status, 'executing');
  completed.resolve();
  await until(() => app.broker.getOperation(operation.id).status === 'succeeded');
  assert.deepEqual(app.broker.getOperation(operation.id).result, {saved: true});
});

test('a stopped session remains stopped in a replacement runtime until page resume', async t => {
  let effects = 0;
  const {runtime, app} = await page(t, async () => {effects++; return {};});
  await runtime.stop();
  runtime.dispose();
  await until(() => app.broker.listSessions().length === 0);
  const replacement = createClearActRuntime(runtime.options);
  t.after(() => replacement.dispose());
  replacement.registerAction({name: 'save', description: 'Save actual business state', risk: 'write', inputSchema: {type: 'object'}, async execute() {effects++; return {};}});
  replacement.connect();
  await until(() => app.broker.listSessions().length === 1 && !replacement.isAgentEnabled());
  await assert.rejects(replacement.invoke('save', {}, 'Remain stopped'), /stopp|disabled/i);
  await replacement.resume();
  const operation = await replacement.invoke('save', {}, 'Explicitly resumed save');
  await until(() => app.broker.getOperation(operation.id).status === 'succeeded');
  assert.equal(effects, 1);
});

test('an offline stop is retained during connection registration and cannot be resumed offline', async t => {
  const {runtime, app} = await page(t, async () => ({}));
  runtime.disconnect();
  await until(() => app.broker.listSessions().length === 0);
  await runtime.stop();
  await assert.rejects(runtime.resume(), /connection|registered/i);
  runtime.connect();
  await until(() => app.broker.listSessions().length === 1);
  assert.equal(runtime.isAgentEnabled(), false);
  assert.equal(app.broker.listSessions()[0]!.enabled, false);
  await assert.rejects(runtime.invoke('save', {}, 'Remain stopped'), /stopp/i);
});

test('a synchronous stop in the executing notification still prevents business startup', async t => {
  let effects = 0;
  const {runtime, app} = await page(t, async () => {effects++; return {};});
  runtime.subscribe(event => {if (event.type === 'execution' && event.phase === 'executing') void runtime.stop();});
  const operation = await runtime.invoke('save', {}, 'Save requested state');
  await until(() => app.broker.getOperation(operation.id).status === 'cancelled');
  assert.equal(effects, 0);
});

test('an action that honors cancellation reports cancelled without claiming rollback', async t => {
  let effects = 0, began = false;
  const {runtime, app} = await page(t, async (_args, context) => {
    effects++; began = true;
    await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), {once: true}));
  });
  const operation = await runtime.invoke('save', {}, 'Save requested state');
  await until(() => began);
  await runtime.stop();
  await until(() => app.broker.getOperation(operation.id).status === 'cancelled');
  assert.equal(effects, 1, 'cancellation cannot undo an already submitted business effect');
  assert.match(app.broker.getOperation(operation.id).error!, /does not imply rollback/i);
});

for (const update of ['context', 'register', 'unregister'] as const) {
  test(`${update} updates while resume acknowledgement is pending do not stop the restored page`, async t => {
    let effects = 0;
    const {runtime, app} = await page(t, async () => {effects++; return {saved: true};});
    const extraAction = {name: 'extra', description: 'Another real page action', risk: 'read' as const, inputSchema: {type: 'object'}, async execute() {return {};}};
    let unregisterExtra: (() => void) | undefined;
    if (update === 'unregister') {
      unregisterExtra = runtime.registerAction(extraAction);
      await until(() => app.broker.getActions('execution').some(action => action.name === 'extra'));
    }
    await runtime.stop();
    const resumed = runtime.resume();
    assert.equal(runtime.isAgentEnabled(), false, 'restore acknowledgement is still pending in this synchronous turn');
    if (update === 'context') runtime.setContext({sequence: 'while-resuming'});
    else if (update === 'register') runtime.registerAction(extraAction);
    else unregisterExtra!();
    await resumed;
    await until(() => update === 'context'
      ? (app.broker.getContext('execution') as Record<string,unknown>).sequence === 'while-resuming'
      : app.broker.getActions('execution').some(action => action.name === 'extra') === (update === 'register'));
    assert.equal(app.broker.listSessions()[0]!.enabled, true, 'ordinary metadata updates must not reverse explicit resume');
    assert.equal(runtime.isAgentEnabled(), true);
    const operation = await runtime.invoke('save', {}, 'Save after explicit resume');
    await until(() => app.broker.getOperation(operation.id).status === 'succeeded');
    assert.equal(effects, 1);
  });
}

test('a readable cursor preparation can finish after the old half-second limit', async t => {
  let arrived = false, executedAfterArrival = false;
  const {runtime, app} = await page(t, async () => {executedAfterArrival = arrived; return {};});
  runtime.addBeforeExecuteHook(async () => {await delay(700); arrived = true;});
  const operation = await runtime.invoke('save', {}, 'Wait for the visible cursor to arrive');
  await until(() => app.broker.getOperation(operation.id).status === 'succeeded');
  assert.equal(executedAfterArrival, true);
});
