import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createComputerUseHelper} from './computer-use-helper.mjs';

const policy = JSON.parse(await fs.readFile(new URL('./decision-policy.json',import.meta.url),'utf8'));
const input = {runId:'ui1',task:'Open the project settings panel',surface:'browser',
  observation:'Settings button is visible in the navigation.',
  actions:[{id:'open_settings',description:'Select the visible Settings button',risk:'routine'},
    {id:'publish',description:'Publish the project',risk:'consequential'}],
  shareWithTypeSafe:true,contentClass:'routine'};
async function setup(t, reply) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'jev-computer-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let calls=0;
  const helper=createComputerUseHelper({settings:{workflow:{artifactDirectory:dir,limiterDirectory:path.join(dir,'limiter'),batchSchedulerEnabled:true}},policy,apiKey:'fixture',
    fetcher:async(_url,opts)=>{calls++;const request=JSON.parse(opts.body);return Response.json(reply(request));}});
  return {helper,dir,calls:()=>calls};
}
const answer=(request,{choice='open_settings',confidence=.95,missing=.1,multimodal=.1}={})=>({
  model:request.model,answers:{
    next_action:{type:'choice',choice,confidence,probabilities:Object.fromEntries(Object.keys(request.questions.next_action.criteria).map(id=>[id,id===choice?.95:.05]))},
    missing_evidence:{type:'noul',noul:missing},needs_multimodal:{type:'noul',noul:multimodal}},
  usage:{input_tokens:120,output_tokens:8}});

test('routine choice is bounded, cached, hashed and receipted without UI execution',async t=>{
  const {helper,dir,calls}=await setup(t,request=>answer(request));
  const first=await helper(input);assert.equal(first.status,'suggested');assert.equal(first.actionId,'open_settings');
  assert.equal(first.provider.receipts[0].usage.input_tokens,120);
  const second=await helper(input);assert.equal(second.status,'suggested');assert.equal(calls(),1);
  assert.equal(second.provider.receipts[0].status,'cache');
  assert.notEqual((await helper({...input,observation:'Settings button disappeared.'})).observationHash,first.observationHash);
  assert.equal(calls(),2);
  assert.equal((await fs.readdir(path.join(dir,'computer-use-helper','receipts'))).length,3);
});
test('missing evidence, visual judgment and low confidence require Codex',async t=>{
  for(const override of [{missing:.8},{multimodal:.8},{confidence:.6},{choice:'escalate'}]){
    const {helper}=await setup(t,request=>answer(request,override));
    const result=await helper(input);assert.equal(result.status,'escalate');assert.equal(result.actionId,null);
  }
});
test('private, sensitive and multimodal input never reaches provider',async t=>{
  const {helper,calls}=await setup(t,request=>answer(request));
  for(const changed of [{contentClass:'private'},{shareWithTypeSafe:false},{observation:'password=foo'},
    {actions:[{id:'open_settings',description:'token=foo',risk:'routine'}]},{requiresMultimodal:true}]){
    assert.equal((await helper({...input,...changed})).status,'escalate');
  }
  assert.equal(calls(),0);
});
test('provider character limit is checked before a paid call',async t=>{
  const {helper,calls}=await setup(t,request=>answer(request));
  const result=await helper({...input,observation:'A'.repeat(5900)});
  assert.equal(result.status,'escalate');assert.equal(result.reason,'context_too_large');assert.equal(calls(),0);
});
test('provider failure and unregistered action cannot produce a suggestion',async t=>{
  const {helper}=await setup(t,request=>({...answer(request),answers:{...answer(request).answers,next_action:{type:'choice',choice:'delete_all',confidence:1,probabilities:{delete_all:1}}}}));
  assert.equal((await helper(input)).status,'escalate');
  await assert.rejects(helper({...input,actions:[...input.actions,{id:'open_settings',description:'Duplicate',risk:'routine'}]}),/Invalid bounded/);
});
