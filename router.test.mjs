import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {routeTask} from './router.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'jev-router-')),catalog=path.join(root,'skills.json');
await fs.writeFile(catalog,JSON.stringify({skills:[{name:'dayz-create-mod',description:'DayZ mod work',path:'C:/fixture/SKILL.md'},{name:'pdf',description:'PDF rendering',path:'C:/pdf/SKILL.md'}]}));
test.after(()=>fs.rm(root,{recursive:true,force:true}));
test('router skips short, credential-bearing and unauthorized prompts without inference',async()=>{
 const opts={skillCatalog:catalog,apiKey:'fixture',fetcher(){throw Error('Must not call');}};
 for(const prompt of ['proceed','Inspect the project configuration and print this password=secretvalue then explain all the settings.'])assert.match((await routeTask({prompt,shareWithTypeSafe:true},opts)).provider.status,/skipped/);
 assert.match((await routeTask({prompt:'Inspect the project configuration and explain all available model routing settings in detail.'},opts)).provider.status,/unavailable/);
});
test('router preserves explicit skills, caches results, and does not switch models',async()=>{
 let calls=0;const opts={skillCatalog:catalog,apiKey:'fixture',fetcher:async(url,{body})=>{calls++;const p=JSON.parse(body);return Response.json({model:p.model,answers:Object.fromEntries(Object.keys(p.questions).map(k=>[k,{type:'score',score:k==='complexity'?3.2:0,confidence:.9}])),usage:{input_tokens:55,output_tokens:20}});}};
 const args={prompt:'Use $dayz-create-mod to investigate an ambiguous multiplayer persistence failure in my DayZ server.',shareWithTypeSafe:true};
 const r=await routeTask(args,opts);assert.equal(r.recommendedModel,'gpt-5.6-sol');assert.equal(r.executionProfile,'small_edit');assert.equal(r.selectedSkills[0].name,'dayz-create-mod');assert.equal(r.advisoryOnly,true);assert.ok(r.hookSpecificOutput.additionalContext.length<=800);assert.match(r.hookSpecificOutput.additionalContext,/no model has been switched/);
 const second=await routeTask(args,opts);assert.equal(second.provider.status,'jev-cache');assert.equal(calls,1);
});
test('router can select Luna and safely redacts a Windows user path',async()=>{
 let task;const opts={skillCatalog:catalog,apiKey:'fixture',fetcher:async(url,{body})=>{const p=JSON.parse(body);task=p.state.task;return Response.json({model:p.model,answers:Object.fromEntries(Object.keys(p.questions).map(k=>[k,{type:'score',score:0,confidence:.9}]))});}};
 const r=await routeTask({prompt:'Rename the focused helper referenced at C:\\Users\\sampleuser\\Documents\\Project\\helper.js and run its exact test.',shareWithTypeSafe:true},opts);
 assert.equal(r.recommendedModel,'gpt-5.6-luna');assert.equal(r.recommendedEffort,'low');assert.match(task,/C:\\Users\\\[USER\]\\Documents/);assert.doesNotMatch(task,/sampleuser/);
});
test('router can select the visual spatial execution profile in the same call',async()=>{
 const opts={skillCatalog:catalog,apiKey:'fixture',fetcher:async(url,{body})=>{const p=JSON.parse(body);return Response.json({model:p.model,answers:Object.fromEntries(Object.keys(p.questions).map(k=>[k,{type:'score',score:k==='complexity'?5:k==='executionShape'?3:0,confidence:.9}]))});}};
 const r=await routeTask({prompt:'Build and visually inspect a reference-matched 3D vehicle in Blender and verify spatial clearance in Unity.',shareWithTypeSafe:true},opts);assert.equal(r.recommendedModel,'gpt-6-astra');assert.equal(r.executionProfile,'visual_spatial');assert.equal(r.executionProfileConfidence,.9);
});
test('invalid provider route fails open and never manufactures a selection',async()=>{
 const r=await routeTask({prompt:'Investigate the full source repository for a difficult data corruption issue with competing writes.',shareWithTypeSafe:true},{skillCatalog:catalog,apiKey:'fixture',fetcher:async()=>Response.json({answers:{complexity:{type:'score',score:100}}})});assert.equal(r.continue,true);assert.ok(!r.recommendedModel);assert.match(r.provider.status,/unavailable/);
});
test('router exposes and selects every installed model tier',async()=>{
 const expected=['gpt-5.6-luna','gpt-6-luna','gpt-5.6-terra','gpt-5.6-sol','gpt-6-sol','gpt-6-astra'];
 for(let index=0;index<expected.length;index++){
  const fetcher=async(url,{body})=>{const p=JSON.parse(body);assert.equal(p.questions.complexity.criteria.length,expected.length);assert.match(p.questions.complexity.criteria[index],new RegExp(expected[index].replaceAll('.','\\.')));return Response.json({model:p.model,answers:Object.fromEntries(Object.keys(p.questions).map(k=>[k,{type:'score',score:k==='complexity'?index:0,confidence:.9}]))});};
  fetcher.managesBudget=true;
  const opts={skillCatalog:catalog,apiKey:'fixture',fetcher};
  const result=await routeTask({prompt:`Implement a bounded project task with fixture model choice ${index} and verify the result.`,shareWithTypeSafe:true},opts);
  assert.equal(result.recommendedModel,expected[index]);
 }
});
