import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const routedModels=new Map([
  ['gpt-5.6-luna',new Set(['low'])],
  ['gpt-6-luna',new Set(['low','medium','high','xhigh','max'])],
  ['gpt-5.6-terra',new Set(['low','medium','high','xhigh','max','ultra'])],
  ['gpt-5.6-sol',new Set(['low','medium','high','xhigh','max','ultra'])],
  ['gpt-6-sol',new Set(['low','medium','high','xhigh','max','ultra'])],
  ['gpt-6-astra',new Set(['low','medium','high','xhigh','max','ultra'])],
  ['gpt-5.5',new Set(['low','medium','high','xhigh'])]
]);
const executionProfiles=new Set(['small_edit','bounded_project','tool_heavy','visual_spatial']);
const bounded=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const exactJson=(value,max,label)=>{const serialized=JSON.stringify(value);if(serialized.length>max)throw Error(`${label} exceeds the registered compact-context limit`);return serialized;};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash=value=>crypto.createHash('sha256').update(value).digest('hex');
const defaultLimits=Object.freeze({builder:Object.freeze({maxRequests:4,maxToolCalls:3,maxRawTokens:250000,timeoutMs:300000}),repair:Object.freeze({maxRequests:3,maxToolCalls:3,maxRawTokens:150000,timeoutMs:240000}),reviewer:Object.freeze({maxRequests:1,maxToolCalls:0,maxRawTokens:60000,timeoutMs:120000})});

export function normalizeNativeLimits(raw={}){
 const normalized={};
 for(const kind of ['builder','repair','reviewer']){
  const value=raw?.[kind]??{},fallback=defaultLimits[kind];
  const limit={maxRequests:value.maxRequests??fallback.maxRequests,maxToolCalls:value.maxToolCalls??fallback.maxToolCalls,maxRawTokens:value.maxRawTokens??fallback.maxRawTokens,timeoutMs:value.timeoutMs??fallback.timeoutMs};
  if(!Number.isInteger(limit.maxRequests)||limit.maxRequests<1||limit.maxRequests>8||!Number.isInteger(limit.maxToolCalls)||limit.maxToolCalls<0||limit.maxToolCalls>8||!Number.isSafeInteger(limit.maxRawTokens)||limit.maxRawTokens<1000||limit.maxRawTokens>1000000||!Number.isInteger(limit.timeoutMs)||limit.timeoutMs<1000||limit.timeoutMs>600000)throw Error(`Invalid ${kind} execution limits`);
  normalized[kind]=limit;
 }
 return normalized;
}

export function nativeRoutePrompt(request){
 const limits=normalizeNativeLimits(request.limits),mode=request.builderMode??'packet';
 if(!['ordinary','packet','structured-edit'].includes(mode))throw Error('Unsupported builder mode for routing');
 const envelope=mode==='structured-edit'
  ?`Produce one complete structured edit response. Builder limit: ${limits.builder.maxRequests} model request(s), ${limits.builder.maxToolCalls} tool call(s), ${limits.builder.maxRawTokens} raw Codex tokens. Registered tests and a bounded reviewer follow.`
  :`Builder mode: ${mode}. Builder limit: ${limits.builder.maxRequests} model request(s), ${limits.builder.maxToolCalls} tool call(s), ${limits.builder.maxRawTokens} raw Codex tokens. Registered tests and a bounded reviewer follow.`;
 return `${bounded(request.contract,3500)}\n\nExecution envelope: ${envelope}`;
}

function enforceCompletedLimits(kind,result,limits){
 if(!result?.usage?.reconciled||!Number.isSafeInteger(result.usage.requests))throw Error(`${kind} usage is not reconciled`);
 if(result.usage.requests>limits.maxRequests)throw Error(`${kind} exceeded registered request limit (${result.usage.requests}/${limits.maxRequests})`);
 if(Number.isSafeInteger(result.toolCalls)&&result.toolCalls>limits.maxToolCalls)throw Error(`${kind} exceeded registered tool-call limit (${result.toolCalls}/${limits.maxToolCalls})`);
 if(!Number.isSafeInteger(result.usage.rawTokens)||result.usage.rawTokens>limits.maxRawTokens)throw Error(`${kind} exceeded registered raw-token limit (${result.usage.rawTokens}/${limits.maxRawTokens})`);
}

function routedSelection(raw){
 const efforts=routedModels.get(raw?.recommendedModel);
 if(!efforts?.has(raw?.recommendedEffort)||!['jev','jev-cache'].includes(raw?.provider?.status)||raw?.advisoryOnly!==true||!Number.isFinite(raw?.complexityConfidence))throw Error('Jev did not return a supported provider-backed route');
 const profile=executionProfiles.has(raw.executionProfile)&&Number.isFinite(raw.executionProfileConfidence)&&raw.executionProfileConfidence>=.55?raw.executionProfile:'bounded_project';
 const selected={source:'jev',model:raw.recommendedModel,effort:raw.recommendedEffort,confidence:raw.complexityConfidence,skills:(raw.selectedSkills||[]).filter(s=>typeof s?.name==='string'&&typeof s?.path==='string').slice(0,5),receipt:raw.usageReceipt??null,provider:raw.provider,executionProfile:profile,profileConfidence:Number.isFinite(raw.executionProfileConfidence)?raw.executionProfileConfidence:null};
 return selected.confidence>=.55?selected:{...selected,source:'fallback',model:'gpt-5.6-terra',effort:'medium',fallbackReason:'low_confidence'};
}
function fixedSelection(raw){
 const efforts=routedModels.get(raw?.model);
 if(!efforts?.has(raw?.effort))throw Error('Fixed route is not supported');
 return {source:'fixed',model:raw.model,effort:raw.effort,confidence:null,skills:[],provider:{status:'fixed-benchmark-route'},executionProfile:'bounded_project',profileConfidence:null};
}
function reviewSelection(raw,fallback){
 const efforts=routedModels.get(raw?.model);
 return efforts?.has(raw?.effort)?{source:'jev-completion',model:raw.model,effort:raw.effort,confidence:raw.confidence??null,provider:{status:'included-in-finish',model:'jev-1.13.0'}}:fallback;
}
function requireDecision(packet,stage,expected){
 const action=packet?.toolPlan?.[stage]?.actionId;
 if(action!==expected)throw Error(action?`Jev selected ${action} at ${stage}`:`Missing Jev tool decision for ${stage}`);
}
function skillReferences(route){
 return route.skills?.length?`\n\nJev-selected skill references (load applicable files; mandatory project guidance still applies):\n${JSON.stringify(route.skills)}`:'';
}
function parseReview(text){
 const raw=bounded(text,12000).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let value;
 try{value=JSON.parse(raw);}catch{throw Error('Reviewer did not return valid JSON evidence');}
 const quality=value?.quality==='acceptable'?true:value?.quality==='unacceptable'?false:null;
 if(typeof quality!=='boolean'||!Array.isArray(value.seriousDefects)||!Array.isArray(value.missingEvidence)||value.seriousDefects.some(x=>typeof x!=='string')||value.missingEvidence.some(x=>typeof x!=='string'))throw Error('Reviewer JSON does not match the required evidence schema');
 return {qualityAcceptable:quality,seriousDefects:value.seriousDefects.slice(0,8).map(x=>x.slice(0,500)),missingEvidence:value.missingEvidence.slice(0,8).map(x=>x.slice(0,500)),summary:bounded(value.summary,1000)};
}
function normalizedFile(value){return path.resolve(value).replaceAll('\\','/').toLowerCase();}
function registeredImages(value,workingDirectory){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>8)throw Error('Registered images must be a bounded array');
 const root=path.resolve(workingDirectory),seen=new Set(),images=[];
 for(const file of value){if(typeof file!=='string'||!path.isAbsolute(file)||!/\.(?:png|jpe?g|webp|gif)$/i.test(file))throw Error('Registered image path is invalid');const absolute=path.resolve(file),relative=path.relative(root,absolute),key=normalizedFile(absolute);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||seen.has(key))throw Error('Registered image escapes the working directory or is duplicated');seen.add(key);images.push(absolute);}
 return images;
}
function parseStructuredEdit(text){
 const raw=bounded(text,260000).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let value;
 try{value=JSON.parse(raw);}catch{throw Error('Structured builder did not return valid JSON');}
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.edits)||value.edits.length<1||value.edits.length>4||typeof value.summary!=='string')throw Error('Structured builder output does not match the registered schema');
 let total=0;const seen=new Set();
 for(const edit of value.edits){
  if(!edit||typeof edit!=='object'||Array.isArray(edit)||typeof edit.file!=='string'||typeof edit.expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(edit.expectedSha256)||typeof edit.content!=='string'||edit.content.length>64000||edit.content.includes('\0'))throw Error('Structured builder edit is invalid or oversized');
  const key=normalizedFile(edit.file);if(seen.has(key))throw Error('Structured builder returned a duplicate file');seen.add(key);total+=Buffer.byteLength(edit.content,'utf8');
 }
 if(total>128000)throw Error('Structured builder output exceeds the registered transaction size');
 return {edits:value.edits,summary:bounded(value.summary,1000)};
}
export async function applyStructuredEdit({text,evidence,workingDirectory,allowedFiles}){
 if(!Array.isArray(allowedFiles)||allowedFiles.length<1||allowedFiles.length>4||allowedFiles.some(file=>typeof file!=='string')||new Set(allowedFiles.map(normalizedFile)).size!==allowedFiles.length)throw Error('One to four unique registered structured-edit files are required');
 const root=await fs.realpath(workingDirectory),allowed=new Set(allowedFiles.map(normalizedFile));
 const selected=(evidence||[]).filter(item=>item?.builderVisible!==false&&item?.mandatory===true&&typeof item.file==='string'&&typeof item.sha256==='string');
 const registrations=new Map(selected.filter(item=>allowed.has(normalizedFile(item.file))).map(item=>[normalizedFile(item.file),item]));
 if(registrations.size!==allowed.size)throw Error('Structured-edit files are not present in mandatory evidence');
 const {edits,summary}=parseStructuredEdit(text),editKeys=new Set(edits.map(edit=>normalizedFile(edit.file)));
 if(editKeys.size!==allowed.size||[...allowed].some(file=>!editKeys.has(file)))throw Error('Structured builder did not return every registered file exactly once');
 const transaction=[];
 for(const edit of edits){
  const key=normalizedFile(edit.file),registered=registrations.get(key);
  if(!registered||edit.expectedSha256!==registered.sha256)throw Error('Structured builder selected an unregistered or stale file');
  const target=await fs.realpath(edit.file),relative=path.relative(root,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||normalizedFile(target)!==key)throw Error('Structured edit escapes the registered working directory');
  const before=await fs.readFile(target),beforeHash=bytesHash(before);
  if(beforeHash!==registered.sha256)throw Error('Structured edit source changed before application');
  const next=Buffer.from(edit.content,'utf8'),afterHash=bytesHash(next);
  transaction.push({target,before,beforeHash,next,afterHash,temp:path.join(path.dirname(target),`.${path.basename(target)}.${crypto.randomUUID()}.jev-edit.tmp`)});
 }
 const changed=transaction.filter(item=>item.afterHash!==item.beforeHash);
 if(!changed.length)throw Error('Structured builder produced no source change');
 const applied=[];
 try{
  for(const item of changed)await fs.writeFile(item.temp,item.next,{flag:'wx',mode:0o600});
  for(const item of changed)if(bytesHash(await fs.readFile(item.target))!==item.beforeHash)throw Error('Structured edit source changed during application');
  for(const item of changed){await fs.rename(item.temp,item.target);applied.push(item);}
 }catch(error){
  const rollbackErrors=[];
  for(const item of applied.reverse())try{const rollback=path.join(path.dirname(item.target),`.${path.basename(item.target)}.${crypto.randomUUID()}.jev-rollback.tmp`);await fs.writeFile(rollback,item.before,{flag:'wx',mode:0o600});await fs.rename(rollback,item.target);}catch(rollbackError){rollbackErrors.push(rollbackError.message);}
  if(rollbackErrors.length)throw Error(`Structured edit failed and rollback was incomplete: ${rollbackErrors.join('; ')}`);
  throw error;
 }finally{for(const item of changed)await fs.unlink(item.temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 const files=changed.map(item=>({file:item.target,beforeSha256:item.beforeHash,afterSha256:item.afterHash,bytes:item.next.length}));
 return {...files[0],files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0),summary};
}
function reviewerPrompt(request,finish){
 const requested=new Set(request.review.files.map(x=>x.replaceAll('\\','/').toLowerCase()));
 const sources=(finish.reviewEvidence||[]).filter(e=>typeof e?.file==='string'&&typeof e?.text==='string'&&requested.has(e.file.replaceAll('\\','/').toLowerCase())).slice(0,20).map(e=>({file:e.file,sha256:e.sha256??null,text:e.text}));
 if(sources.length!==requested.size)throw Error('Verified reviewer source packet is incomplete');
 const sourcePacket=exactJson(sources,40000,'Verified reviewer source packet');
 const criteria=request.review.criteria.slice(0,8).map(x=>`- ${x}`).join('\n');
 const evidence={status:finish.status,verification:finish.verification,tests:finish.tests,protectedChanged:finish.protectedChanged,failures:finish.failures,completionDecision:finish.completionDecision};
 return `Independently review the completed candidate using only the verified source packet below. Do not call tools, reread files, edit files, start tasks, use agents, rerun passing tests, inspect usage, or infer workflow identity.\n\nContract:\n${bounded(request.contract,5000)}\n\nVerified source packet:\n${sourcePacket}\n\nCriteria:\n${criteria}\n\nRegistered verification:\n${bounded(JSON.stringify(evidence),1800)}\n\nReturn only JSON matching the supplied schema. A serious defect must identify a concrete contract or maintainability failure. Treat each passing registered test and held-out result as established behavioral evidence; do not request hidden evaluator cases or assertions. Use missingEvidence only when a registered implementation source needed to assess the contract is absent or truncated, and identify that exact source.`;
}
function compactBuilderPacket(packet){
 const evidence=(packet.selected||[]).filter(item=>item?.mandatory===true&&item?.builderVisible!==false).slice(0,30);
 return {packet:{contract:bounded(packet.contract,5000),requirements:(packet.requirements||[]).slice(0,16),evidence:evidence.map(({file,sha256,start,end,text})=>({file,sha256,start,end,text}))},evidence};
}
function repairPrompt(request,packet,finish,structured){
 const compact=compactBuilderPacket(packet).packet,failure={tests:finish.tests,protectedChanged:finish.protectedChanged,failures:finish.failures,advisory:finish.advisory};
 const structuredInstruction=structured?`\n\nReturn only the registered JSON edit object. Do not call tools or reread files. Provide exactly one complete replacement for each registered file and no others: ${JSON.stringify(request.structuredEdit.allowedFiles)}. Copy each current source SHA-256 into expectedSha256.`:'\n\nEdit only the registered source files. Use the focused failure and current source packet before any reread.';
 return `This is the single registered repair escalation after deterministic verification failed.\n\nContract and current exact evidence:\n${exactJson(compact,40000,'Repair evidence packet')}\n\nFocused failure packet:\n${bounded(JSON.stringify(failure),5000)}${structuredInstruction}\n\nCorrect the actual defect without weakening tests or expanding scope. Do not run registered tests; the controller reruns them once.`;
}

export async function runNativeRoutedWorkflow(request,deps){
 if(!request?.workflowId||!request?.runId||!request?.contract||!request?.workingDirectory||!request?.review?.files?.length||!request?.review?.criteria?.length)throw Error('Validated native routed request required');
 for(const name of ['callTool','runCodex','checkpoint'])if(typeof deps?.[name]!=='function')throw Error(`Missing dependency ${name}`);
 const routingMode=request.routingMode??'jev',builderMode=request.builderMode??'packet';
 if(!['jev','fixed'].includes(routingMode))throw Error('Unsupported routing mode');
 if(!['packet','ordinary','structured-edit'].includes(builderMode))throw Error('Unsupported builder mode');
 const limits=normalizeNativeLimits(request.limits),builderImages=registeredImages(request.builder?.images,request.workingDirectory),reviewImages=registeredImages(request.review?.images,request.workingDirectory);const state={requestHash:hash(request),phase:'routing',limits,routingMode,builderMode};await deps.checkpoint(state);
 if(builderMode==='structured-edit'&&(limits.builder.maxRequests!==1||limits.builder.maxToolCalls!==0||!path.isAbsolute(request.builder?.outputSchema??'')||!Array.isArray(request.structuredEdit?.allowedFiles)||request.structuredEdit.allowedFiles.length<1||request.structuredEdit.allowedFiles.length>4||deps.completedBuilder))throw Error('Structured-edit mode requires one request, zero tools, an output schema and one to four registered files');
 let route;
 if(routingMode==='fixed')route=fixedSelection(request.fixedRoute);
 else try{route=routedSelection(await deps.callTool('route_task',{prompt:nativeRoutePrompt(request),shareWithTypeSafe:request.shareWithTypeSafe===true,invocation:'manual'}));}
 catch(e){route={source:'normal',model:null,effort:null,confidence:null,skills:[],provider:{status:'routing-unavailable'},fallbackReason:e.message};}
 if(route.source!=='normal'&&request.supportedExecutionProfiles!==undefined){if(!Array.isArray(request.supportedExecutionProfiles)||!request.supportedExecutionProfiles.length||request.supportedExecutionProfiles.some(profile=>!executionProfiles.has(profile))||!request.supportedExecutionProfiles.includes(route.executionProfile))throw Error(`Jev execution profile ${route.executionProfile} is outside the registered workflow envelope`);}
 state.route=route;state.phase='preparing';await deps.checkpoint(state);
 const mode=['normal','fixed'].includes(route.source)?'deterministic':'jev';
 const packet=await deps.callTool('prepare_work_packet',{workflowId:request.workflowId,runId:request.runId,mode,compact:true,maxExcerptChars:request.maxExcerptChars??6000,shareWithTypeSafe:mode==='jev'&&request.shareWithTypeSafe===true});
 if(!['prepared','ready'].includes(packet.status)||packet.requiredRetrieval?.length)throw Error('Workflow packet requires missing evidence');
 if(mode==='jev'&&(!Number.isSafeInteger(packet.provider?.receipts)||packet.provider.receipts<1||packet.provider.usageKnown!==true))throw Error('Jev packet lacks reconciled provider usage');
 if(mode==='jev')requireDecision(packet,'afterPrepare','dispatch_builder');
 const initialPacket=compactBuilderPacket(packet),builderEvidence=initialPacket.evidence,builderPacket=initialPacket.packet;
 const builderPacketText=exactJson(builderPacket,40000,'Builder evidence packet');
 const taskBody=builderMode==='ordinary'
  ?`Task contract:\n${bounded(request.contract,5000)}\n\nInspect the registered project source directly as needed.`
  :`Task contract and exact evidence:\n${builderPacketText}\n\nUse this packet instead of exploratory rereads.`;
 const structuredInstruction=builderMode==='structured-edit'?`\n\nReturn only the registered JSON edit object. Do not call tools or reread files. Provide exactly one complete replacement for each of these registered files and no others: ${JSON.stringify(request.structuredEdit.allowedFiles)}. Copy each source SHA-256 into its expectedSha256 field.`:'';
 const assignment=`${bounded(request.assignmentPrefix,2000)}${skillReferences(route)}\n\n${taskBody}${structuredInstruction}\n\nImplement only within the authorized scope. Do not run registered tests; the deterministic controller runs them after completion. Report changed files and unresolved evidence concisely.`;
 state.packet={status:packet.status,provider:packet.provider,artifact:packet.artifact};state.phase='builder_dispatch_pending';await deps.checkpoint(state);
 const builder=deps.completedBuilder??await deps.runCodex({kind:'builder',title:request.title??request.runId,prompt:assignment,cwd:request.workingDirectory,model:route.model,effort:route.effort,useDefaultModel:route.source==='normal',sandbox:builderMode==='structured-edit'?'read-only':'workspace-write',outputSchema:builderMode==='structured-edit'?request.builder.outputSchema:undefined,images:builderImages,limits:limits.builder,onStarted:async threadId=>{state.builder={threadId,phase:'running'};state.phase='builder_running';await deps.checkpoint(state);}});state.builder={...builder,...(builderMode==='structured-edit'?{finalMessage:undefined}:{}),phase:'completed_pending_validation'};state.phase='builder_completed';await deps.checkpoint(state);enforceCompletedLimits('builder',builder,limits.builder);
 let editReceipt=null;
 if(builderMode==='structured-edit'){
  state.phase='structured_edit_pending';await deps.checkpoint(state);
  editReceipt=await (deps.applyStructuredEdit??applyStructuredEdit)({text:builder.finalMessage,evidence:builderEvidence,workingDirectory:request.workingDirectory,allowedFiles:request.structuredEdit.allowedFiles});
 }
 state.builder={...builder,...(builderMode==='structured-edit'?{finalMessage:undefined,structuredEdit:editReceipt}:{}),phase:'complete'};state.phase='verifying';await deps.checkpoint(state);
 if(mode==='jev')requireDecision(packet,'afterBuilder','verify_registered');
 let finish=await deps.callTool('run_workflow_stage',{workflowId:request.workflowId,runId:request.runId,mode,actionId:'finish',operationId:`${request.runId}-finish-1`,shareWithTypeSafe:mode==='jev'&&request.shareWithTypeSafe===true}),repair=null;
 state.verification=finish;state.verificationAttempts=[{operationId:finish.operationId??`${request.runId}-finish-1`,status:finish.status,provider:finish.provider??null}];
 if(finish.status!=='verified'||finish.verification!=='passed'){
  if(finish.protectedChanged?.length||request.maxRepairs===0)throw Error('Registered verification failed');
  state.phase='repair_preparing';await deps.checkpoint(state);
  const repairPacket=await deps.callTool('prepare_work_packet',{workflowId:request.workflowId,runId:request.runId,mode,compact:true,maxExcerptChars:request.maxExcerptChars??6000,shareWithTypeSafe:mode==='jev'&&request.shareWithTypeSafe===true});
  if(!['prepared','ready'].includes(repairPacket.status)||repairPacket.requiredRetrieval?.length)throw Error('Repair packet requires missing evidence');
  if(mode==='jev'&&(!Number.isSafeInteger(repairPacket.provider?.receipts)||repairPacket.provider.receipts<1||repairPacket.provider.usageKnown!==true))throw Error('Jev repair packet lacks reconciled provider usage');
  const structured=builderMode==='structured-edit';if(structured&&(limits.repair.maxRequests!==1||limits.repair.maxToolCalls!==0))throw Error('Structured repair requires one request and zero tools');
  state.repairPacket={status:repairPacket.status,provider:repairPacket.provider,artifact:repairPacket.artifact,trigger:'verification'};const repairEvidence=compactBuilderPacket(repairPacket).evidence,prompt=repairPrompt(request,repairPacket,finish,structured);state.phase='repair_dispatch_pending';await deps.checkpoint(state);
  repair=await deps.runCodex({kind:'repair',title:`${request.title??request.runId} repair`,prompt,cwd:request.workingDirectory,model:route.model,effort:route.effort,useDefaultModel:route.source==='normal',sandbox:structured?'read-only':'workspace-write',outputSchema:structured?request.builder.outputSchema:undefined,images:builderImages,limits:limits.repair,onStarted:async threadId=>{state.repair={threadId,phase:'running'};state.phase='repair_running';await deps.checkpoint(state);}});state.repair={...repair,...(structured?{finalMessage:undefined}:{}),phase:'completed_pending_validation'};state.phase='repair_completed';await deps.checkpoint(state);enforceCompletedLimits('repair',repair,limits.repair);
  let repairReceipt=null;if(structured)repairReceipt=await (deps.applyStructuredEdit??applyStructuredEdit)({text:repair.finalMessage,evidence:repairEvidence,workingDirectory:request.workingDirectory,allowedFiles:request.structuredEdit.allowedFiles});state.repair={...repair,...(structured?{finalMessage:undefined,structuredEdit:repairReceipt}:{}),phase:'complete'};state.phase='reverifying';await deps.checkpoint(state);
  if(mode==='jev')requireDecision(repairPacket,'afterBuilder','verify_registered');
  finish=await deps.callTool('run_workflow_stage',{workflowId:request.workflowId,runId:request.runId,mode,actionId:'finish',operationId:`${request.runId}-finish-2`,shareWithTypeSafe:mode==='jev'&&request.shareWithTypeSafe===true});state.verification=finish;state.verificationAttempts.push({operationId:finish.operationId??`${request.runId}-finish-2`,status:finish.status,provider:finish.provider??null});
  if(finish.status!=='verified'||finish.verification!=='passed')throw Error('Registered verification failed after the bounded repair');
 }
 if(mode==='jev'){
  const decision=finish.completionDecision;if(!decision?.actionId)throw Error('Jev completion decision is missing or invalid');
  if(decision.actionId==='stop_substantive_defect')throw Error('Jev identified a substantive defect');
  const independentReviewRequired=request.requireReviewer===true||route.executionProfile==='tool_heavy'||route.executionProfile==='visual_spatial';
  if(decision.actionId==='complete'&&!independentReviewRequired){
   state.review={performed:false,required:false,qualityAcceptable:null,seriousDefects:[],missingEvidence:[],summary:'Registered tests and the Jev atomic completion gate passed; no independent review was required.',source:'none'};
   state.acceptance={testsPassed:true,completionGatePassed:true,independentReviewRequired:false,independentReviewPassed:null};state.phase='complete';state.codexTokens=builder.usage.rawTokens+(repair?.usage.rawTokens??0);await deps.checkpoint(state);return state;
  }
  if(decision.actionId!=='dispatch_reviewer'&&!(decision.actionId==='complete'&&independentReviewRequired))throw Error(`Unsupported completion action ${decision.actionId}`);
 }
 let reviewRoute=mode==='jev'?reviewSelection(finish.reviewRoute,route):route;state.reviewRoute=reviewRoute;
 const prompt=reviewerPrompt(request,finish);state.phase='review_dispatch_pending';await deps.checkpoint(state);
 const reviewer=await deps.runCodex({kind:'reviewer',title:request.review.title??`${request.title??request.runId} review`,prompt,cwd:request.workingDirectory,model:reviewRoute.model,effort:reviewRoute.effort,useDefaultModel:reviewRoute.source==='normal',sandbox:'read-only',outputSchema:request.review.outputSchema,images:reviewImages,limits:limits.reviewer,onStarted:async threadId=>{state.reviewer={threadId,phase:'running'};state.phase='review_running';await deps.checkpoint(state);}});state.reviewer={...reviewer,phase:'completed_pending_validation'};state.phase='reviewer_completed';await deps.checkpoint(state);enforceCompletedLimits('reviewer',reviewer,limits.reviewer);
 state.reviewer={...reviewer,phase:'complete'};state.phase='review_complete';await deps.checkpoint(state);state.review=parseReview(reviewer.finalMessage);
 if(state.review.missingEvidence.length)throw Error(`Reviewer evidence missing: ${state.review.missingEvidence.join('; ')}`);
 let reviewer2=null;
 if(!state.review.qualityAcceptable||state.review.seriousDefects.length){
  if(repair||request.maxRepairs===0)throw Error(`Reviewer found defects: ${state.review.seriousDefects.join('; ')}`);
  state.reviewFailure=state.review;state.phase='review_repair_preparing';await deps.checkpoint(state);
  const repairPacket=await deps.callTool('prepare_work_packet',{workflowId:request.workflowId,runId:request.runId,mode,compact:true,maxExcerptChars:request.maxExcerptChars??6000,shareWithTypeSafe:mode==='jev'&&request.shareWithTypeSafe===true});
  if(!['prepared','ready'].includes(repairPacket.status)||repairPacket.requiredRetrieval?.length)throw Error('Review repair packet requires missing evidence');
  if(mode==='jev'&&(!Number.isSafeInteger(repairPacket.provider?.receipts)||repairPacket.provider.receipts<1||repairPacket.provider.usageKnown!==true))throw Error('Jev review repair packet lacks reconciled provider usage');
  const structured=builderMode==='structured-edit';if(structured&&(limits.repair.maxRequests!==1||limits.repair.maxToolCalls!==0))throw Error('Structured repair requires one request and zero tools');
  state.repairPacket={status:repairPacket.status,provider:repairPacket.provider,artifact:repairPacket.artifact,trigger:'review'};const repairEvidence=compactBuilderPacket(repairPacket).evidence,reviewFailure={tests:finish.tests,protectedChanged:[],failures:state.review.seriousDefects.map((text,index)=>({id:`review-${index+1}`,text})),advisory:null},repairTaskPrompt=repairPrompt(request,repairPacket,reviewFailure,structured);state.phase='review_repair_dispatch_pending';await deps.checkpoint(state);
  repair=await deps.runCodex({kind:'repair',title:`${request.title??request.runId} review repair`,prompt:repairTaskPrompt,cwd:request.workingDirectory,model:route.model,effort:route.effort,useDefaultModel:route.source==='normal',sandbox:structured?'read-only':'workspace-write',outputSchema:structured?request.builder.outputSchema:undefined,images:builderImages,limits:limits.repair,onStarted:async threadId=>{state.repair={threadId,phase:'running',trigger:'review'};state.phase='review_repair_running';await deps.checkpoint(state);}});state.repair={...repair,...(structured?{finalMessage:undefined}:{}),phase:'completed_pending_validation',trigger:'review'};state.phase='review_repair_completed';await deps.checkpoint(state);enforceCompletedLimits('repair',repair,limits.repair);
  let repairReceipt=null;if(structured)repairReceipt=await (deps.applyStructuredEdit??applyStructuredEdit)({text:repair.finalMessage,evidence:repairEvidence,workingDirectory:request.workingDirectory,allowedFiles:request.structuredEdit.allowedFiles});state.repair={...repair,...(structured?{finalMessage:undefined,structuredEdit:repairReceipt}:{}),phase:'complete',trigger:'review'};state.phase='review_repair_verifying';await deps.checkpoint(state);
  if(mode==='jev')requireDecision(repairPacket,'afterBuilder','verify_registered');
  finish=await deps.callTool('run_workflow_stage',{workflowId:request.workflowId,runId:request.runId,mode,actionId:'finish',operationId:`${request.runId}-finish-2`,shareWithTypeSafe:mode==='jev'&&request.shareWithTypeSafe===true});state.verification=finish;state.verificationAttempts.push({operationId:finish.operationId??`${request.runId}-finish-2`,status:finish.status,provider:finish.provider??null});
  if(finish.status!=='verified'||finish.verification!=='passed')throw Error('Registered verification failed after the review repair');
  if(mode==='jev'){const decision=finish.completionDecision;if(!decision?.actionId||decision.actionId==='stop_substantive_defect')throw Error('Jev rejected the review repair');}
  reviewRoute=mode==='jev'?reviewSelection(finish.reviewRoute,route):route;state.reviewRoute=reviewRoute;const prompt2=reviewerPrompt(request,finish);state.phase='review2_dispatch_pending';await deps.checkpoint(state);
  reviewer2=await deps.runCodex({kind:'reviewer2',title:`${request.review.title??`${request.title??request.runId} review`} follow-up`,prompt:prompt2,cwd:request.workingDirectory,model:reviewRoute.model,effort:reviewRoute.effort,useDefaultModel:reviewRoute.source==='normal',sandbox:'read-only',outputSchema:request.review.outputSchema,images:reviewImages,limits:limits.reviewer,onStarted:async threadId=>{state.reviewer2={threadId,phase:'running'};state.phase='review2_running';await deps.checkpoint(state);}});state.reviewer2={...reviewer2,phase:'completed_pending_validation'};state.phase='review2_completed';await deps.checkpoint(state);enforceCompletedLimits('reviewer2',reviewer2,limits.reviewer);state.reviewer2={...reviewer2,phase:'complete'};state.phase='review2_complete';await deps.checkpoint(state);state.review=parseReview(reviewer2.finalMessage);
  if(state.review.missingEvidence.length)throw Error(`Follow-up reviewer evidence missing: ${state.review.missingEvidence.join('; ')}`);if(!state.review.qualityAcceptable||state.review.seriousDefects.length)throw Error(`Follow-up reviewer found defects: ${state.review.seriousDefects.join('; ')}`);
 }
 state.acceptance={testsPassed:true,completionGatePassed:mode==='jev',independentReviewRequired:true,independentReviewPassed:true};state.phase='complete';state.codexTokens=builder.usage.rawTokens+(repair?.usage.rawTokens??0)+reviewer.usage.rawTokens+(reviewer2?.usage.rawTokens??0);await deps.checkpoint(state);return state;
}
