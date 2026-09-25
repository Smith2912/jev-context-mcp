import test from 'node:test';
import assert from 'node:assert/strict';
import {compactContext} from './compact-context.mjs';
test('compact context preserves every selected byte and retrieval coordinate',()=>{
 const input={file:'C:/fixture.js',sha256:'a'.repeat(64),selected:[{id:'p0',start:2,end:3,text:'first\nsecond',score:2},{id:'p1',start:8,end:8,columnStart:851,text:'continuation',score:1}],omittedChunks:6,nextCandidateOffset:24,provider:{status:'jev',usage:{input_tokens:123,output_tokens:3}},usageReceipt:'receipt',usageLedgerWarning:'Accounting unavailable'};
 const output=compactContext(input);
 assert.deepEqual(output.selected,input.selected.map(({start,end,columnStart,text})=>({start,end,...(columnStart===undefined?{}:{columnStart}),text})));
 for(const k of ['file','sha256','omittedChunks','nextCandidateOffset','provider','usageReceipt','usageLedgerWarning'])assert.deepEqual(output[k],input[k]);
 assert.match(output.warning,/omit relevant context/);
});
