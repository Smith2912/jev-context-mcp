// Execute inside functions.exec with the supported tools object. The caller
// must durably checkpoint state, and must serialize invocations for a job.
export async function runDispatch(tools,job,state,checkpoint,onProgress=()=>{},maxWaits=10){
 const decode=r=>{if(r.isError)throw Error('App tool returned an error');const block=r.content?.find(c=>c.type==='text');if(!block)throw Error('Missing app response');return JSON.parse(block.text);};
 if(!Number.isInteger(maxWaits)||maxWaits<1||maxWaits>10)throw Error('Invalid wait bound');
 if(!job.prompt||(!job.useDefaultModel&&(!job.model||!job.effort))||!job.target||typeof checkpoint!=='function')throw Error('Validated job and checkpoint required');
 if(job.direct===true&&job.explicitModelAuthorized!==true&&job.routedSelectionAuthorized!==true)throw Error('Direct model selection requires explicit user selection or a validated routed selection');
 if(['creation_pending','dispatch_pending'].includes(state.phase))throw Error('Ambiguous prior action: reconcile the saved task before resuming. No duplicate was created.');
 if(state.phase==='complete'||state.phase==='needs_attention')return state;
 if(!state.phase){
  state.phase='creation_pending';await checkpoint(state);
  const created=decode(await tools.mcp__codex_app__create_thread({title:job.title,target:job.target,...(job.direct?{prompt:job.prompt,...(job.useDefaultModel?{}:{model:job.model,thinking:job.effort})}:{prompt:'Initialization only. Reply Ready without tools or project work; the bounded assignment follows.'})}));
  state.threadId=created.threadId;state.clientThreadId=created.clientThreadId;state.hostId=created.hostId;
  state.phase=state.threadId?(job.direct?'executing':'initializing'):'needs_attention';await checkpoint(state);
  if(!state.threadId)return state; // Never use a clientThreadId as a threadId.
 }
 for(let i=0;i<maxWaits;i++){
  const response=decode(await tools.mcp__codex_app__wait_threads({targets:[{threadId:state.threadId,...(state.hostId?{hostId:state.hostId}:{}),...(state.cursor?{afterCursor:state.cursor}:{})}],timeoutMs:60000}));
  const poll=response.polls?.find(p=>p.thread?.id===state.threadId);
  if(!poll){continue;}
  if(poll.cursor)state.cursor=poll.cursor;
  const turn=poll.latestTurn;
  if(turn?.error||['failed','interrupted'].includes(turn?.status)){state.phase='needs_attention';state.error=turn.error??turn.status;await checkpoint(state);return state;}
  if(state.phase==='initializing'&&turn?.status==='completed'){
   state.initializationTurnId=turn.id;state.phase='dispatch_pending';await checkpoint(state);
   decode(await tools.mcp__codex_app__send_message_to_thread({threadId:state.threadId,...(state.hostId?{hostId:state.hostId}:{}),prompt:job.prompt,model:job.model,thinking:job.effort}));
   state.phase='executing';await checkpoint(state);await onProgress({phase:state.phase,threadId:state.threadId});continue;
  }
  if(state.phase==='executing'&&turn?.id!==state.initializationTurnId){
   state.executionTurnId=turn?.id;
   if(turn?.status==='completed'){state.phase='complete';state.result=poll.latestAssistantMessage?.text??null;await checkpoint(state);return state;}
  }
  await checkpoint(state); // Unchanged observations do not need model-visible output.
 }
 return state; // Resume with this state; timeouts never authorize a restart.
}

const routedModels=new Map([
 ['gpt-5.6-luna',new Set(['low'])],
 ['gpt-6-luna',new Set(['low','medium','high','xhigh','max'])],
 ['gpt-5.6-terra',new Set(['low','medium','high','xhigh','max','ultra'])],
 ['gpt-5.6-sol',new Set(['low','medium','high','xhigh','max','ultra'])],
 ['gpt-6-sol',new Set(['low','medium','high','xhigh','max','ultra'])],
 ['gpt-6-astra',new Set(['low','medium','high','xhigh','max','ultra'])],
 ['gpt-5.5',new Set(['low','medium','high','xhigh'])]
]);
const decodeApp=r=>{if(r?.isError)throw Error('Tool returned an error');const block=r?.content?.find(c=>c.type==='text');if(!block)throw Error('Missing tool response');return JSON.parse(block.text);};
const bounded=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const compactRoute=r=>({source:'jev',model:r.recommendedModel,effort:r.recommendedEffort,confidence:r.complexityConfidence,skills:(r.selectedSkills||[]).filter(s=>typeof s?.name==='string'&&typeof s?.path==='string').slice(0,5).map(s=>({name:s.name.slice(0,100),path:s.path.slice(0,500)})),receipt:r.usageReceipt??null,provider:{status:r.provider?.status??null,model:r.provider?.model??null,usage:r.provider?.usage??null}});
function validateRoute(route){
 const efforts=routedModels.get(route?.recommendedModel);
 if(!efforts?.has(route?.recommendedEffort)||!['jev','jev-cache'].includes(route?.provider?.status)||route?.advisoryOnly!==true||!Number.isFinite(route?.complexityConfidence))throw Error('Jev did not return a supported, provider-backed route');
 return compactRoute(route);
}
function embeddedReviewRoute(route,fallback){
 const efforts=routedModels.get(route?.model);
 return efforts?.has(route?.effort)?{source:'jev-completion',model:route.model,effort:route.effort,confidence:route.confidence??null,skills:[],receipt:null,provider:{status:'included-in-finish',model:'jev-1.13.0',usage:null}}:fallback;
}
function parseReview(text){
 const raw=bounded(text,12000).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let value;
 try{value=JSON.parse(raw);}catch{throw Error('Reviewer did not return valid JSON evidence');}
 const quality=typeof value?.qualityAcceptable==='boolean'?value.qualityAcceptable:value?.quality==='acceptable'?true:value?.quality==='unacceptable'?false:null;
 if(typeof quality!=='boolean'||!Array.isArray(value.seriousDefects)||!Array.isArray(value.missingEvidence)||value.seriousDefects.some(x=>typeof x!=='string')||value.missingEvidence.some(x=>typeof x!=='string'))throw Error('Reviewer JSON does not match the required evidence schema');
 return {qualityAcceptable:quality,seriousDefects:value.seriousDefects.slice(0,8).map(x=>x.slice(0,500)),missingEvidence:value.missingEvidence.slice(0,8).map(x=>x.slice(0,500)),summary:bounded(value.summary,1000)};
}
function reviewPrompt(request,verification){
 const normalized=value=>value.replaceAll('\\','/').toLowerCase();
 const requested=new Set((request.review.files||[]).slice(0,20).map(normalized));
 let remaining=10000;
 const sources=(verification.reviewEvidence||[]).filter(e=>typeof e?.file==='string'&&typeof e?.text==='string'&&requested.has(normalized(e.file))).slice(0,20).map(e=>{
  const text=bounded(e.text,Math.min(6000,remaining));remaining-=text.length;
  return {file:e.file,sha256:e.sha256??null,text};
 }).filter(e=>e.text.length);
 const criteria=(request.review.criteria||[]).slice(0,8).map(x=>`- ${x}`).join('\n');
 const verificationSummary={status:verification.status,verified:verification.verified,tests:verification.tests,protectedChanges:verification.protectedChanges,failures:verification.failures,completionDecision:verification.completionDecision};
 return `Independently review the completed candidate using only the verified source packet below. Do not call tools, reread files, edit files, start tasks, use agents, rerun passing tests, inspect usage, or infer workflow identity.\n\nContract:\n${bounded(request.contract,5000)}\n\nVerified source packet (captured before registered tests and hash-checked unchanged afterward):\n${bounded(JSON.stringify(sources),11000)}\n\nCriteria:\n${criteria}\n\nRegistered verification passed: ${bounded(JSON.stringify(verificationSummary),1800)}\n\nReturn only JSON: {"quality":"acceptable or unacceptable","seriousDefects":[string],"missingEvidence":[string],"summary":string}. A serious defect must identify a concrete contract or maintainability failure. Missing evidence must identify the exact absent source or test evidence.`;
}
async function route(tools,prompt,shareWithTypeSafe){
 try{
  const selected=validateRoute(decodeApp(await tools.mcp__jev_context__route_task({prompt:bounded(prompt,4000),shareWithTypeSafe,invocation:'manual'})));
  if(selected.confidence>=.55)return selected;
  return {source:'fallback',model:'gpt-5.6-terra',effort:'medium',confidence:selected.confidence,skills:[],receipt:selected.receipt,provider:selected.provider,fallbackReason:'low_confidence'};
 }catch(e){return {source:'normal',model:null,effort:null,confidence:null,skills:[],receipt:null,provider:{status:'routing-unavailable',model:null,usage:null},fallbackReason:e.message};}
}
function requireToolDecision(packet,stage,expected){const decision=packet?.toolPlan?.[stage];if(!decision?.actionId)return {ok:false,reason:'missing_evidence',message:`Missing Jev tool decision for ${stage}`};if(decision.actionId!==expected)return {ok:false,reason:decision.actionId==='stop_missing_evidence'?'missing_evidence':'substantive_defect',message:`Jev selected ${decision.actionId} at ${stage}`};return {ok:true};}
const skillReferences=route=>route.skills?.length?`\n\nJev-selected skill references (load applicable files; mandatory project guidance still applies):\n${JSON.stringify(route.skills)}`:'';
async function account(services,threadId,turnId){
 if(typeof services?.collectUsage!=='function')return {status:'unavailable'};
 const result=await services.collectUsage(threadId,turnId);if(result?.reconciled!==true)throw Error('Completed task usage did not reconcile');return result;
}
async function captureReviewEvidence(tools,files){
 const selected=(files||[]).slice(0,20);
 if(selected.some(file=>typeof file!=='string'||!/^[A-Za-z]:[\\/]/.test(file)))throw Error('Review evidence requires absolute Windows paths');
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 return Promise.all(selected.map(async file=>{
  const result=await tools.exec_command({cmd:`$p=${quote(file)};$before=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower();$text=[IO.File]::ReadAllText($p);$after=(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower();if($before -ne $after){throw 'Review source changed during capture'};[ordered]@{file=$p;sha256=$after;text=$text}|ConvertTo-Json -Compress`,max_output_tokens:12000});
  if(result.exit_code!==0)throw Error(`Cannot capture review evidence: ${file}`);
  const evidence=JSON.parse(result.output);
  if(typeof evidence?.text!=='string'||typeof evidence?.sha256!=='string')throw Error(`Invalid review evidence: ${file}`);
  return {file:evidence.file,sha256:evidence.sha256,text:bounded(evidence.text,6000)};
 }));
}
async function attention(state,checkpoint,reason,evidence={}){state.phase='needs_attention';state.escalation={reason,...evidence};await checkpoint(state);return state;}

// A single checkpointed controller turn owns routing, direct dispatch, waits,
// registered verification, compact review, and exact per-task accounting.
// It never launches a repair or escalation task automatically.
export async function runRoutedWorkflow(tools,request,state,checkpoint,services={},onProgress=()=>{},maxWaits=10){
 if(!request?.contract||!request?.title||!request?.target||!request?.workflow?.workflowId||!request?.workflow?.runId||!request?.review?.files?.length||typeof checkpoint!=='function')throw Error('Validated routed workflow request required');
 if(['routing_pending','prepare_pending','verification_pending','review_routing_pending'].includes(state.phase))throw Error('Ambiguous prior paid or mutating action; reconcile the saved state before resuming');
 if(state.phase==='complete'||state.phase==='needs_attention')return state;
 if(!state.route){
  state.phase='routing_pending';await checkpoint(state);state.route=await route(tools,request.contract,request.shareWithTypeSafe===true);
  state.phase='routed';await checkpoint(state);
 }
 if(!state.packet){
  state.phase='prepare_pending';await checkpoint(state);
  state.effectiveMode=state.route.source==='normal'?'deterministic':request.workflow.mode??'jev';
  let packet;try{packet=decodeApp(await tools.mcp__jev_context__prepare_work_packet({workflowId:request.workflow.workflowId,runId:request.workflow.runId,mode:state.effectiveMode,compact:true,maxExcerptChars:request.workflow.maxExcerptChars??6000,shareWithTypeSafe:state.effectiveMode==='jev'&&request.shareWithTypeSafe===true}));}catch(e){return attention(state,checkpoint,'missing_evidence',{message:e.message});}
  const normalPlan={afterPrepare:{actionId:'dispatch_builder',source:'normal'},afterBuilder:{actionId:'verify_registered',source:'normal'},afterTestsPass:{actionId:'dispatch_reviewer',source:'normal'},afterReviewPass:{actionId:'complete',source:'normal'}};
  state.packet={status:packet.status,contract:bounded(packet.contract,5000),requirements:(packet.requirements||[]).slice(0,16),evidence:(packet.selected||packet.evidence||[]).slice(0,30),requiredRetrieval:(packet.requiredRetrieval||[]).slice(0,20),toolPlan:packet.toolPlan??(state.route.source==='normal'?normalPlan:null),provider:packet.provider??null,artifact:packet.artifact??null};
  if(!['ready','prepared'].includes(packet.status)||state.packet.requiredRetrieval.length)return attention(state,checkpoint,'missing_evidence',{requiredRetrieval:state.packet.requiredRetrieval});
  if(state.effectiveMode==='jev'&&(!Number.isSafeInteger(state.packet.provider?.receipts)||state.packet.provider.receipts<1||state.packet.provider.usageKnown!==true))return attention(state,checkpoint,'missing_evidence',{message:'Jev packet lacks a reconciled provider receipt'});
  const next=requireToolDecision(state.packet,'afterPrepare','dispatch_builder');if(!next.ok)return attention(state,checkpoint,next.reason,{message:next.message});
  state.phase='prepared';await checkpoint(state);
 }
 const builderPacket={contract:state.packet.contract,requirements:state.packet.requirements,evidence:state.packet.evidence.filter(e=>e?.mandatory===true).map(({file,start,end,text})=>({file,start,end,text}))};
 const assignment=`${bounded(request.assignmentPrefix,2000)}${skillReferences(state.route)}\n\nTask contract and exact evidence:\n${bounded(JSON.stringify(builderPacket),9000)}\n\nImplement only within the authorized scope. Use this packet instead of exploratory rereads. Do not rerun registered tests in the builder; the controller runs them after completion. Report changed files and unresolved evidence concisely.`;
 state.builder??={};
 await runDispatch(tools,{title:request.title,target:request.target,prompt:assignment,model:state.route.model,effort:state.route.effort,useDefaultModel:state.route.source==='normal',direct:true,routedSelectionAuthorized:true},state.builder,async()=>checkpoint(state),onProgress,maxWaits);
 if(state.builder.phase==='needs_attention')return attention(state,checkpoint,'substantive_defect',{message:'Builder task failed',builderError:state.builder.error});
 if(state.builder.phase!=='complete'){state.phase='builder_executing';await checkpoint(state);return state;}
 try{state.builderUsage??=await account(services,state.builder.threadId,state.builder.executionTurnId);}catch(e){return attention(state,checkpoint,'missing_evidence',{message:e.message});}await checkpoint(state);
 const verifyDecision=requireToolDecision(state.packet,'afterBuilder','verify_registered');if(!verifyDecision.ok)return attention(state,checkpoint,verifyDecision.reason,{message:verifyDecision.message});
 if(!state.verification){
  state.phase='verification_pending';await checkpoint(state);
  const operationId=`${request.workflow.runId}-finish-1`;
  let verification;try{verification=decodeApp(await tools.mcp__jev_context__run_workflow_stage({workflowId:request.workflow.workflowId,runId:request.workflow.runId,mode:state.effectiveMode??(request.workflow.mode??'jev'),actionId:'finish',operationId,shareWithTypeSafe:(state.effectiveMode??request.workflow.mode??'jev')==='jev'&&request.shareWithTypeSafe===true}));}catch(e){return attention(state,checkpoint,'tests_failed',{message:e.message});}
  state.verification={status:verification.status,verified:verification.verified===true||(verification.status==='verified'&&verification.verification==='passed'),tests:verification.tests??verification.results??[],protectedChanges:verification.protectedChanges??verification.protectedChanged??[],failures:verification.failures??[],completionDecision:verification.completionDecision??null,reviewRoute:verification.reviewRoute??null,reviewEvidence:verification.reviewEvidence??[],completionErrors:verification.completionErrors??[]};
 if(!state.verification.verified)return attention(state,checkpoint,'tests_failed',{verification:state.verification});
  if(state.effectiveMode==='jev'){
   const decision=state.verification.completionDecision;
   if(state.verification.completionErrors.length||!decision?.actionId)return attention(state,checkpoint,'missing_evidence',{message:'Jev completion decision is missing or invalid'});
   if(decision.actionId==='stop_substantive_defect')return attention(state,checkpoint,'substantive_defect',{message:'Jev identified a substantive defect after tests'});
   if(decision.actionId==='complete'){
    state.review={qualityAcceptable:true,seriousDefects:[],missingEvidence:[],summary:'Jev completion gate accepted the exact final source and passed registered tests.',source:'jev-completion',confidence:decision.confidence};
    state.phase='complete';state.acceptance={testsPassed:true,reviewPassed:true,reviewSource:'jev-completion'};await checkpoint(state);return state;
   }
   if(decision.actionId!=='dispatch_reviewer')return attention(state,checkpoint,'substantive_defect',{message:`Unsupported Jev completion action ${decision.actionId}`});
   state.reviewRoute=embeddedReviewRoute(state.verification.reviewRoute,state.route);
  } else state.reviewRoute=state.route;
  if(!state.verification.reviewEvidence.length){
   try{state.verification.reviewEvidence=await captureReviewEvidence(tools,request.review.files);}catch(e){return attention(state,checkpoint,'missing_evidence',{message:e.message});}
  }
  state.phase='verified';await checkpoint(state);
 }
 if(!state.reviewPrompt)state.reviewPrompt=reviewPrompt(request,state.verification);
 state.reviewer??={};
 await runDispatch(tools,{title:request.review.title??`${request.title} review`,target:request.review.target??request.target,prompt:state.reviewPrompt+skillReferences(state.reviewRoute),model:state.reviewRoute.model,effort:state.reviewRoute.effort,useDefaultModel:state.reviewRoute.source==='normal',direct:true,routedSelectionAuthorized:true},state.reviewer,async()=>checkpoint(state),onProgress,maxWaits);
 if(state.reviewer.phase==='needs_attention')return attention(state,checkpoint,'missing_evidence',{message:'Reviewer task failed'});
 if(state.reviewer.phase!=='complete'){state.phase='review_executing';await checkpoint(state);return state;}
 try{state.reviewerUsage??=await account(services,state.reviewer.threadId,state.reviewer.executionTurnId);}catch(e){return attention(state,checkpoint,'missing_evidence',{message:e.message});}
 try{state.review=parseReview(state.reviewer.result);}catch(e){return attention(state,checkpoint,'missing_evidence',{message:e.message});}
 if(state.review.missingEvidence.length)return attention(state,checkpoint,'missing_evidence',{items:state.review.missingEvidence});
 if(!state.review.qualityAcceptable||state.review.seriousDefects.length)return attention(state,checkpoint,'substantive_defect',{items:state.review.seriousDefects});
 state.phase='complete';state.acceptance={testsPassed:true,reviewPassed:true};await checkpoint(state);return state;
}

// Desktop adapter: keeps checkpoints out of model context. Invoke once per
// unique job state file; do not run concurrent invocations for the same file.
export async function runDesktopJob(tools,job,stateFile,onProgress=()=>{},maxWaits=10){
 if(!/^[A-Za-z]:[\\/]/.test(stateFile))throw Error('Absolute Windows checkpoint path required');
 const q=s=>"'"+s.replaceAll("'","''")+"'";
 const read=await tools.exec_command({cmd:`if ([IO.File]::Exists(${q(stateFile)})) { [IO.File]::ReadAllText(${q(stateFile)}) } else { '{}' }`,max_output_tokens:12000});
 if(read.exit_code!==0)throw Error('Cannot read checkpoint');
 const state=JSON.parse(read.output);
 const signature=JSON.stringify([job.prompt,job.model,job.effort,job.target,!!job.direct]);
 if(state.jobSignature&&state.jobSignature!==signature)throw Error('Checkpoint belongs to a different assignment');
 state.jobSignature=signature;
 const checkpoint=async s=>{
  const result=await tools.exec_command({cmd:`[IO.File]::WriteAllText(${q(stateFile)}, ${q(JSON.stringify(s))}, [Text.UTF8Encoding]::new($false))`,max_output_tokens:100});
  if(result.exit_code!==0)throw Error('Checkpoint failed; reconcile existing task before retry');
 };
 return runDispatch(tools,job,state,checkpoint,onProgress,maxWaits);
}

export async function runDesktopRoutedWorkflow(tools,request,stateFile,services,onProgress=()=>{},maxWaits=10){
 if(!/^[A-Za-z]:[\\/]/.test(stateFile))throw Error('Absolute Windows checkpoint path required');
 const q=s=>"'"+s.replaceAll("'","''")+"'";
 const read=await tools.exec_command({cmd:`if ([IO.File]::Exists(${q(stateFile)})) { [IO.File]::ReadAllText(${q(stateFile)}) } else { '{}' }`,max_output_tokens:12000});
 if(read.exit_code!==0)throw Error('Cannot read checkpoint');const state=JSON.parse(read.output);
 const signature=JSON.stringify([request.contract,request.title,request.target,request.workflow,request.review]);
 if(state.requestSignature&&state.requestSignature!==signature)throw Error('Checkpoint belongs to a different routed workflow');state.requestSignature=signature;
 const checkpoint=async s=>{const result=await tools.exec_command({cmd:`[IO.File]::WriteAllText(${q(stateFile)}, ${q(JSON.stringify(s))}, [Text.UTF8Encoding]::new($false))`,max_output_tokens:100});if(result.exit_code!==0)throw Error('Checkpoint failed; reconcile before retry');};
 return runRoutedWorkflow(tools,request,state,checkpoint,services,onProgress,maxWaits);
}
