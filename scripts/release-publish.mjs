// CI-only, fail-closed. Never invokes Changesets publish or its first-publish latest behavior.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {publicationGate,validatePlan,registry} from './release-policy.mjs';
publicationGate(process.env); // Before any subprocess or registry contact.
const plan=validatePlan(JSON.parse(readFileSync('release-plan.json','utf8')));
const manifest=validatePlan(JSON.parse(readFileSync('release-artifacts/manifest.json','utf8')));
assert.deepEqual(manifest.packages.map(({name,version})=>({name,version})),plan.packages);
assert.ok(process.env.NPM_READ_TOKEN, 'Restricted-package metadata requires separately configured read-only npm token; OIDC alone cannot npm view');
const temp=mkdtempSync(join(tmpdir(),'clearact-npm-'));
const config=join(temp,'npmrc'), readConfig=join(temp,'read-npmrc'), globalConfig=join(temp,'global-npmrc');
writeFileSync(globalConfig,'');
writeFileSync(config,`registry=${registry}\n@clearact:registry=${registry}\n`);
writeFileSync(readConfig,`registry=${registry}\n@clearact:registry=${registry}\n//registry.npmjs.org/:_authToken=\${NPM_READ_TOKEN}\n`,{mode:0o600});
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^npm_config_/i.test(k)&&!['NODE_AUTH_TOKEN','NPM_TOKEN','NPM_READ_TOKEN'].includes(k)));
const npm=(args,reading=false)=>execFileSync('npm',[...args,`--userconfig=${reading?readConfig:config}`,`--globalconfig=${globalConfig}`],{cwd:temp,env:reading?{...cleanEnv,NPM_READ_TOKEN:process.env.NPM_READ_TOKEN}:cleanEnv,encoding:'utf8',stdio:reading?'pipe':'inherit'});
const ready=[];
try {
// Preflight ALL packages before performing any mutation. New names require a separate owner-approved bootstrap.
for(const pkg of manifest.packages) {
  assert.equal(pkg.file,pkg.name.split('/')[1]+'.tgz');
  const path=`release-artifacts/${pkg.file}`, bytes=readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),pkg.sha256);
  assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),pkg.integrity);
  const packed=JSON.parse(execFileSync('tar',['-xOf',path,'package/package.json'],{encoding:'utf8'}));
  assert.equal(packed.name,pkg.name);assert.equal(packed.version,pkg.version);assert.ok(!packed.private);
  assert.ok(packed.license && packed.license!=='UNLICENSED','Owner-approved package license required');
  assert.ok(!packed.publishConfig?.registry || packed.publishConfig.registry===registry);
  assert.ok(!packed.publishConfig?.tag || packed.publishConfig.tag==='beta');
  assert.ok(!packed.publishConfig?.access || packed.publishConfig.access==='restricted');
  assert.ok(Object.keys(packed.publishConfig??{}).every(k=>['registry','tag','access'].includes(k)), 'Unreviewed publishConfig keys');
  const versions=JSON.parse(npm(['view',pkg.name,'versions','--json',`--registry=${registry}`],true));
  if([versions].flat().includes(pkg.version)) {
    const integrity=JSON.parse(npm(['view',`${pkg.name}@${pkg.version}`,'dist.integrity','--json',`--registry=${registry}`],true));
    assert.equal(integrity,pkg.integrity,'Existing version has different bytes: stop, do not overwrite');
    console.log(`${pkg.name}@${pkg.version}: identical existing artifact, skipped`);
  } else ready.push(path);
}
for(const path of ready) npm(['publish',resolve(path),'--ignore-scripts','--tag=beta','--access=restricted',`--registry=${registry}`,'--provenance=false']);
} finally {rmSync(temp,{recursive:true,force:true});}
