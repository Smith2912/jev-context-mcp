import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {applyStructuredEdit,nativeRoutePrompt,normalizeNativeLimits,runNativeRoutedWorkflow} from './native-routed-runner.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

test('Jev route sees the registered one-request structured-edit envelope',()=>{
 const prompt=nativeRoutePrompt({contract:'Implement weighted batching.',builderMode:'structured-edit',limits:{builder:{maxRequests:1,maxToolCalls:0,maxRawTokens:70000}}});
 assert.match(prompt,/Implement weighted batching/);
 assert.match(prompt,/one complete structured edit response/);
 assert.match(prompt,/1 model request\(s\), 0 tool call\(s\), 70000 raw Codex tokens/);
});

test('native runner applies Jev routes, deterministic verification and compact review without a coordinator task',async()=>{
 const calls=[],runs=[],states=[];
 const route={advisoryOnly:true,recommendedModel:'gpt-5.6-sol',recommendedEffort:'high',complexityConfidence:.8,selectedSkills:[],usageReceipt:'route',provider:{status:'jev',model:'jev-1.13.0',usage:{input_tokens:1,output_tokens:1}}};
 const packet={status:'prepared',contract:'Implement fixture.',requirements:['Correctness'],selected:[{file:'D:/fixture/source.mjs',start:1,end:1,text:'export const x=0',mandatory:true,builderVisible:true},{file:'D:/fixture/acceptance.mjs',start:1,end:1,text:'SECRET_HELDOUT_CASE',mandatory:true,builderVisible:false,acceptance:true}],requiredRetrieval:[],toolPlan:{afterPrepare:{actionId:'dispatch_builder'},afterBuilder:{actionId:'verify_registered'}},provider:{receipts:1,usageKnown:true},artifact:'packet.json'};
 const finish={status:'verified',verification:'passed',tests:[{id:'acceptance',exitCode:0}],protectedChanged:[],failures:[],completionDecision:{actionId:'dispatch_reviewer'},reviewRoute:{model:'gpt-5.6-luna',effort:'low',confidence:.9},reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'abc',text:'export const x=1'}],completionErrors:[]};
 const request={workflowId:'fixture',runId:'native-1',contract:'Implement a deterministic fixture with exact validation.',workingDirectory:'D:/fixture',assignmentPrefix:'Edit only source.mjs.',shareWithTypeSafe:true,review:{files:['D:/fixture/source.mjs'],criteria:['Correctness'],outputSchema:'schema.json'}};
 const state=await runNativeRoutedWorkflow(request,{callTool:async(name,args)=>{calls.push([name,args]);return name==='route_task'?route:name==='prepare_work_packet'?packet:finish;},checkpoint:async value=>states.push(structuredClone(value)),runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):'implemented',usage:{reconciled:true,rawTokens:job.kind==='builder'?40:20,requests:job.kind==='builder'?2:1}};}});
 assert.equal(state.phase,'complete');assert.equal(state.codexTokens,60);assert.deepEqual(state.acceptance,{testsPassed:true,completionGatePassed:true,independentReviewRequired:true,independentReviewPassed:true});assert.deepEqual(runs.map(r=>[r.kind,r.model,r.effort,r.sandbox]),[['builder','gpt-5.6-sol','high','workspace-write'],['reviewer','gpt-5.6-luna','low','read-only']]);assert.deepEqual(runs.map(r=>r.limits),[{maxRequests:4,maxToolCalls:3,maxRawTokens:250000,timeoutMs:300000},{maxRequests:1,maxToolCalls:0,maxRawTokens:60000,timeoutMs:120000}]);assert.doesNotMatch(runs[0].prompt,/SECRET_HELDOUT_CASE/);assert.match(runs[1].prompt,/export const x=1/);assert.match(runs[1].prompt,/do not request hidden evaluator cases/);assert.equal(calls.filter(c=>c[0]==='route_task').length,1);assert.ok(states.some(s=>s.phase==='builder_running'));
});

test('bounded builder and reviewer packets preserve the complete registered source',async()=>{
 const file='D:/fixture/source.mjs',builderMarker='BUILDER_TAIL_EVIDENCE',reviewMarker='REVIEW_TAIL_EVIDENCE',runs=[];
 const request={workflowId:'fixture',runId:'complete-packets',contract:'Preserve exact source evidence.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-terra',effort:'medium'},builderMode:'packet',review:{files:[file],criteria:['Correctness']}};
 const packet={status:'prepared',contract:request.contract,requirements:['Correctness'],selected:[{file,sha256:'a'.repeat(64),text:'x'.repeat(12000)+builderMarker,mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}};
 const finish={status:'verified',verification:'passed',tests:[{id:'unit',exitCode:0}],reviewEvidence:[{file,sha256:'b'.repeat(64),text:'y'.repeat(12000)+reviewMarker}]};
 await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>name==='prepare_work_packet'?packet:finish,runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):'done',usage:{reconciled:true,rawTokens:1,requests:1},toolCalls:0};}});
 assert.match(runs[0].prompt,new RegExp(builderMarker));assert.match(runs[1].prompt,new RegExp(reviewMarker));
});

test('low-confidence and unavailable Jev use deterministic fallbacks',async()=>{
 const base={workflowId:'fixture',runId:'native-2',contract:'Implement a deterministic fixture with exact validation.',workingDirectory:'D:/fixture',assignmentPrefix:'Edit only source.mjs.',review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};
  for(const unavailable of [false,true]){const jobs=[],packet={status:'prepared',contract:'fixture',requirements:[],selected:[{file:'D:/fixture/source.mjs',text:'x',mandatory:true,builderVisible:true}],requiredRetrieval:[],toolPlan:unavailable?null:{afterPrepare:{actionId:'dispatch_builder'},afterBuilder:{actionId:'verify_registered'}},provider:{receipts:unavailable?0:1,usageKnown:true}},finish={status:'verified',verification:'passed',tests:[],completionDecision:unavailable?null:{actionId:'dispatch_reviewer'},reviewRoute:{model:'gpt-5.6-luna',effort:'low'},reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'a',text:'x'}],completionErrors:[]};await runNativeRoutedWorkflow({...base,runId:base.runId+unavailable},{checkpoint:async()=>{},callTool:async name=>{if(name==='route_task'){if(unavailable)throw Error('offline');return {advisoryOnly:true,recommendedModel:'gpt-5.6-sol',recommendedEffort:'high',complexityConfidence:.2,selectedSkills:[],provider:{status:'jev'}};}return name==='prepare_work_packet'?packet:finish;},runCodex:async job=>{jobs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):'done',usage:{reconciled:true,rawTokens:1,requests:1}};}});assert.equal(jobs[0].useDefaultModel,unavailable);if(!unavailable){assert.equal(jobs[0].model,'gpt-5.6-terra');assert.equal(jobs[0].effort,'medium');}}
});

test('native runner rejects invalid limits, records completed usage and stops before verification on request overrun',async()=>{
 assert.throws(()=>normalizeNativeLimits({builder:{maxRequests:0}}),/Invalid builder/);
 const request={workflowId:'fixture',runId:'overrun',contract:'Implement fixture.',workingDirectory:'D:/fixture',review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']},limits:{builder:{maxRequests:2,maxToolCalls:2,timeoutMs:1000},reviewer:{maxRequests:1,maxToolCalls:0,timeoutMs:1000}}};
 const route={advisoryOnly:true,recommendedModel:'gpt-5.6-terra',recommendedEffort:'medium',complexityConfidence:.9,selectedSkills:[],provider:{status:'jev'}};
 const packet={status:'prepared',contract:'fixture',requirements:[],selected:[{file:'D:/fixture/source.mjs',text:'x',mandatory:true,builderVisible:true}],requiredRetrieval:[],toolPlan:{afterPrepare:{actionId:'dispatch_builder'},afterBuilder:{actionId:'verify_registered'}},provider:{receipts:1,usageKnown:true}};
 let verified=false;const states=[];
 await assert.rejects(runNativeRoutedWorkflow(request,{checkpoint:async value=>states.push(structuredClone(value)),callTool:async name=>{if(name==='route_task')return route;if(name==='prepare_work_packet')return packet;verified=true;throw Error('verification should not run');},runCodex:async job=>{await job.onStarted('builder');return {threadId:'builder',finalMessage:'done',usage:{reconciled:true,rawTokens:10,requests:3},toolCalls:2};}}),/request limit/);
 assert.equal(verified,false);assert.ok(states.some(state=>state.builder?.usage?.rawTokens===10&&state.builder.phase==='completed_pending_validation'));
 await assert.rejects(runNativeRoutedWorkflow({...request,runId:'token-overrun',limits:{...request.limits,builder:{...request.limits.builder,maxRequests:3,maxRawTokens:9000}}},{checkpoint:async()=>{},callTool:async name=>name==='route_task'?route:packet,runCodex:async job=>{await job.onStarted('builder');return {threadId:'builder',finalMessage:'done',usage:{reconciled:true,rawTokens:10000,requests:1},toolCalls:0};}}),/raw-token limit/);
});

test('fixed-route arms skip Jev routing and ordinary builders receive no prepared evidence',async()=>{
 const calls=[],runs=[];
 const request={workflowId:'fixture',runId:'fixed-ordinary',contract:'Implement fixture.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-sol',effort:'high'},builderMode:'ordinary',review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};
 const packet={status:'prepared',contract:'fixture',requirements:['secret requirement'],selected:[{file:'D:/fixture/source.mjs',text:'SECRET_PREPARED_SOURCE',mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}};
 const finish={status:'verified',verification:'passed',tests:[],reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'a',text:'export const x=1'}],completionErrors:[]};
 const state=await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>{calls.push(name);return name==='prepare_work_packet'?packet:finish;},runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):'done',usage:{reconciled:true,rawTokens:1,requests:1},toolCalls:0};}});
 assert.equal(state.phase,'complete');assert.equal(state.routingMode,'fixed');assert.equal(state.builderMode,'ordinary');assert.equal(calls.includes('route_task'),false);assert.deepEqual(runs.map(r=>[r.model,r.effort]),[['gpt-5.6-sol','high'],['gpt-5.6-sol','high']]);assert.match(runs[0].prompt,/Inspect the registered project source directly/);assert.doesNotMatch(runs[0].prompt,/SECRET_PREPARED_SOURCE|secret requirement/);
});

test('fixed packet arm receives prepared evidence without Jev decisions',async()=>{
 const calls=[],runs=[];
 const request={workflowId:'fixture',runId:'fixed-packet',contract:'Implement fixture.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-sol',effort:'high'},builderMode:'packet',review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};
 const packet={status:'prepared',contract:'fixture',requirements:['required'],selected:[{file:'D:/fixture/source.mjs',text:'PREPARED_SOURCE',mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}};
 const finish={status:'verified',verification:'passed',tests:[],reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'a',text:'export const x=1'}],completionErrors:[]};
 await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>{calls.push(name);return name==='prepare_work_packet'?packet:finish;},runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):'done',usage:{reconciled:true,rawTokens:1,requests:1},toolCalls:0};}});
 assert.equal(calls.includes('route_task'),false);assert.match(runs[0].prompt,/PREPARED_SOURCE|required/);
});

test('pilot can require a separate reviewer after a Jev complete decision',async()=>{
 const runs=[],request={workflowId:'fixture',runId:'review-required',contract:'Implement fixture.',workingDirectory:'D:/fixture',requireReviewer:true,review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};
 const route={advisoryOnly:true,recommendedModel:'gpt-5.6-terra',recommendedEffort:'medium',complexityConfidence:.9,selectedSkills:[],provider:{status:'jev'}};
 const packet={status:'prepared',contract:'fixture',requirements:[],selected:[{file:'D:/fixture/source.mjs',text:'x',mandatory:true,builderVisible:true}],requiredRetrieval:[],toolPlan:{afterPrepare:{actionId:'dispatch_builder'},afterBuilder:{actionId:'verify_registered'}},provider:{receipts:1,usageKnown:true}};
 const finish={status:'verified',verification:'passed',tests:[],completionDecision:{actionId:'complete'},reviewRoute:{model:'gpt-5.6-luna',effort:'low'},reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'a',text:'export const x=1'}],completionErrors:[]};
 await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>name==='route_task'?route:name==='prepare_work_packet'?packet:finish,runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):'done',usage:{reconciled:true,rawTokens:1,requests:1},toolCalls:0};}});
 assert.deepEqual(runs.map(r=>r.kind),['builder','reviewer']);
});

test('tool-heavy and visual profiles always receive bounded independent review',async()=>{
 for(const executionProfile of ['tool_heavy','visual_spatial']){
  const runs=[],request={workflowId:'fixture',runId:`review-${executionProfile}`,contract:'Implement substantial fixture.',workingDirectory:'D:/fixture',supportedExecutionProfiles:[executionProfile],review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};
  const route={advisoryOnly:true,recommendedModel:'gpt-5.6-sol',recommendedEffort:'high',complexityConfidence:.9,executionProfile,executionProfileConfidence:.9,selectedSkills:[],provider:{status:'jev'}};
  const packet={status:'prepared',contract:'fixture',requirements:[],selected:[{file:'D:/fixture/source.mjs',text:'x',mandatory:true,builderVisible:true}],requiredRetrieval:[],toolPlan:{afterPrepare:{actionId:'dispatch_builder'},afterBuilder:{actionId:'verify_registered'}},provider:{receipts:1,usageKnown:true}};
  const finish={status:'verified',verification:'passed',tests:[],completionDecision:{actionId:'complete',atomicRiskFlags:[]},reviewRoute:{model:'gpt-5.6-luna',effort:'low'},reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'a',text:'export const x=1'}],completionErrors:[]};
  const state=await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>name==='route_task'?route:name==='prepare_work_packet'?packet:finish,runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):'done',usage:{reconciled:true,rawTokens:1,requests:1},toolCalls:0};}});
  assert.deepEqual(runs.map(run=>run.kind),['builder','reviewer']);assert.equal(state.acceptance.independentReviewPassed,true);
 }
});

test('small high-confidence completion is recorded as unreviewed, never as review passed',async()=>{
 const runs=[],request={workflowId:'fixture',runId:'small-complete',contract:'Make a small edit.',workingDirectory:'D:/fixture',supportedExecutionProfiles:['small_edit'],review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};
 const route={advisoryOnly:true,recommendedModel:'gpt-5.6-luna',recommendedEffort:'low',complexityConfidence:.9,executionProfile:'small_edit',executionProfileConfidence:.9,selectedSkills:[],provider:{status:'jev'}};
 const packet={status:'prepared',contract:'fixture',requirements:[],selected:[{file:'D:/fixture/source.mjs',text:'x',mandatory:true,builderVisible:true}],requiredRetrieval:[],toolPlan:{afterPrepare:{actionId:'dispatch_builder'},afterBuilder:{actionId:'verify_registered'}},provider:{receipts:1,usageKnown:true}};
 const finish={status:'verified',verification:'passed',tests:[],completionDecision:{actionId:'complete',atomicRiskFlags:[]},reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'a',text:'export const x=1'}],completionErrors:[]};
 const state=await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>name==='route_task'?route:name==='prepare_work_packet'?packet:finish,runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:'done',usage:{reconciled:true,rawTokens:1,requests:1},toolCalls:0};}});
 assert.deepEqual(runs.map(run=>run.kind),['builder']);assert.equal(state.review.performed,false);assert.equal(state.review.qualityAcceptable,null);assert.equal(state.acceptance.independentReviewPassed,null);assert.equal('reviewPassed' in state.acceptance,false);
});

test('a reconciled completed builder resumes without another builder dispatch',async()=>{
 const runs=[],request={workflowId:'fixture',runId:'resume',contract:'Implement fixture.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-terra',effort:'medium'},builderMode:'ordinary',review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']},limits:{builder:{maxRequests:5,maxToolCalls:5,timeoutMs:1000},reviewer:{maxRequests:1,maxToolCalls:0,timeoutMs:1000}}};
 const packet={status:'prepared',contract:'fixture',requirements:[],selected:[{file:'D:/fixture/source.mjs',text:'x',mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}};
 const finish={status:'verified',verification:'passed',tests:[],reviewEvidence:[{file:'D:/fixture/source.mjs',sha256:'a',text:'export const x=1'}]};
 const completedBuilder={threadId:'existing-builder',finalMessage:'done',usage:{reconciled:true,rawTokens:50,requests:5},toolCalls:4,resumed:true};
 const state=await runNativeRoutedWorkflow(request,{completedBuilder,checkpoint:async()=>{},callTool:async name=>name==='prepare_work_packet'?packet:finish,runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}),usage:{reconciled:true,rawTokens:10,requests:1},toolCalls:0};}});
 assert.deepEqual(runs.map(r=>r.kind),['reviewer']);assert.equal(state.builder.threadId,'existing-builder');assert.equal(state.builder.resumed,true);assert.equal(state.codexTokens,60);
});

test('structured edit uses one tool-free read-only request, applies a registered edit, then verifies',async()=>{
 const calls=[],runs=[],applied=[],source='export const x=0;\n',sourceHash=sha(source),file='D:/fixture/source.mjs';
 const request={workflowId:'fixture',runId:'structured',contract:'Set x to one.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-terra',effort:'medium'},builderMode:'structured-edit',builder:{outputSchema:'D:/schema.json',images:[]},structuredEdit:{allowedFiles:[file]},review:{files:[file],criteria:['Correctness'],images:[]},limits:{builder:{maxRequests:1,maxToolCalls:0,timeoutMs:1000},reviewer:{maxRequests:1,maxToolCalls:0,timeoutMs:1000}}};
 const packet={status:'prepared',contract:'Set x to one.',requirements:['Correctness'],selected:[{file,sha256:sourceHash,text:source,mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}};
 const finish={status:'verified',verification:'passed',tests:[{id:'unit',exitCode:0}],reviewEvidence:[{file,sha256:'after',text:'export const x=1;'}]};
 const edit=JSON.stringify({edits:[{file,expectedSha256:sourceHash,content:'export const x=1;\n'}],summary:'Set x to one'});
 const state=await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>{calls.push(name);return name==='prepare_work_packet'?packet:finish;},applyStructuredEdit:async input=>{applied.push(input);return {file,beforeSha256:sourceHash,afterSha256:'after',bytes:18,summary:'Set x to one'};},runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:job.kind==='builder'?edit:JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}),usage:{reconciled:true,rawTokens:job.kind==='builder'?20:10,requests:1},toolCalls:0};}});
 assert.equal(state.phase,'complete');assert.equal(state.codexTokens,30);assert.equal(applied.length,1);assert.equal(applied[0].evidence[0].sha256,sourceHash);assert.deepEqual(runs.map(job=>[job.kind,job.sandbox,job.outputSchema,job.limits.maxRequests,job.limits.maxToolCalls]),[['builder','read-only','D:/schema.json',1,0],['reviewer','read-only',undefined,1,0]]);assert.deepEqual(runs[0].images,[]);assert.deepEqual(runs[1].images,[]);assert.equal(state.builder.finalMessage,undefined);assert.equal(state.builder.structuredEdit.afterSha256,'after');assert.deepEqual(calls,['prepare_work_packet','run_workflow_stage']);
});

test('Jev execution profiles cannot exceed the registered workflow envelope',async()=>{
 const request={workflowId:'fixture',runId:'profile-gate',contract:'Diagnose a broad migration.',workingDirectory:'D:/fixture',supportedExecutionProfiles:['small_edit','bounded_project'],review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};let prepared=false;
 const route={advisoryOnly:true,recommendedModel:'gpt-5.6-sol',recommendedEffort:'high',complexityConfidence:.9,executionProfile:'tool_heavy',executionProfileConfidence:.9,selectedSkills:[],provider:{status:'jev'}};
 await assert.rejects(runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>{if(name==='route_task')return route;prepared=true;return {};},runCodex:async()=>{throw Error('must not dispatch');}}),/outside the registered workflow envelope/);assert.equal(prepared,false);
 await assert.rejects(runNativeRoutedWorkflow({...request,runId:'image-escape',builder:{images:['C:/outside.png']}},{checkpoint:async()=>{},callTool:async()=>{},runCodex:async()=>{}}),/image escapes/);
});

test('structured edit atomically replaces only the registered unchanged source',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'jev-structured-edit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'source.mjs'),other=path.join(root,'other.mjs'),source='export const x=0;\n';await fs.writeFile(file,source);await fs.writeFile(other,'x');const sourceHash=sha(source);
 const evidence=[{file,sha256:sourceHash,mandatory:true,builderVisible:true}],valid=JSON.stringify({edits:[{file,expectedSha256:sourceHash,content:'export const x=1;\n'}],summary:'change'});
 const receipt=await applyStructuredEdit({text:valid,evidence,workingDirectory:root,allowedFiles:[file]});assert.equal(await fs.readFile(file,'utf8'),'export const x=1;\n');assert.equal(receipt.beforeSha256,sourceHash);assert.equal(receipt.afterSha256,sha('export const x=1;\n'));
 await fs.writeFile(file,source);
 await assert.rejects(applyStructuredEdit({text:JSON.stringify({edits:[{file:other,expectedSha256:sourceHash,content:'changed'}],summary:'bad'}),evidence,workingDirectory:root,allowedFiles:[file]}),/every registered file|unregistered or stale/);
 await fs.writeFile(file,'externally changed');
 await assert.rejects(applyStructuredEdit({text:valid,evidence,workingDirectory:root,allowedFiles:[file]}),/source changed before/);
 await assert.rejects(applyStructuredEdit({text:'not json',evidence,workingDirectory:root,allowedFiles:[file]}),/valid JSON/);
});

test('structured edit applies a bounded multi-file transaction and rejects partial output before mutation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'jev-structured-multi-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const one=path.join(root,'one.mjs'),two=path.join(root,'two.mjs'),beforeOne='export const one=1;\n',beforeTwo='export const two=2;\n';await fs.writeFile(one,beforeOne);await fs.writeFile(two,beforeTwo);
 const evidence=[{file:one,sha256:sha(beforeOne),mandatory:true,builderVisible:true},{file:two,sha256:sha(beforeTwo),mandatory:true,builderVisible:true}],allowedFiles=[one,two];
 const partial=JSON.stringify({edits:[{file:one,expectedSha256:sha(beforeOne),content:'export const one=10;\n'}],summary:'partial'});
 await assert.rejects(applyStructuredEdit({text:partial,evidence,workingDirectory:root,allowedFiles}),/every registered file/);assert.equal(await fs.readFile(one,'utf8'),beforeOne);assert.equal(await fs.readFile(two,'utf8'),beforeTwo);
 const complete=JSON.stringify({edits:[{file:two,expectedSha256:sha(beforeTwo),content:'export const two=20;\n'},{file:one,expectedSha256:sha(beforeOne),content:'export const one=10;\n'}],summary:'both'});
 const receipt=await applyStructuredEdit({text:complete,evidence,workingDirectory:root,allowedFiles});assert.equal(receipt.files.length,2);assert.equal(receipt.totalBytes,Buffer.byteLength('export const one=10;\n')+Buffer.byteLength('export const two=20;\n'));assert.equal(await fs.readFile(one,'utf8'),'export const one=10;\n');assert.equal(await fs.readFile(two,'utf8'),'export const two=20;\n');
 await fs.writeFile(one,beforeOne);await fs.writeFile(two,beforeTwo);
 const oneChanged=JSON.stringify({edits:[{file:one,expectedSha256:sha(beforeOne),content:beforeOne},{file:two,expectedSha256:sha(beforeTwo),content:'export const two=200;\n'}],summary:'second only'});
 const repairReceipt=await applyStructuredEdit({text:oneChanged,evidence,workingDirectory:root,allowedFiles});assert.equal(repairReceipt.files.length,1);assert.equal(repairReceipt.files[0].file,await fs.realpath(two));assert.equal(await fs.readFile(one,'utf8'),beforeOne);assert.equal(await fs.readFile(two,'utf8'),'export const two=200;\n');
 await fs.writeFile(two,beforeTwo);const unchanged=JSON.stringify({edits:[{file:one,expectedSha256:sha(beforeOne),content:beforeOne},{file:two,expectedSha256:sha(beforeTwo),content:beforeTwo}],summary:'none'});await assert.rejects(applyStructuredEdit({text:unchanged,evidence,workingDirectory:root,allowedFiles}),/no source change/);
});

test('structured edit rejects relaxed limits, missing schema and resumed builders',async()=>{
 const base={workflowId:'fixture',runId:'invalid-structured',contract:'Edit.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-terra',effort:'medium'},builderMode:'structured-edit',builder:{outputSchema:'D:/schema.json'},structuredEdit:{allowedFiles:['D:/fixture/source.mjs']},review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']},limits:{builder:{maxRequests:2,maxToolCalls:0,timeoutMs:1000},reviewer:{maxRequests:1,maxToolCalls:0,timeoutMs:1000}}};
 const deps={checkpoint:async()=>{},callTool:async()=>{},runCodex:async()=>{throw Error('must not run');}};
 await assert.rejects(runNativeRoutedWorkflow(base,deps),/one request, zero tools/);
 await assert.rejects(runNativeRoutedWorkflow({...base,limits:{...base.limits,builder:{...base.limits.builder,maxRequests:1}},builder:{}},deps),/output schema/);
 await assert.rejects(runNativeRoutedWorkflow({...base,limits:{...base.limits,builder:{...base.limits.builder,maxRequests:1}}},{...deps,completedBuilder:{}}),/one request, zero tools/);
});

test('failed verification dispatches one focused structured repair and counts it',async()=>{
 const file='D:/fixture/source.mjs',firstHash=sha('export const x=0;\n'),secondHash=sha('export const x=1;\n'),runs=[],applied=[],calls=[];
 const request={workflowId:'fixture',runId:'repair-once',contract:'Set x to two.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-terra',effort:'medium'},builderMode:'structured-edit',builder:{outputSchema:'D:/schema.json'},structuredEdit:{allowedFiles:[file]},review:{files:[file],criteria:['Correctness']},limits:{builder:{maxRequests:1,maxToolCalls:0,timeoutMs:1000},repair:{maxRequests:1,maxToolCalls:0,timeoutMs:1000},reviewer:{maxRequests:1,maxToolCalls:0,timeoutMs:1000}}};
 const packets=[{status:'prepared',contract:request.contract,requirements:['Correctness'],selected:[{file,sha256:firstHash,text:'export const x=0;\n',mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}},{status:'prepared',contract:request.contract,requirements:['Correctness'],selected:[{file,sha256:secondHash,text:'export const x=1;\n',mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}}];
 const failed={status:'needs_repair',verification:'failed',tests:[{id:'unit',exitCode:1}],protectedChanged:[],failures:[{id:'unit',text:'expected 2 actual 1'}]},passed={status:'verified',verification:'passed',tests:[{id:'unit',exitCode:0}],reviewEvidence:[{file,sha256:'final',text:'export const x=2;'}]};let prepares=0,finishes=0;
 const state=await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>{calls.push(name);if(name==='prepare_work_packet')return packets[prepares++];return finishes++===0?failed:passed;},applyStructuredEdit:async input=>{applied.push(input);return {file,beforeSha256:applied.length===1?firstHash:secondHash,afterSha256:applied.length===1?secondHash:'final',files:[],totalBytes:18,summary:'changed'};},runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);const finalMessage=job.kind==='reviewer'?JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'pass'}):JSON.stringify({edits:[{file,expectedSha256:job.kind==='builder'?firstHash:secondHash,content:job.kind==='builder'?'export const x=1;\n':'export const x=2;\n'}],summary:job.kind});return {threadId:job.kind,finalMessage,usage:{reconciled:true,rawTokens:job.kind==='builder'?20:job.kind==='repair'?15:10,requests:1},toolCalls:0};}});
 assert.deepEqual(runs.map(job=>job.kind),['builder','repair','reviewer']);assert.equal(applied.length,2);assert.match(runs[1].prompt,/expected 2 actual 1/);assert.equal(state.codexTokens,45);assert.deepEqual(calls,['prepare_work_packet','run_workflow_stage','prepare_work_packet','run_workflow_stage']);
});

test('protected verification changes never dispatch a repair',async()=>{
 const runs=[],request={workflowId:'fixture',runId:'protected',contract:'Fix.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-terra',effort:'medium'},review:{files:['D:/fixture/source.mjs'],criteria:['Correctness']}};
 const packet={status:'prepared',contract:'Fix.',requirements:[],selected:[{file:'D:/fixture/source.mjs',text:'x',mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}},failed={status:'needs_repair',verification:'failed',tests:[],protectedChanged:['acceptance'],failures:[]};
 await assert.rejects(runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>name==='prepare_work_packet'?packet:failed,runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);return {threadId:job.kind,finalMessage:'done',usage:{reconciled:true,rawTokens:1,requests:1},toolCalls:0};}}),/verification failed/);assert.deepEqual(runs.map(job=>job.kind),['builder']);
});

test('a substantive review defect triggers one repair, reverification and fresh reviewer',async()=>{
 const file='D:/fixture/source.mjs',runs=[],calls=[],request={workflowId:'fixture',runId:'review-repair',contract:'Return two.',workingDirectory:'D:/fixture',routingMode:'fixed',fixedRoute:{model:'gpt-5.6-terra',effort:'medium'},builderMode:'ordinary',maxRepairs:1,review:{files:[file],criteria:['Correctness']},limits:{builder:{maxRequests:1,maxToolCalls:0,timeoutMs:1000},repair:{maxRequests:1,maxToolCalls:0,timeoutMs:1000},reviewer:{maxRequests:1,maxToolCalls:0,timeoutMs:1000}}};
 const packet={status:'prepared',contract:request.contract,requirements:['Correctness'],selected:[{file,sha256:'a'.repeat(64),text:'export const x=1;',mandatory:true,builderVisible:true}],requiredRetrieval:[],provider:{receipts:0,usageKnown:true}},finish={status:'verified',verification:'passed',tests:[{id:'unit',exitCode:0}],reviewEvidence:[{file,sha256:'a',text:'export const x=1;'}]};let reviews=0;
 const state=await runNativeRoutedWorkflow(request,{checkpoint:async()=>{},callTool:async name=>{calls.push(name);return name==='prepare_work_packet'?packet:finish;},runCodex:async job=>{runs.push(job);await job.onStarted(job.kind);let finalMessage='done';if(job.kind==='reviewer')finalMessage=JSON.stringify({quality:'unacceptable',seriousDefects:['x must be two'],missingEvidence:[],summary:'bad'});if(job.kind==='reviewer2'){reviews++;finalMessage=JSON.stringify({quality:'acceptable',seriousDefects:[],missingEvidence:[],summary:'fixed'});}return {threadId:job.kind,finalMessage,usage:{reconciled:true,rawTokens:job.kind==='builder'?10:job.kind==='repair'?7:5,requests:1},toolCalls:0};}});
 assert.deepEqual(runs.map(job=>job.kind),['builder','reviewer','repair','reviewer2']);assert.match(runs[2].prompt,/x must be two/);assert.equal(reviews,1);assert.equal(state.codexTokens,27);assert.equal(state.reviewFailure.qualityAcceptable,false);assert.equal(state.review.qualityAcceptable,true);assert.deepEqual(calls,['prepare_work_packet','run_workflow_stage','prepare_work_packet','run_workflow_stage']);
});
