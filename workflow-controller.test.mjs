import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createWorkflow} from './workflow-runtime.mjs';
import {createWorkflowController} from './workflow-controller.mjs';
import {estimateTokens} from './decision-engine.mjs';
const policy=JSON.parse(await fs.readFile(new URL('./decision-policy.json',import.meta.url),'utf8'));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function fixture(t,fetcher){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-controller-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'src');await fs.mkdir(root);
 const source='export const value = 1;\n',check='import {value} from "./index.mjs";if(value!==1){console.error("EXPECTED value 1, ACTUAL",value);process.exit(1)}';
 await fs.writeFile(path.join(root,'index.mjs'),source);await fs.writeFile(path.join(root,'check.mjs'),check);
 await fs.writeFile(path.join(root,'background.txt'),'Historical unrelated context.\n'.repeat(500));
 const manifest={root,contract:'Keep value equal to one.',requirements:['Export value one'],files:[{id:'source',path:'index.mjs',mandatory:true},{id:'test',path:'check.mjs',acceptance:true,frozenHash:hash(check)},{id:'background',path:'background.txt'}],actions:{verify:[{id:'unit',executable:process.execPath,args:['check.mjs']}]}};
 const content=JSON.stringify(manifest),file=path.join(dir,'manifest.json');await fs.writeFile(file,content);
 const settings={workflow:{enabled:true,artifactDirectory:path.join(dir,'runs'),allowedExecutables:[process.execPath],registrations:{fixture:{path:file,sha256:hash(content)}}}};
 const workflow=createWorkflow({settings,policy,apiKey:fetcher?'fixture':undefined,fetcher});return {dir,root,workflow,controller:createWorkflowController(workflow),input:{workflowId:'fixture',runId:'test',maxExcerptChars:1000}};
}
test('two model-facing calls preserve evidence and verify without caller hash/report requests',async t=>{
 const f=await fixture(t),packet=await f.controller.prepare_work_packet(f.input);
 assert.equal(packet.status,'prepared');assert.equal(packet.selected.filter(e=>e.mandatory).length,2);assert.equal(packet.optionalOmittedCount,3);
 assert.match(packet.selected.find(e=>e.file.endsWith('index.mjs')).sha256,/^[a-f0-9]{64}$/);
 assert.equal(packet.sourceHashes,undefined);assert.equal(packet.provider.receipts,0);
 const result=await f.controller.finish_work_packet({...f.input,operationId:'finish-1'});
 assert.equal(result.status,'verified');assert.equal(result.tests[0].exitCode,0);assert.equal(result.acceptance,'not_established');assert.equal(result.independentReview,'pending');
 assert.equal(result.reviewEvidence.length,2);assert.ok(result.reviewEvidence.some(e=>e.file.endsWith('index.mjs')&&e.text.includes('value = 1')));
 const replay=await f.controller.finish_work_packet({...f.input,operationId:'finish-1'});assert.deepEqual(replay.tests,result.tests);
 const started=await fs.readdir(path.join(f.dir,'runs/test/stages'));assert.equal(started.filter(n=>n.endsWith('.started.json')).length,1);
});
test('failed implementation returns focused evidence, not a false pass or another required report',async t=>{
 const f=await fixture(t);await f.controller.prepare_work_packet(f.input);await fs.writeFile(path.join(f.root,'index.mjs'),'export const value = 2;');
 const result=await f.controller.finish_work_packet({...f.input,operationId:'failed'});
 assert.equal(result.status,'needs_repair');assert.equal(result.failures.length,1);assert.match(result.failures[0].text,/EXPECTED value 1/);assert.equal(result.tests[0].exitCode,1);assert.ok(result.failures[0].text.length<=1000);
});
test('Jev failure choice executes bounded registered log retrieval and uncertain choice escalates',async t=>{
 const responder=async(_url,options)=>{
  const q=JSON.parse(options.body),answers={};
  for(const [id,question] of Object.entries(q.questions)){
   if(id==='diagnostic_action')answers[id]={type:'choice',choice:'inspect_assertion',confidence:.95,probabilities:{inspect_assertion:.95,inspect_environment:.02,inspect_timeout:.02,escalate:.01}};
   else if(id==='missing_evidence')answers[id]={type:'noul',noul:.1};
   else throw new Error('Unexpected Jev question '+id);
  }
  return Response.json({model:policy.model,answers,usage:{input_tokens:200,output_tokens:20}});
 };
 const f=await fixture(t,responder);await fs.writeFile(path.join(f.root,'index.mjs'),'export const value = 2;');
 const selected=await f.controller.finish_work_packet({...f.input,mode:'jev',shareWithTypeSafe:true,operationId:'jev-failure'});
 assert.equal(selected.status,'needs_repair');assert.equal(selected.diagnostic.status,'selected');assert.equal(selected.diagnostic.actionId,'inspect_assertion');
 assert.equal(selected.failures.length,0);assert.match(selected.diagnostic.retrieval.evidence[0].excerpts[0].text,/EXPECTED value 1/);
 assert.equal(selected.tests[0].exitCode,1);assert.equal(selected.provider.receipts,1);
 const noProvider=await f.controller.finish_work_packet({...f.input,mode:'jev',shareWithTypeSafe:false,operationId:'fallback'});
 assert.equal(noProvider.diagnostic.status,'escalate');assert.equal(noProvider.failures.length,1);assert.match(noProvider.failures[0].text,/EXPECTED value 1/);
});
test('missing mandatory evidence and modified tests remain hard gates',async t=>{
 const f=await fixture(t);await fs.unlink(path.join(f.root,'index.mjs'));const p=await f.controller.prepare_work_packet(f.input);assert.equal(p.status,'needs_evidence');assert.equal(p.missing[0].id,'source');
 const r=await f.controller.finish_work_packet({...f.input,operationId:'missing'});assert.equal(r.status,'needs_repair');assert.deepEqual(r.protectedChanged,['source']);assert.equal(r.tests.length,0);
 await fs.writeFile(path.join(f.root,'index.mjs'),'export const value = 1;');await fs.writeFile(path.join(f.root,'check.mjs'),'process.exit(0)');
 const changed=await f.controller.finish_work_packet({...f.input,operationId:'changed-tests'});assert.equal(changed.status,'needs_repair');assert.deepEqual(changed.protectedChanged,['test']);
});
test('source changes between internal capture and verification are still rejected',async t=>{
 const f=await fixture(t);const changed=createWorkflowController({...f.workflow,run_workflow_stage:async input=>{await fs.writeFile(path.join(f.root,'index.mjs'),'export const value = 2;');return f.workflow.run_workflow_stage(input);}});
 await assert.rejects(changed.finish_work_packet({...f.input,operationId:'race'}),/stale/);
 await assert.rejects(f.controller.finish_work_packet(f.input),/operation ID/);
});
test('provider status, registered tool plan and completion gate return through the two-call path',async t=>{
 const actions={tool_afterPrepare:'dispatch_builder',tool_afterBuilder:'verify_registered',completion_gate:'complete',review_route:'luna_low'};
 let calls=0;const f=await fixture(t,async(_url,options)=>{
  calls++;const q=JSON.parse(options.body),providerAnswers={};
  for(const [id,v] of Object.entries(q.questions)){
   if(v.type==='score')providerAnswers[id]={type:'score',score:1,confidence:1,probabilities:{0:0,1:1}};
   else if(v.type==='choice'){const choice=actions[id],keys=Object.keys(v.criteria);providerAnswers[id]={type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?1:0]))};}
   else providerAnswers[id]={type:'noul',noul:id.endsWith('_conflict')||id.startsWith('risk_')||/^requirement_\d+_gap$/.test(id)?0:1};
  }
  return Response.json({model:policy.model,answers:providerAnswers,usage:{input_tokens:500,output_tokens:20}});
 });
 const p=await f.controller.prepare_work_packet({...f.input,mode:'jev',shareWithTypeSafe:true});assert.equal(calls,1);assert.equal(p.provider.inputTokens,500);assert.equal(p.provider.receipts,1);assert.equal(p.provider.usageKnown,true);assert.equal(p.toolPlan.afterPrepare.actionId,'dispatch_builder');
 const r=await f.controller.finish_work_packet({...f.input,mode:'jev',shareWithTypeSafe:true,operationId:'verify'});assert.equal(r.status,'verified');assert.equal(r.completionDecision.actionId,'complete');assert.equal(r.reviewRoute.model,'gpt-5.6-luna');assert.equal(r.reviewEvidence.length,2);assert.equal(calls,2);
});
test('compact response reduces measured wire payload on the same task without dropping mandatory text',async t=>{
 const f=await fixture(t);const full=await f.workflow.prepare_work_packet(f.input),before=await f.workflow.get_run_report(f.input),stage=await f.workflow.run_workflow_stage({...f.input,actionId:'verify',operationId:'legacy',expectedSourceHashes:before.currentSourceHashes}),after=await f.workflow.get_run_report(f.input);
 const compact=await f.controller.prepare_work_packet(f.input),finish=await f.controller.finish_work_packet({...f.input,operationId:'managed'});
 for(const e of full.selected.filter(e=>e.mandatory))assert.ok(compact.selected.some(x=>x.id===e.id&&x.text===e.text));
 const legacyTokens=estimateTokens([full,before,stage,after]),managedTokens=estimateTokens([compact,finish]);assert.ok(managedTokens<legacyTokens);
 const out=process.env.JEV_CONTROLLER_MEASUREMENT;if(out)await fs.writeFile(out,JSON.stringify({fixture:'same source and acceptance, no model calls',legacyModelFacingOperations:4,managedModelFacingOperations:2,legacyWireTokens:legacyTokens,managedWireTokens:managedTokens,wireReduction:1-managedTokens/legacyTokens,mandatoryTextPreserved:true,codexSavings:null},null,2));
});
