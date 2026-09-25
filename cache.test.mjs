import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCachedFetch} from './cached-fetch.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'jev-cache-'));
test.after(()=>fs.rm(root,{recursive:true,force:true}));
const input={method:'POST',body:JSON.stringify({model:'jev-1.13.0',state:'private fixture source',questions:{a:{type:'score',criteria:['bad','good']}}})};
test('fresh wrapper reuses persisted judgments without source text or paid tokens',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({model:'jev-1.13.0',answers:{a:{type:'score',score:.8,confidence:.7,unexpected:'private fixture source'}},usage:{input_tokens:20,output_tokens:3}});};
 const first=createCachedFetch({directory:root,fetcher});await first('fixture',input);
 const second=createCachedFetch({directory:root,fetcher});const r=await (await second('fixture',input)).json();assert.equal(calls,1);assert.equal(r._localCacheHit,true);assert.equal(r.usage.input_tokens,0);
 const files=await fs.readdir(root);assert.equal(files.length,1);assert.ok(!(await fs.readFile(path.join(root,files[0]),'utf8')).includes('private fixture source'));
});
test('expired and corrupt cache entries fall back to one fresh call',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({model:'jev-1.13.0',answers:{a:{type:'score',score:1,confidence:1}},usage:{input_tokens:4,output_tokens:2}});};
 await createCachedFetch({directory:root,fetcher,ttlMs:0})('fixture',input);assert.equal(calls,1);
 const files=await fs.readdir(root);await fs.writeFile(path.join(root,files[0]),'{broken');await createCachedFetch({directory:root,fetcher})('fixture',input);assert.equal(calls,2);
});
test('invalid scores are not persisted',async()=>{
 const directory=path.join(root,'invalid');await createCachedFetch({directory,fetcher:async()=>Response.json({model:'jev-1.13.0',answers:{a:{type:'score',score:1.9,confidence:1}},usage:{input_tokens:4,output_tokens:2}})})('fixture',input);await assert.rejects(fs.stat(directory));
});
