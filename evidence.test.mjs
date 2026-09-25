import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {textSnapshot,selectContext,readContext,chunks} from './evidence.mjs';
import {checkOutput} from './quality.mjs';
import {recordUsage} from './usage-ledger.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'jev-evidence-'));
const options={contextRoots:[root],apiKey:'fixture-only'};
test.after(()=>fs.rm(root,{recursive:true,force:true}));
test('source safety, line references and stale follow-up',async()=>{
 const file=path.join(root,'sample.ts');
 await fs.writeFile(file,'before\n-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----\nafter');
 const snap=await textSnapshot(file,[root]);assert.equal(snap.lines[4],'after');assert.ok(!snap.text.includes('secret-material'));
 await assert.rejects(textSnapshot(file,[]),/outside/);
 const secret=path.join(root,'credentials.json');await fs.writeFile(secret,'{}');await assert.rejects(textSnapshot(secret,[root]),/Protected/);
 const binary=path.join(root,'binary.txt');await fs.writeFile(binary,'x\0y');await assert.rejects(textSnapshot(binary,[root]),/Binary/);
 const range=await readContext({file,sha256:snap.sha256,start:5},options);assert.match(range.text,/5: after/);
 await fs.appendFile(file,' changed');await assert.rejects(readContext({file,sha256:snap.sha256,start:1},options),/changed/);
});
test('JVM source files are supported without relaxing context-root containment',async()=>{
 const java=path.join(root,'Engine.java');await fs.writeFile(java,'final class Engine {}\n');
 const kotlin=path.join(root,'Engine.kt');await fs.writeFile(kotlin,'class Engine\n');
 assert.match((await textSnapshot(java,[root])).text,/class Engine/);
 assert.match((await textSnapshot(kotlin,[root])).text,/class Engine/);
 await assert.rejects(textSnapshot(java,[]),/outside configured context roots/);
});
test('local small input avoids provider; long lines preserve all segments',async()=>{
 const file=path.join(root,'small.md');await fs.writeFile(file,'A concise answer.');
 const result=await selectContext({file,question:'answer',shareWithTypeSafe:true},{...options,fetcher(){throw Error('No network expected');}});
 assert.match(result.provider.status,/fits budget/);assert.equal(result.omittedChunks,0);
 const parts=chunks(['a'.repeat(2000),'next']);assert.equal(parts.map(p=>p.text).join(''),'a'.repeat(2000)+'next');assert.equal(parts[2].columnStart,1701);
});
test('ranked source selection is bounded, paged, redacted and cached',async()=>{
 const file=path.join(root,'large.cs');await fs.writeFile(file,Array.from({length:70},(_,i)=>`// topic ${i} password=do-not-send\n`+'x'.repeat(780)).join('\n'));
 let calls=0;const opts={...options,fetcher:async(url,{body})=>{calls++;const p=JSON.parse(body);assert.ok(!body.includes('do-not-send'));assert.ok(p.state.passages.length<=24);return Response.json({model:p.model,answers:Object.fromEntries(p.state.passages.map((v,i)=>[v.id,{type:'score',score:i===0?2:0}])),usage:{input_tokens:100,output_tokens:30}});}};
 const input={file,question:'topic 0',shareWithTypeSafe:true,maxExcerptChars:1000};const r=await selectContext(input,opts);assert.equal(r.provider.status,'jev');assert.ok(r.excerptCharacters<=1000);assert.ok(r.omittedChunks>0);assert.equal(r.nextCandidateOffset,24);assert.ok(r.unexaminedChunks>0);
 const cached=await selectContext(input,opts);assert.equal(cached.provider.status,'jev-cache');assert.equal(calls,1);
 const empty=await selectContext({...input,candidateOffset:9999},opts);assert.equal(empty.selected.length,0);assert.equal(empty.nextCandidateOffset,null);
});
test('quality results remain advisory, cache safely, reject invalid scores',async()=>{
 const file=path.join(root,'output.py');await fs.writeFile(file,'def add(a, b):\n    return a+b\n');
 const args={file,criteria:['Returns the sum of its two arguments.'],shareWithTypeSafe:true};let calls=0;
 const opts={...options,fetcher:async()=>{calls++;return Response.json({model:'jev-1.13.0',answers:{c0:{type:'score',score:1.95,confidence:.9}},usage:{input_tokens:40,output_tokens:15}});}};
 const r=await checkOutput(args,opts);assert.equal(r.advisoryOnly,true);assert.equal(r.checks.length,1);assert.ok(!('passed' in r));
 assert.equal(r.canCompleteCodeReview,false);assert.equal(r.scope,'atomic_artifact_scores');
 const c=await checkOutput(args,opts);assert.equal(c.provider.status,'jev-cache');assert.equal(c.provider.usage.input_tokens,0);assert.equal(calls,1);
 const invalid=await checkOutput({...args,criteria:['A different criterion']},{...options,fetcher:async()=>Response.json({answers:{c0:{type:'score',score:99,confidence:1}},usage:{input_tokens:7,output_tokens:3}})});assert.equal(invalid.checks.length,0);assert.match(invalid.provider.status,/not-assessed/);assert.equal(invalid.provider.usage.input_tokens,7);
 const local=await checkOutput({...args,shareWithTypeSafe:false},opts);assert.equal(local.checks.length,0);assert.equal(calls,1);
});
test('durable ledger excludes source text and records unknown cost honestly',async()=>{
 const file=path.join(root,'usage.jsonl');const r={sha256:'a'.repeat(64),selected:[{text:'private text'}],provider:{status:'jev',model:'jev-1.13.0',usage:{input_tokens:17,output_tokens:3}}};
 await recordUsage(file,'selectContext',r);assert.ok(r.usageReceipt);await recordUsage(file,'selectContext',{provider:{status:'local-fallback'}});
 const text=await fs.readFile(file,'utf8');assert.ok(!text.includes('private text'));const rows=text.trim().split('\n').map(JSON.parse);assert.equal(rows[0].inputTokens,17);assert.equal(rows[1].inputTokens,null);
 const fail=await recordUsage(path.join(root,'missing','ledger'),'test',{provider:{status:'jev'}});assert.match(fail.usageLedgerWarning,/Do not repeat/);
});
