import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {snapshot,redact,groupLines,rank,triage,readRange} from './core.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'jev-tests-'));
const file=path.join(root,'sample.rpt'), roots=[root];
await fs.writeFile(file,'12:00:00 Server version: 1.29\n12:00:01 ERROR: invalid timestamp schema\nWLMQuestDB.LoadDB\nFinishingAt=4000\n12:00:02 pulse\n12:00:03 pulse\n');
test.after(()=>fs.rm(root,{recursive:true,force:true}));
test('snapshot boundaries and hash freshness',async()=>{
  const s=await snapshot(file,roots);assert.equal(s.sha256.length,64);
  await assert.rejects(snapshot(file,[path.join(root,'elsewhere')]),/outside/);
  await assert.rejects(snapshot(file.replace('.rpt','.env'),roots),/\.rpt/);
  await assert.rejects(readRange({file,sha256:'0'.repeat(64),start:1},{roots}),/changed/);
  const r=await readRange({file,sha256:s.sha256,start:2,count:3},{roots});assert.match(r.text,/LoadDB/);assert.equal(r.end,4);
});
test('timestamps collapse but candidate IDs and amounts remain distinct',()=>{
  const groups=groupLines(['12:00:00 same 4000','12:00:01 same 4000','12:00:02 same 4001'],'same');assert.equal(groups.length,2);assert.equal(groups[0].count,2);assert.equal(groups[0].last,2);
});
test('redaction covers common secrets and endpoints',()=>{
  const text=redact('apikey_abcdef_123 password="hello world" token=abcdef 76561190000000000 192.168.1.12:2302 https://example.com/webhook/secret C:\\Users\\sampleuser\\test');
  for(const secret of ['apikey_abcdef','hello world','token=abcdef','7656119','192.168','example.com','sampleuser'])assert.ok(!text.includes(secret));
});
test('critical and neighboring stack evidence retained without network',async()=>{
  const r=await triage({file,question:'schema failure'},{roots,fetcher(){throw Error('unexpected network')}});assert.equal(r.provider.status,'local-only');assert.match(JSON.stringify(r.selected),/WLMQuestDB.LoadDB/);assert.equal(r.duplicateLinesCollapsed,1);
});
test('small evidence set skips paid API even when sharing is enabled',async()=>{
  const r=await triage({file,question:'schema failure',shareWithTypeSafe:true},{roots,apiKey:'test',fetcher(){throw Error('Should not spend tokens');}});
  assert.match(r.provider.status,/fits budget/);
});
test('Jev schema failures fall back and never expose provider text',async()=>{
  const result=await rank([{id:'x',text:'routine'}],'unique-failure',{apiKey:'secret',fetcher:async()=>new Response('secret body',{status:401})});assert.match(result.status,/fallback/);assert.ok(!JSON.stringify(result).includes('secret'));
  const invalid=await rank([{id:'y',text:'routine'}],'invalid',{apiKey:'secret',fetcher:async()=>Response.json({answers:{y:{type:'score',score:20}}})});assert.match(invalid.status,/fallback/);
});
test('Jev sees bounded redacted passages; identical call cached',async()=>{
  let calls=0;const fetcher=async(url,options)=>{calls++;const body=JSON.parse(options.body);assert.ok(!JSON.stringify(body.state).includes('password=xyz'));return Response.json({model:'jev-1.13.0',answers:{g1:{type:'score',score:1.7}},usage:{input_tokens:20,output_tokens:10}});};
  const gs=[{id:'g1',text:'password=xyz'}];await rank(gs,'cache-case',{apiKey:'secret',fetcher});const second=await rank(gs,'cache-case',{apiKey:'secret',fetcher});assert.equal(calls,1);assert.equal(second.status,'jev-cache');assert.equal(second.usage.input_tokens,0);
});
test('output budget exposes omitted critical groups',async()=>{
  const f=path.join(root,'huge.log');await fs.writeFile(f,Array.from({length:100},(_,i)=>`ERROR distinct_${i} `+'x'.repeat(150)).join('\n'));
  const r=await triage({file:f,question:'failures',maxExcerptChars:1500},{roots});assert.ok(r.metrics.excerptCharacters<=1500);assert.ok(r.omittedCriticalCount>0);assert.equal(r.omittedInventory.length,12);assert.equal(r.nextInventoryOffset,12);
});
test('UTF-16LE and symlink escapes',async()=>{
  const f=path.join(root,'utf16.rpt');await fs.writeFile(f,Buffer.concat([Buffer.from([255,254]),Buffer.from('ERROR UTF16 test','utf16le')]));assert.equal((await snapshot(f,roots)).lines[0],'ERROR UTF16 test');
  const sibling=await fs.mkdtemp(path.join(os.tmpdir(),'jev-outside-'));try{await fs.writeFile(path.join(sibling,'secret.log'),'not allowed');await fs.symlink(sibling,path.join(root,'linked'),'junction');await assert.rejects(snapshot(path.join(root,'linked','secret.log'),roots),/outside/);}finally{await fs.rm(path.join(root,'linked'),{force:true,recursive:true});await fs.rm(sibling,{force:true,recursive:true});}
});
