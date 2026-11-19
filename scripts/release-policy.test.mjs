import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {validatePlan,publicationGate,registry} from './release-policy.mjs';
const plan={schema:1,tag:'beta',registry,access:'restricted',packages:[{name:'@clearact/react',version:'0.0.1-beta'}]};
test('exact first beta and numbered follow-up accepted',()=>{validatePlan(plan);validatePlan({...plan,packages:[{name:'@clearact/react',version:'0.0.2-beta.0'}]});});
for(const [name,change] of Object.entries({latest:{tag:'latest'},stable:{packages:[{name:'@clearact/react',version:'0.0.1'}]},foreign:{registry:'https://example.invalid/'},public:{access:'public'},empty:{packages:[]},duplicate:{packages:[...plan.packages,...plan.packages]}}))test(`reject ${name}`,()=>assert.throws(()=>validatePlan({...plan,...change})));
test('publish gate requires every explicit condition',()=>{
 const env={CLEARACT_NPM_PUBLISH_ENABLED:'true',CLEARACT_NPM_REGISTRY:registry,GITHUB_ACTIONS:'true',GITHUB_SHA:'a'.repeat(40),CLEARACT_APPROVED_RELEASE_SHA:'a'.repeat(40)};
 publicationGate(env);
 for(const key of Object.keys(env)){const copy={...env};delete copy[key];assert.throws(()=>publicationGate(copy));}
});
test('no-credential default exits before even a subprocess or network call',()=>{
 const result=spawnSync(process.execPath,['scripts/release-publish.mjs'],{env:{PATH:'/nonexistent'},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Publishing is disabled/);
});
