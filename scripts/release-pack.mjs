import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {validatePlan} from './release-policy.mjs';
const plan = validatePlan(JSON.parse(readFileSync('release-plan.json', 'utf8')));
const out = resolve('release-artifacts'); mkdirSync(out, {recursive:true});
const packages = readdirSync('packages').map(dir=>({dir, ...JSON.parse(readFileSync(`packages/${dir}/package.json`,'utf8'))}));
const artifacts=[];
for (const entry of plan.packages) {
  const pkg=packages.find(p=>p.name===entry.name); assert.ok(pkg); assert.equal(pkg.version,entry.version); assert.ok(!pkg.private);
  execFileSync(process.env.CLEARACT_PNPM_BINARY || 'pnpm',['pack','--out', `${out}/${pkg.name.split('/')[1]}.tgz`],{cwd:`packages/${pkg.dir}`,stdio:'inherit'});
  const file=`${pkg.name.split('/')[1]}.tgz`, bytes=readFileSync(`${out}/${file}`);
  const packed=JSON.parse(execFileSync('tar',['-xOf',`${out}/${file}`,'package/package.json'],{encoding:'utf8'}));
  assert.equal(packed.name,entry.name); assert.equal(packed.version,entry.version);
  artifacts.push({...entry,file,sha256:createHash('sha256').update(bytes).digest('hex'),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')});
}
writeFileSync(`${out}/manifest.json`,JSON.stringify({...plan,packages:artifacts},null,2)+'\n');
