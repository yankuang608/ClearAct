import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {test} from 'node:test';
import {privateArguments, scrubSecretEcho} from '../src/redaction.ts';

test('short and overlapping secrets preserve redaction markers across repeated projections', () => {
  const schema = {type: 'object', properties: {password: {type: 'string', writeOnly: true}}};
  for (const password of ['R', '[', 'REDACTED']) {
    const first = privateArguments({password}, schema);
    assert.deepEqual(first.arguments, {password: '[REDACTED]'});
    assert.deepEqual(privateArguments(first.arguments, schema).arguments, first.arguments);
  }
  const secrets = ['longRsecret', 'R'];
  const first = scrubSecretEcho('Denied longRsecret and R', secrets);
  assert.equal(first, 'Denied [REDACTED] and [REDACTED]');
  assert.equal(scrubSecretEcho(first, secrets), first);
  for (const password of ['synthetic[REDACTED]suffix', '[REDACTED]suffix', 'prefix[REDACTED]']) {
    assert.equal(scrubSecretEcho(`Rejected ${password}`, [password]), 'Rejected [REDACTED]');
  }
});

test('recursive root references redact every nested private value',()=>{
 const schema={type:'object',properties:{privateField:{type:'string',writeOnly:true},child:{$ref:'#'},children:{type:'array',items:{$ref:'#'}}}};
 const input={privateField:'synthetic-root',child:{privateField:'synthetic-child',child:{privateField:'synthetic-grandchild'}},children:[{privateField:'synthetic-array'}]};
 assert.equal(new Ajv({strict:false}).compile(schema)(input),true);
 const projected=privateArguments(input,schema);
 assert.deepEqual(projected.arguments,{privateField:'[REDACTED]',child:{privateField:'[REDACTED]',child:{privateField:'[REDACTED]'}},children:[{privateField:'[REDACTED]'}]});
 assert.equal(projected.secrets.length,4);
});

test('named local schema references conceal private annotations',()=>{
 const schema={type:'object',definitions:{private:{$id:'#private',type:'string',writeOnly:true}},properties:{privateField:{$ref:'#private'},publicField:{type:'string'}}};
 const input={privateField:'synthetic-named-private',publicField:'visible'};
 assert.equal(new Ajv({strict:false}).compile(schema)(input),true);
 assert.deepEqual(privateArguments(input,schema).arguments,{privateField:'[REDACTED]',publicField:'visible'});
});

test('schema dependencies conceal conditional private properties',()=>{
 const schema={type:'object',properties:{enabled:{type:'boolean'},privateField:{type:'string'}},dependencies:{enabled:{properties:{privateField:{writeOnly:true}}}}};
 const input={enabled:true,privateField:'synthetic-dependent-private'};
 assert.equal(new Ajv({strict:false}).compile(schema)(input),true);
 assert.deepEqual(privateArguments(input,schema).arguments,{enabled:true,privateField:'[REDACTED]'});
});

test('array contains annotations conceal potentially private entries',()=>{
 const schema={type:'object',properties:{entries:{type:'array',contains:{type:'string',writeOnly:true}}}};
 const input={entries:['synthetic-contained-private']};
 assert.equal(new Ajv({strict:false}).compile(schema)(input),true);
 assert.deepEqual(privateArguments(input,schema).arguments,{entries:['[REDACTED]']});
});

test('secret echo scrubbing preserves dates and normal toJSON serialization',()=>{
 const input={savedAt:new Date('2026-01-01T00:00:00.000Z'),saved:true,metadata:{toJSON(key:string){return {field:key,status:'recorded'};}}};
 const scrubbed=scrubSecretEcho(input,['synthetic-hidden-input']);
 assert.equal(JSON.stringify(scrubbed),JSON.stringify(input));
 assert.equal(scrubSecretEcho({toJSON(){return 'synthetic-hidden-input';}},['synthetic-hidden-input']),'[REDACTED]');
});

test('nested schema resource identifiers resolve references against their own document',()=>{
 const schema={$id:'https://example.invalid/root.json',type:'object',definitions:{nested:{$id:'nested.json',type:'object',definitions:{private:{type:'string',writeOnly:true}},properties:{privateField:{$ref:'#/definitions/private'},publicField:{type:'string'}}}},properties:{child:{$ref:'nested.json'}}};
 const input={child:{privateField:'synthetic-resource-private',publicField:'visible'}};
 assert.equal(new Ajv({strict:false}).compile(schema)(input),true);
 assert.deepEqual(privateArguments(input,schema).arguments,{child:{privateField:'[REDACTED]',publicField:'visible'}});
});

test('references outside the action schema conceal their whole value',()=>{
 const schema={type:'object',properties:{external:{$ref:'https://example.invalid/external.json'}}};
 const projected=privateArguments({external:{value:'synthetic-unresolved-private'}},schema);
 assert.deepEqual(projected.arguments,{external:'[REDACTED]'});
 assert.equal(projected.secrets.length,1);
});


test('echo scrubbing never retains a second callable toJSON from its first result', () => {
  const marker = 'synthetic-json-private-marker';
  let outerCalls = 0, innerCalls = 0;
  const inner = {echo: marker, toJSON() {innerCalls++; return {echo: marker};}};
  const value = {toJSON() {outerCalls++; return inner;}};
  const projected = scrubSecretEcho(value, [marker]);
  assert.equal(JSON.stringify(projected), '{"echo":"[REDACTED]"}');
  assert.equal(outerCalls, 1);
  assert.equal(innerCalls, 0);
});

test('echo scrubbing follows JSON semantics for boxed strings and absent values', () => {
  const marker = 'synthetic-boxed-private-marker';
  const value = {echo: new String(marker), publicText: new String('public'), absent: undefined};
  assert.equal(JSON.stringify(scrubSecretEcho(value, [marker])), '{"echo":"[REDACTED]","publicText":"public"}');
  assert.equal(scrubSecretEcho(undefined, [marker]), undefined);
});
