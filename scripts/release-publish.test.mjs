import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const source=resolve('scripts');
for(const mode of ['new-version','same','collision','second-read-failure','missing-package','missing-token','scoped-registry'])test(`offline publisher: ${mode}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'clearact-publish-test-'));
 try{
  for(const dir of ['scripts','release-artifacts','bin','package'])mkdirSync(join(root,dir));
  for(const file of ['release-policy.mjs','release-publish.mjs'])copyFileSync(join(source,file),join(root,'scripts',file));
  const packages=[];
  for(const name of ['core','react']){
   const pkg={name:`@clearact/${name}`,version:'0.0.1-beta',license:'MIT',...(mode==='scoped-registry'?{publishConfig:{'@clearact:registry':'https://invalid.example/'}}:{})};
   writeFileSync(join(root,'package/package.json'),JSON.stringify(pkg));
   const file=`${name}.tgz`;execFileSync('tar',['-czf',join(root,'release-artifacts',file),'-C',root,'package']);
   const bytes=readFileSync(join(root,'release-artifacts',file));
   packages.push({name:pkg.name,version:pkg.version,file,sha256:createHash('sha256').update(bytes).digest('hex'),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')});
  }
  const manifest={schema:1,tag:'beta',access:'restricted',registry:'https://registry.npmjs.org/',packages};
  writeFileSync(join(root,'release-artifacts/manifest.json'),JSON.stringify(manifest));
  writeFileSync(join(root,'release-plan.json'),JSON.stringify({...manifest,packages:packages.map(({name,version})=>({name,version}))}));
  const log=join(root,'calls.jsonl');
  writeFileSync(join(root,'bin/npm'),`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'); const a=process.argv.slice(2),mode=process.env.MOCK_MODE;
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify({args:a,tokenPresent:!!process.env.NPM_READ_TOKEN})+'\n');
if(a[0]==='view'){
 if(mode==='missing-package'||(mode==='second-read-failure'&&a[1]==='@clearact/react'))process.exit(1);
 if(a[2]==='versions'){console.log(JSON.stringify(mode==='same'||mode==='collision'?['0.0.1-beta']:['0.0.0-beta']));}
 else{const m=JSON.parse(fs.readFileSync(process.env.MOCK_MANIFEST)); console.log(JSON.stringify(mode==='collision'?'sha512-wrong':m.packages.find(p=>a[1]===p.name+'@'+p.version).integrity));}
}else if(a[0]!=='publish')process.exit(2);
`,{mode:0o700});
  const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH,MOCK_MODE:mode,MOCK_LOG:log,MOCK_MANIFEST:join(root,'release-artifacts/manifest.json'),CLEARACT_NPM_PUBLISH_ENABLED:'true',CLEARACT_NPM_REGISTRY:'https://registry.npmjs.org/',GITHUB_ACTIONS:'true',GITHUB_SHA:'a'.repeat(40),CLEARACT_APPROVED_RELEASE_SHA:'a'.repeat(40),NPM_READ_TOKEN:'fake-read-only-test'};
  if(mode==='missing-token')delete env.NPM_READ_TOKEN;
  const result=spawnSync(process.execPath,['scripts/release-publish.mjs'],{cwd:root,env,encoding:'utf8'});
  const calls=(()=>{try{return readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);}catch{return [];}})();
  const publish=calls.filter(x=>x.args[0]==='publish');
  if(['new-version','same'].includes(mode))assert.equal(result.status,0,result.stderr);else assert.notEqual(result.status,0);
  assert.equal(publish.length,mode==='new-version'?2:0);
  for(const call of publish){for(const flag of ['--tag=beta','--access=restricted','--registry=https://registry.npmjs.org/','--ignore-scripts','--provenance=false'])assert.ok(call.args.includes(flag));assert.equal(call.tokenPresent,false);}
 }finally{rmSync(root,{recursive:true,force:true});}
});
