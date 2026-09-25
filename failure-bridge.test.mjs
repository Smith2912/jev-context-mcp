import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {boundedFailureState,diagnosticQuestions,deriveDiagnosticDecision,retrieveDiagnosticEvidence} from './failure-bridge.mjs';

const policy=JSON.parse(await fs.readFile(new URL('./decision-policy.json',import.meta.url),'utf8'));
const answer=(choice='inspect_assertion',confidence=.95,missing=.1)=>({status:'complete',answers:{
  diagnostic_action:{type:'choice',choice,confidence,probabilities:{inspect_assertion:choice==='inspect_assertion'?confidence:.01,inspect_environment:choice==='inspect_environment'?confidence:.01,inspect_timeout:choice==='inspect_timeout'?confidence:.01,escalate:choice==='escalate'?confidence:.01}},
  missing_evidence:{type:'noul',noul:missing}}});

test('registered diagnostic decision has a confidence and evidence gate',()=>{
  assert.deepEqual(Object.keys(diagnosticQuestions(policy)),['diagnostic_action','missing_evidence']);
  assert.equal(deriveDiagnosticDecision(answer(),policy).actionId,'inspect_assertion');
  assert.equal(deriveDiagnosticDecision(answer('inspect_assertion',.6),policy).reason,'low_confidence');
  assert.equal(deriveDiagnosticDecision(answer('inspect_assertion',.95,.8),policy).reason,'missing_evidence');
  assert.equal(deriveDiagnosticDecision(answer('escalate',.95),policy).status,'escalate');
  assert.equal(deriveDiagnosticDecision({status:'needs_review',answers:{}},policy).status,'escalate');
  assert.equal(deriveDiagnosticDecision(answer('arbitrary_path',.95),policy).reason,'unregistered_action');
});

test('failure state is bounded and selected evidence retains exact log references',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-failure-bridge-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const logfile=path.join(dir,'test.log');await fs.writeFile(logfile,'noise\n'.repeat(12000)+'AssertionError: EXPECTED value 1, ACTUAL value 2\n    at check.mjs:1:22\n');
  const results=[{id:'unit',exitCode:1,timedOut:false,interrupted:false,logfile}];
  const state=await boundedFailureState(results);assert.ok(JSON.stringify(state).length<7000);assert.match(state.output[0].text,/EXPECTED value 1/);
  const found=await retrieveDiagnosticEvidence(results,'inspect_assertion');assert.equal(found.status,'found');
  assert.match(found.evidence[0].tailSha256,/^[a-f0-9]{64}$/);assert.match(found.evidence[0].excerpts[0].text,/EXPECTED value 1/);
  assert.ok(found.evidence[0].tailStartByte>0);assert.equal((await retrieveDiagnosticEvidence(results,'inspect_environment')).status,'missing');
  await assert.rejects(retrieveDiagnosticEvidence(results,'run_shell'),/Unsupported registered/);
});
