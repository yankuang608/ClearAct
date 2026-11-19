import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(process.env.CLEARACT_PACKAGES_OUTPUT||join(root,'work/package-distribution'));
const require=createRequire(import.meta.url);
const packageManager=JSON.parse(await readFile(join(root,'package.json'),'utf8')).packageManager as string;
const names=['core','dom','react','vue','element-plus','observer','server','mcp'];
const pnpm=process.env.CLEARACT_PNPM_BINARY||'pnpm';
const env:NodeJS.ProcessEnv={...process.env,CI:'true'};delete env.NODE_OPTIONS;delete env.NODE_PATH;
const run=(command:string,args:string[],cwd=root)=>execFileSync(command,args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const version=(name:string)=>require(name+'/package.json').version as string;
const evidence:Record<string,any>={startedAt:new Date().toISOString(),ok:false,node:process.version,pnpm:run(pnpm,['--version']).trim(),archives:[],scope:'Eight local tarballs and independent consumer import/types; no registry publication or license decision'};
let consumer:string|undefined;
let coreConsumer:string|undefined;
await mkdir(output,{recursive:true});
for(const file of ['failure-stdout.log','failure-stderr.log'])await rm(join(output,file),{force:true});
try{
 await writeFile(join(output,'build.log'),run(process.execPath,['--import','tsx',join(root,'scripts/build-packages.ts')]));
 const coreVersion=JSON.parse(await readFile(join(root,'packages/core/package.json'),'utf8')).version as string;
 const dependencies:Record<string,string>={react:version('react'),vue:version('vue'),'element-plus':version('element-plus')};
 for(const name of names){
  const packed=JSON.parse(run(pnpm,['--dir',join(root,'packages',name),'pack','--pack-destination',output,'--json']));
  const archive=resolve(packed.filename);
  const entries=run('tar',['-tzf',archive]).trim().split('\n');
  const expected=['package/dist/index.d.ts','package/dist/index.js','package/package.json'];
  if(existsSync(join(root,'packages',name,'CHANGELOG.md')))expected.push('package/CHANGELOG.md');
  if(['server','mcp'].includes(name))expected.push('package/dist/cli.js','package/dist/cli.d.ts','package/README.md');
  assert.deepEqual(entries.slice().sort(),expected.sort(),`${name}: unexpected archive content`);
  const manifest=JSON.parse(run('tar',['-xOzf',archive,'package/package.json']));
  assert.equal(manifest.exports['.'].import,'./dist/index.js');assert.equal(manifest.exports['.'].types,'./dist/index.d.ts');
  if(['dom','react','vue','element-plus','observer'].includes(name))assert.equal(manifest.peerDependencies['@clearact/core'],'^'+coreVersion);
  if(name==='server')assert.equal(manifest.dependencies['@clearact/core'],'^'+coreVersion);
  if(['server','mcp'].includes(name)){
   assert.equal(manifest.bin['clearact-'+name],'./dist/cli.js');
   assert.equal(manifest.exports['./cli'],'./dist/cli.js');
   assert.ok(run('tar',['-xOzf',archive,'package/dist/cli.js']).startsWith('#!/usr/bin/env node'));
  }
  for(const entry of expected.filter(entry=>entry.startsWith('package/dist/'))){
   const source=run('tar',['-xOzf',archive,entry]);
   assert.equal(source.includes(root),false,'Distribution leaked checkout path');
   assert.equal(/(?:from\s*|import\s*\()\s*['"][^'"]*(?:\/src\/|\.ts['"])/.test(source),false,'Distribution references TypeScript source');
   assert.equal(source.includes('../../core'),false,'Distribution references a sibling package source');
  }
  const bytes=await readFile(archive);
  evidence.archives.push({name:manifest.name,version:manifest.version,file:archive,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),entries,dependencies:manifest.dependencies,peerDependencies:manifest.peerDependencies});
  dependencies[manifest.name]='file:'+archive;
 }
 consumer=await mkdtemp(join(tmpdir(),'clearact-package-consumer-'));
 evidence.consumer={directory:consumer,outsideCheckout:!consumer.startsWith(root),dependencies};
 // Use the cache that actually populated this checkout, rather than a possibly changed global default.
 const modules=await readFile(join(root,'node_modules/.modules.yaml'),'utf8');
 const match=modules.match(/^\s*"?storeDir"?\s*:\s*"?([^"\n]+)"?\s*,?$/m);
 const store=process.env.CLEARACT_PNPM_STORE||(match?dirname(match[1]!.trim()):undefined);
 const overrides=Object.fromEntries(names.map(name=>['@clearact/'+name,dependencies['@clearact/'+name]]));
 await writeFile(join(consumer,'package.json'),JSON.stringify({name:'clearact-independent-consumer',packageManager,private:true,type:'module',dependencies,pnpm:{overrides},devDependencies:{typescript:version('typescript'),'@types/react':version('@types/react'),'@types/node':version('@types/node')}},null,2));
 await writeFile(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,lib:['ES2022','DOM'],types:[]},include:['consumer.ts']},null,2));
 await writeFile(join(consumer,'consumer.ts'),`import {createClearActRuntime,type ClearActAction,type PageSnapshot} from '@clearact/core';
import {installDOMPage,createDOMPageAdapter} from '@clearact/dom';
import {useClearActElementPlusView} from '@clearact/element-plus';
import {ClearActProvider,useClearActAction as useReactAction} from '@clearact/react';
import {createClearActPlugin,useClearActAction as useVueAction} from '@clearact/vue';
import {mountClearActObserver,type ClearActObserverOptions} from '@clearact/observer';
import {createClearActServer,canonical,ClearActBroker,type ClearActBrokerOptions} from '@clearact/server';
import {operationContent} from '@clearact/mcp';
import {createElement} from 'react';
const runtime=createClearActRuntime({sessionId:'consumer',serverUrl:'http://127.0.0.1:1'});
const action:ClearActAction={name:'read',description:'Read',risk:'read',inputSchema:{type:'object'},async execute(){return {count:1};}};
const reactTree=createElement(ClearActProvider,{runtime,children:'consumer'});
const vuePlugin=createClearActPlugin(runtime);
const observerOptions:ClearActObserverOptions={describeOperation:op=>op.action};
const observerArguments:Parameters<typeof mountClearActObserver>=[runtime,undefined,observerOptions];
const reactArguments:Parameters<typeof useReactAction>=[action];
const vueArguments:Parameters<typeof useVueAction>=[action];
const brokerOptions:ClearActBrokerOptions={approvalTimeoutMs:1000};
const server=createClearActServer({approvalToken:'independent-consumer-test',brokerOptions});
void [installDOMPage,createDOMPageAdapter,useClearActElementPlusView,reactTree,vuePlugin,observerArguments,reactArguments,vueArguments,canonical,ClearActBroker,operationContent];runtime.dispose();await server.close();
`);
 await writeFile(join(consumer,'runtime.mjs'),`import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {createClearActRuntime,ClearActRuntime} from '@clearact/core';
import {installDOMPage,createDOMPageAdapter} from '@clearact/dom';
import {useClearActElementPlusView} from '@clearact/element-plus';
import {ClearActProvider,useClearActAction as useReactAction} from '@clearact/react';
import {createClearActPlugin,useClearActAction as useVueAction} from '@clearact/vue';
import {mountClearActObserver} from '@clearact/observer';
import {createClearActServer,canonical,ClearActBroker,ClearActBrokerError} from '@clearact/server';
import {operationContent} from '@clearact/mcp';
const resolved={};
for(const name of ['core','dom','react','vue','element-plus','observer','server','mcp']){
 const path=realpathSync(fileURLToPath(import.meta.resolve('@clearact/'+name)));
 assert.ok(path.startsWith(realpathSync(process.cwd())+'/node_modules/'));assert.ok(path.endsWith('/dist/index.js'));resolved[name]=path;
}
const runtime=createClearActRuntime({sessionId:'independent',serverUrl:'http://127.0.0.1:1'});
assert.ok(runtime instanceof ClearActRuntime);
const unregister=runtime.registerAction({name:'read',description:'Read local fixture',risk:'read',inputSchema:{type:'object'},async execute(){return 1;}});
assert.equal(runtime.getActions().length,1);unregister();assert.equal(runtime.getActions().length,0);
for(const exported of [installDOMPage,createDOMPageAdapter,useClearActElementPlusView,ClearActProvider,useReactAction,createClearActPlugin,useVueAction,mountClearActObserver,createClearActServer,ClearActBroker,ClearActBrokerError,canonical,operationContent])assert.equal(typeof exported,'function');
for(const name of ['server','mcp']){
 const path=realpathSync(fileURLToPath(import.meta.resolve('@clearact/'+name+'/cli')));
 assert.ok(path.startsWith(realpathSync(process.cwd())+'/node_modules/'));assert.ok(path.endsWith('/dist/cli.js'));resolved[name+'/cli']=path;
}
assert.equal(canonical({b:2,a:{d:4,c:3}}),canonical({a:{c:3,d:4},b:2}));
const mcpRequire=createRequire(import.meta.resolve('@clearact/mcp'));
const {Client}=await import(mcpRequire.resolve('@modelcontextprotocol/sdk/client/index.js'));
const {StdioClientTransport}=await import(mcpRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
const server=createClearActServer({approvalToken:'independent-consumer-test'});
const client=new Client({name:'clearact-package-consumer',version:'1.0.0'});
let protocol;
try{
 server.server.listen(0,'127.0.0.1');await once(server.server,'listening');
 const base='http://127.0.0.1:'+server.server.address().port;
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(import.meta.resolve('@clearact/mcp/cli'))],cwd:process.cwd(),env:{CLEARACT_SERVER_URL:base},stderr:'pipe'});
 await client.connect(transport);
 const tools=(await client.listTools()).tools.map(tool=>tool.name).sort();
 assert.deepEqual(tools,['get_context','get_operation','invoke_action','list_actions']);
 const result=await client.callTool({name:'list_actions',arguments:{}});assert.notEqual(result.isError,true);
 protocol={localhost:true,builtCli:true,tools};
}finally{await client.close();await server.close();}
assert.equal(typeof createClearActPlugin(runtime).install,'function');runtime.dispose();
console.log(JSON.stringify({ok:true,resolved,protocol},null,2));
`);
 const installArgs=['install',...(process.env.CLEARACT_CONSUMER_OFFLINE==='0'?[]:['--offline']),'--no-frozen-lockfile','--ignore-scripts','--strict-peer-dependencies',...(store?['--store-dir',store]:[])];
 await writeFile(join(output,'consumer-install.log'),run(pnpm,installArgs,consumer));
 await writeFile(join(output,'consumer-types.log'),run(pnpm,['exec','tsc','--noEmit'],consumer));
 const runtimeLog=run(process.execPath,['runtime.mjs'],consumer);await writeFile(join(output,'consumer-runtime.json'),runtimeLog);
 evidence.consumer.runtime=JSON.parse(runtimeLog);evidence.consumer.typecheck={ok:true,skipLibCheck:false,moduleResolution:'NodeNext',sourcePaths:false};
 coreConsumer=await mkdtemp(join(tmpdir(),'clearact-core-only-'));
 await writeFile(join(coreConsumer,'package.json'),JSON.stringify({name:'clearact-core-only-consumer',packageManager,private:true,type:'module',dependencies:{'@clearact/core':dependencies['@clearact/core']},devDependencies:{typescript:version('typescript'),'@types/node':version('@types/node')}},null,2));
 await writeFile(join(coreConsumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,lib:['ES2022'],types:['node']},include:['consumer.ts']}));
 await writeFile(join(coreConsumer,'consumer.ts'),`import {createClearActRuntime,type PageSnapshot,type PageActionResult} from '@clearact/core';
const runtime=createClearActRuntime({sessionId:'node-only',serverUrl:'http://127.0.0.1:1',contextMode:'page'});
const result:PageActionResult={outcome:'completed',observationRequired:true};void result;runtime.dispose();
`);
 await writeFile(join(coreConsumer,'runtime.mjs'),`import assert from 'node:assert/strict';
import {createClearActRuntime} from '@clearact/core';
assert.equal(typeof globalThis.document,'undefined');
const runtime=createClearActRuntime({sessionId:'node-only',serverUrl:'http://127.0.0.1:1',contextMode:'page'});runtime.dispose();
for(const dependency of ['@clearact/dom','element-plus','vue','react'])await assert.rejects(import(dependency),{code:'ERR_MODULE_NOT_FOUND'});
console.log(JSON.stringify({ok:true,noBrowserGlobals:true,noUIFrameworkDependencies:true}));
`);
 await writeFile(join(output,'core-only-install.log'),run(pnpm,installArgs,coreConsumer));
 await writeFile(join(output,'core-only-types.log'),run(pnpm,['exec','tsc','--noEmit'],coreConsumer));
 const coreOnlyLog=run(process.execPath,['runtime.mjs'],coreConsumer);await writeFile(join(output,'core-only-runtime.json'),coreOnlyLog);
 evidence.coreOnly={...JSON.parse(coreOnlyLog),lib:['ES2022'],skipLibCheck:false};
 evidence.ok=true;
}catch(error){
 evidence.error=error instanceof Error?error.message:String(error);process.exitCode=1;
 if(error&&typeof error==='object')for(const stream of ['stdout','stderr']){
  const value=(error as Record<string,unknown>)[stream];if(value)await writeFile(join(output,`failure-${stream}.log`),String(value));
 }
}finally{
 if(consumer)await rm(consumer,{recursive:true,force:true});
 if(coreConsumer)await rm(coreConsumer,{recursive:true,force:true});
 evidence.finishedAt=new Date().toISOString();evidence.consumerRemoved=Boolean(consumer);
 await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({ok:evidence.ok,output,error:evidence.error},null,2));
}
