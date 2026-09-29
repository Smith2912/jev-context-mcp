import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {nativeWorkerEnvironment,nativeSessionRoot,requireObservedSpendOptIn,validateRegisteredImages} from './native-safety.mjs';
import {applyStructuredEdit} from './native-routed-runner.mjs';
import {createRegisteredLaunch} from './native-bounded-entry.mjs';
import {persistentProviderBudget} from './provider-budget.mjs';
import {createDecisionEngine} from './decision-engine.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-remediation-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function link(t,target,name,type){try{await fs.symlink(target,name,type);}catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('Host does not permit this filesystem link');return false;}throw e;}return true;}

test('native worker subprocess receives runtime variables but no parent secrets',()=>{
 const env=nativeWorkerEnvironment({...process.env,TYPESAFE_API_KEY:'fixture',OPENAI_API_KEY:'fixture',AWS_SECRET_ACCESS_KEY:'fixture',PRIVATE_VALUE:'fixture'});
 const result=spawnSync(process.execPath,['-e',"if(['TYPESAFE_API_KEY','OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','PRIVATE_VALUE'].some(k=>process.env[k]))process.exit(9);if(process.env.JEV_NATIVE_CONTROLLER_CHILD!=='1')process.exit(8)"],{env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
 const custom=path.resolve('isolated-auth-home');assert.equal(nativeSessionRoot(nativeWorkerEnvironment({CODEX_HOME:custom})),path.join(custom,'sessions'));
});
test('hard spending contracts fail before CLI artifacts or child dispatch',async t=>{
 for(const mode of [undefined,'hard','invalid'])assert.throws(()=>requireObservedSpendOptIn(mode),/cannot enforce hard/);assert.doesNotThrow(()=>requireObservedSpendOptIn('observed'));
 const root=await temp(t),request=path.join(root,'request.json'),output=path.join(root,'must-not-exist');await fs.writeFile(request,JSON.stringify({spendingLimitMode:'hard',stateFile:path.join(output,'state.json')}));
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./native-routed-cli.mjs',import.meta.url)),request],{encoding:'utf8',windowsHide:true});assert.notEqual(r.status,0);assert.match(r.stderr,/cannot enforce hard/);await assert.rejects(fs.access(output));
});
test('registered hook rejects hard budgets instead of claiming a task was launched',async t=>{
 const root=await temp(t),manifestFile=path.join(root,'manifest.json'),settingsFile=path.join(root,'settings.json'),outputRoot=path.join(root,'runs');
 const manifest={root,contract:'Edit source.',requirements:['Correct'],files:[{path:'source.mjs',mandatory:true}],actions:{verify:['test']}};
 const register=async()=>{const bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);await fs.writeFile(settingsFile,JSON.stringify({workflow:{enabled:true,batchSchedulerEnabled:true,registrations:{fixture:{path:manifestFile,sha256:sha(bytes)}}}}));};await register();
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./native-global-hook.mjs',import.meta.url))],{input:JSON.stringify({hook_event_name:'UserPromptSubmit',prompt:'jev: workflow=fixture'}),env:{...process.env,JEV_NATIVE_CONTROLLER_CHILD:'0',JEV_SETTINGS_FILE:settingsFile,JEV_NATIVE_CONTROLLER_ROOT:outputRoot,JEV_NATIVE_CONTROLLER_TEST_NO_SPAWN:'1'},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.continue,true);assert.match(result.systemMessage,/cannot enforce hard/);await assert.rejects(fs.access(outputRoot));
 manifest.execution={spendingLimitMode:'observed'};await register();const launch=await createRegisteredLaunch({workflowId:'fixture',settingsFile,outputRoot});assert.equal(launch.request.spendingLimitMode,'observed');
});
test('image containment and registered launch reject directory links outside the project',async t=>{
 const dir=await temp(t),root=path.join(dir,'root'),outside=path.join(dir,'outside');await fs.mkdir(root);await fs.mkdir(outside);const safe=path.join(root,'safe.png');await fs.writeFile(safe,'fixture');await fs.writeFile(path.join(outside,'image.png'),'outside');
 assert.deepEqual(await validateRegisteredImages([safe],root),[await fs.realpath(safe)]);
 if(!await link(t,outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir'))return;
 await assert.rejects(validateRegisteredImages([path.join(root,'linked','image.png')],root),/through a link/);
 const manifest={root,contract:'Edit source.',requirements:['Correct'],files:[{path:'source.mjs',mandatory:true}],actions:{verify:['test']},execution:{builderImages:['linked/image.png']}},manifestFile=path.join(dir,'manifest.json'),bytes=JSON.stringify(manifest);await fs.writeFile(manifestFile,bytes);
 const settingsFile=path.join(dir,'settings.json');await fs.writeFile(settingsFile,JSON.stringify({workflow:{enabled:true,batchSchedulerEnabled:true,registrations:{fixture:{path:manifestFile,sha256:sha(bytes)}}}}));
 await assert.rejects(createRegisteredLaunch({workflowId:'fixture',settingsFile,outputRoot:path.join(dir,'runs')}),/through a link/);
});
test('image dispatch revalidation rejects an external file link replacing the validated image',async t=>{
 const dir=await temp(t),root=path.join(dir,'root');await fs.mkdir(root);const outside=path.join(dir,'private.png'),image=path.join(root,'image.png');await fs.writeFile(outside,'outside');await fs.writeFile(image,'safe');const [registered]=await validateRegisteredImages([image],root);await fs.unlink(image);
 if(!await link(t,outside,image,'file'))return;await assert.rejects(validateRegisteredImages([registered],root),/through a link/);
});
test('structured edit rejects unregistered same-content case variant',async t=>{
 const root=await temp(t),file=path.join(root,'source.mjs'),variant=path.join(root,'SOURCE.mjs'),source='export const x=0;\n';await fs.writeFile(file,source);
 try{await fs.writeFile(variant,source,{flag:'wx'});}catch(e){if(e.code==='EEXIST'){t.skip('Filesystem is case-insensitive');return;}throw e;}
 const text=JSON.stringify({edits:[{file:variant,expectedSha256:sha(source),content:'changed'}],summary:'variant'});
 await assert.rejects(applyStructuredEdit({text,evidence:[{file,sha256:sha(source),mandatory:true}],workingDirectory:root,allowedFiles:[file]}),/registered file|unregistered/);assert.equal(await fs.readFile(file,'utf8'),source);assert.equal(await fs.readFile(variant,'utf8'),source);
});
test('prototype-named counters remain numeric across instances; corrupt counters fail closed',async t=>{
 for(const runId of ['constructor','toString','__proto__']){
  const directory=await temp(t);assert.equal(await persistentProviderBudget(directory,{maxRunInput:100})({runId,estimatedInputTokens:60}),true);assert.equal(await persistentProviderBudget(directory,{maxRunInput:100})({runId,estimatedInputTokens:41}),false);assert.equal(await persistentProviderBudget(directory,{maxRunInput:100})({runId,estimatedInputTokens:40}),true);
  const ledger=JSON.parse(await fs.readFile(path.join(directory,'reservations.json'),'utf8'));assert.equal(Object.hasOwn(ledger.runs,runId),true);assert.equal(ledger.runs[runId],100);
 }
 const directory=await temp(t),file=path.join(directory,'reservations.json'),invalid=JSON.stringify({timestamps:[],runs:{constructor:'corrupted'}});await fs.writeFile(file,invalid);await assert.rejects(persistentProviderBudget(directory)({runId:'constructor',estimatedInputTokens:1}),/explicit reconciliation/);assert.equal(await fs.readFile(file,'utf8'),invalid);await assert.rejects(persistentProviderBudget(directory)({runId:'r',estimatedInputTokens:NaN}),/Invalid provider reservation/);
});
test('skill refresh writes only ignored local inventory and server resolves it',async t=>{
 const dir=await temp(t),home=path.join(dir,'home'),app=path.join(dir,'app');await fs.mkdir(path.join(home,'.codex','skills','fixture-skill'),{recursive:true});await fs.mkdir(app);await fs.writeFile(path.join(home,'.codex','config.toml'),'');await fs.writeFile(path.join(home,'.codex','skills','fixture-skill','SKILL.md'),'---\ndescription: Fixture metadata\n---\n');
 for(const file of ['refresh-catalog.py','skill-catalog.mjs'])await fs.copyFile(new URL('./'+file,import.meta.url),path.join(app,file));const template='{"skills":[]}\n';await fs.writeFile(path.join(app,'skill-catalog.json'),template);const {resolveSkillCatalog}=await import(pathToFileURL(path.join(app,'skill-catalog.mjs')));assert.equal(fileURLToPath(await resolveSkillCatalog()),path.join(app,'skill-catalog.json'));
 const r=spawnSync(process.platform==='win32'?'python':'python3',[path.join(app,'refresh-catalog.py')],{env:{...process.env,HOME:home,USERPROFILE:home},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);assert.equal(await fs.readFile(path.join(app,'skill-catalog.json'),'utf8'),template);const generated=path.join(app,'.local','skill-catalog.json');assert.equal(JSON.parse(await fs.readFile(generated,'utf8')).skills[0].name,'fixture-skill');assert.equal(fileURLToPath(await resolveSkillCatalog()),generated);
 const ignored=spawnSync('git',['check-ignore','.local/skill-catalog.json'],{cwd:fileURLToPath(new URL('.',import.meta.url)),encoding:'utf8',windowsHide:true});assert.equal(ignored.status,0);
});
test('decision-engine reservations use actual run identity without sending metadata to provider',async()=>{
 const policy=JSON.parse(await fs.readFile(new URL('./decision-policy.json',import.meta.url),'utf8')),ids=[];
 const engine=createDecisionEngine({policy,apiKey:'fixture',reserveProviderRequest:async reservation=>{ids.push(reservation.runId);return true;},fetcher:async(_url,options)=>{assert.equal(Object.hasOwn(options,'reservationRunId'),false);const request=JSON.parse(options.body);return Response.json({model:policy.model,answers:{risk:{type:'noul',noul:.1}}});}});
 for(const runId of ['constructor','other'])assert.equal((await engine.evaluate({runId,state:{run:runId},questions:{risk:{type:'noul',instructions:'Is evidence missing?'}},shareWithTypeSafe:true})).status,'complete');
 assert.deepEqual(ids,['constructor','other']);
});
