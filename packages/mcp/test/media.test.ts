import test from 'node:test';
import assert from 'node:assert/strict';
import {operationContent} from '../src/media.ts';
test('page media is emitted as an MCP image without repeating base64 as text',()=>{
 const op={id:'op1',status:'succeeded',result:{page:2,media:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]}};
 const content:any[]=operationContent(op);assert.equal(content.length,2);assert.equal(content[1].type,'image');assert.equal(content[1].data,'aGVsbG8=');
 const text=JSON.parse(content[0].text);assert.equal(text.result.page,2);assert.equal(text.result.media[0].availableAsImage,true);assert.doesNotMatch(content[0].text,/aGVsbG8=/);assert.equal(op.result.media[0].data,'aGVsbG8=');
});
test('invalid media and non-success operations do not yield images',()=>{
 assert.equal(operationContent({status:'failed',result:{media:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]}}).length,1);
 for(const media of [{type:'image',mimeType:'text/html',data:'aGVsbG8='},{type:'image',mimeType:'image/png',data:'https://external.test/a.png'},{type:'image',mimeType:'image/png',data:'a'.repeat(128*1024+1)}])assert.equal(operationContent({status:'succeeded',result:{media:[media]}}).length,1);
});
