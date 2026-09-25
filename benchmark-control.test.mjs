import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {reserveBenchmark,settleBenchmark,correctBenchmarkSettlement,evaluatePairs,collectCompletedUsage} from './benchmark-control.mjs';
test('reservation prevents overcommit and counts actual overruns; duplicate reservation cannot double spend',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-budget-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await reserveBenchmark(dir,{id:'one',stage:'pilot',tokens:1500000});await reserveBenchmark(dir,{id:'one',stage:'pilot',tokens:1500000});
 await assert.rejects(reserveBenchmark(dir,{id:'two',stage:'pilot',tokens:600000}),/exceeds/);
 await settleBenchmark(dir,'one',1900000);await assert.rejects(reserveBenchmark(dir,{id:'two',stage:'pilot',tokens:100001}),/exceeds/);
});
test('audited settlement correction preserves the prior value and evidence',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-budget-correction-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await reserveBenchmark(dir,{id:'one',stage:'pilot',tokens:100});await settleBenchmark(dir,'one',80);await correctBenchmarkSettlement(dir,'one',95,{reason:'Recovered completed repair usage',evidence:'accounting-reconciliation.json'});const ledger=JSON.parse(await fs.readFile(path.join(dir,'budget.json'),'utf8')),entry=ledger.runs[0];assert.equal(entry.actualTokens,95);assert.equal(entry.status,'settled_corrected');assert.deepEqual(entry.corrections.map(item=>[item.from,item.to]),[[80,95]]);await assert.rejects(correctBenchmarkSettlement(dir,'one',99,{reason:'',evidence:'x'}),/requires/);
});
test('60 percent gate requires every pair, quality, category and shared overhead',()=>{
 const pairs=['feature','feature','bugfix','bugfix','maintenance','maintenance'].map(category=>({category,baselineTokens:1000,optimizedTokens:350,reconciled:true,qualityPassed:true,blindedReviewPassed:true,configurationMatched:true}));
 assert.equal(evaluatePairs(pairs).passed,true);assert.equal(evaluatePairs(pairs,{sharedRawTokens:12000}).passed,false);
 assert.throws(()=>evaluatePairs(pairs,{sharedRawTokens:-10788}),/Nonnegative/);
 assert.equal(evaluatePairs(pairs.slice(1)).passed,false);assert.equal(evaluatePairs(pairs.map((p,i)=>i? p:{...p,qualityPassed:false})).passed,false);
});
test('usage collector deduplicates identical events, rejects contradictory duplicates and incomplete records',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-usage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'session.jsonl');
 const usage={input_tokens:100,output_tokens:20,total_tokens:120};const record={type:'token_usage_record',payload:{turn_id:'turn',response_id:'response',usage,turn_token_usage:usage}};
 const rows=[{type:'session_meta',payload:{id:'s'}},{type:'turn_context',payload:{turn_id:'turn',model:'gpt-6-astra',effort:'high'}},record,record,{type:'event_msg',payload:{turn_id:'turn',type:'task_complete'}}];
 await fs.writeFile(file,rows.map(JSON.stringify).join('\n'));const result=await collectCompletedUsage(file,'s');assert.equal(result.rawTokens,120);assert.equal(result.requests,1);assert.equal(result.configurationEvidenceMissing.length,1);
 rows.push({...record,payload:{...record.payload,usage:{...usage,input_tokens:101}}});await fs.writeFile(file,rows.map(JSON.stringify).join('\n'));assert.equal((await collectCompletedUsage(file,'s')).rawTokens,null);
});
