import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {cleanText} from './evidence.mjs';
import {createDecisionEngine, digest, estimateTokens} from './decision-engine.mjs';
import {boundedFailureState,diagnosticQuestions,deriveDiagnosticDecision,retrieveDiagnosticEvidence} from './failure-bridge.mjs';
import {persistentProviderBudget} from './provider-budget.mjs';
import {collectCompletedUsage} from './benchmark-control.mjs';

const safeId = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
const inside = (root, file) => {const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
const json = file => fs.readFile(file,'utf8').then(JSON.parse);
async function immutable(file, value) {await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});return file;}
// Buffer hashes must use the exact bytes, not a JSON representation.
const bytesHash = b => crypto.createHash('sha256').update(b).digest('hex');
const redactSource = text => text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,block=>block.split(/\r?\n/).map(()=>'[REDACTED_PRIVATE_KEY]').join('\n')).split(/\r?\n/).map(cleanText).join('\n');
export async function loadManifest(registration) {
  if (!registration?.path || !registration.sha256) throw new Error('Pinned workflow registration required');
  const bytes=await fs.readFile(registration.path);
  if(bytesHash(bytes)!==registration.sha256)throw new Error('Workflow manifest changed; explicit registration required');
  const manifest=JSON.parse(bytes),root=await fs.realpath(manifest.root);
  if(!Array.isArray(manifest.files)||!Array.isArray(manifest.requirements)||!manifest.contract||!manifest.actions?.verify?.length)throw new Error('Incomplete task contract');
  const ids=new Set();
  for(const f of manifest.files){
    if(!safeId(f.id)||ids.has(f.id)||typeof f.path!=='string'||path.isAbsolute(f.path)||f.path.split(/[\\/]/).includes('..')||/(^|[\\/])(?:\.env(?:\.|$)|\.git(?:[\\/]|$))|\.(?:pem|pfx|key|dpapi)$/i.test(f.path))throw new Error('Invalid or sensitive source registration');
    ids.add(f.id);
  }
  return {...manifest,root,manifestHash:registration.sha256};
}
async function sources(manifest) {
  return Promise.all(manifest.files.map(async entry=>{
    let file;
    try{file=await fs.realpath(path.join(manifest.root,entry.path));}catch(e){if(e.code==='ENOENT')return {...entry,missing:true};throw e;}
    if(!inside(manifest.root,file))throw new Error('Source escapes registered root');
    const stat=await fs.stat(file);if(!stat.isFile()||stat.size>2*1024*1024)throw new Error('Source is not a bounded text file');
    const bytes=await fs.readFile(file);if(bytes.includes(0))throw new Error('Binary source unsupported');
    return {...entry,file,sha256:bytesHash(bytes),text:redactSource(bytes.toString('utf8'))};
  }));
}
const hashes = entries => Object.fromEntries(entries.map(e=>[e.id,e.missing?null:e.sha256]));
function toolPlanQuestions(policy){
  if(!Array.isArray(policy.outerActions)||!policy.toolPlan||typeof policy.toolPlan!=='object')throw new Error('Registered tool plan required');
  const allowed=new Set(policy.outerActions);
  return Object.fromEntries(Object.entries(policy.toolPlan).map(([id,entry])=>{
    if(!safeId(id)||typeof entry?.instructions!=='string'||!entry.criteria||Object.keys(entry.criteria).some(action=>!allowed.has(action)))throw new Error('Invalid registered tool plan');
    return ['tool_'+id,{type:'choice',instructions:entry.instructions,criteria:entry.criteria}];
  }));
}
function completionQuestions(policy,requirements=[]){
  const gate=policy.completionGate,allowed=new Set(policy.outerActions||[]);
  if(typeof gate?.instructions!=='string'||!gate.criteria||Object.keys(gate.criteria).some(action=>!allowed.has(action))||!gate.reviewRoutes||!gate.atomicRisks)throw new Error('Registered completion gate required');
  const reviewCriteria=Object.fromEntries(Object.entries(gate.reviewRoutes).map(([id,route])=>{
    if(!safeId(id)||typeof route?.model!=='string'||typeof route?.effort!=='string'||typeof route?.description!=='string')throw new Error('Invalid registered review route');
    return [id,route.description];
  }));
  const risks=Object.fromEntries(Object.entries(gate.atomicRisks).map(([id,instructions])=>{
    if(!safeId(id)||typeof instructions!=='string'||!instructions.trim())throw new Error('Invalid atomic completion risk');
    return [`risk_${id}`,{type:'noul',instructions}];
  }));
  const requirementGaps=Object.fromEntries(requirements.slice(0,16).map((requirement,index)=>[
    `requirement_${index+1}_gap`,
    {type:'noul',instructions:`Is concrete final-source or registered-test evidence missing for this exact requirement: ${cleanText(requirement)}`}
  ]));
  return {
    completion_gate:{type:'choice',instructions:gate.instructions,criteria:gate.criteria},
    review_route:{type:'choice',instructions:'If bounded independent review is required, choose the lowest sufficient registered model and effort pair.',criteria:reviewCriteria},
    ...risks,
    ...requirementGaps
  };
}
export function deriveCompletionDecision({gate,answers={},errors=[],policy}){
  const minimum=Number.isFinite(policy.completionGate.minimumCompleteConfidence)?policy.completionGate.minimumCompleteConfidence:.8;
  const riskThreshold=Number.isFinite(policy.completionGate.atomicRiskThreshold)?policy.completionGate.atomicRiskThreshold:.5;
  const atomicRiskScores=Object.fromEntries(Object.entries(answers).filter(([id,answer])=>(id.startsWith('risk_')||/^requirement_\d+_gap$/.test(id))&&answer?.type==='noul').map(([id,answer])=>[id,answer.noul]));
  const atomicRiskFlags=Object.entries(atomicRiskScores).filter(([,score])=>score>=riskThreshold).map(([id])=>id);
  const reviewReasons=[];
  if(errors.length)reviewReasons.push('jev_completion_uncertainty');
  if(gate?.type!=='choice')reviewReasons.push('missing_completion_gate');
  if(gate?.choice==='complete'&&gate.confidence<minimum)reviewReasons.push('completion_confidence_below_threshold');
  if(atomicRiskFlags.length)reviewReasons.push(...atomicRiskFlags);
  let actionId=gate?.type==='choice'?gate.choice:'dispatch_reviewer';
  if(actionId==='complete'&&reviewReasons.length)actionId='dispatch_reviewer';
  if(actionId==='dispatch_reviewer'&&!reviewReasons.length)reviewReasons.push('jev_requested_independent_review');
  return {actionId,jevActionId:gate?.type==='choice'?gate.choice:null,confidence:gate?.type==='choice'?gate.confidence:null,probabilities:gate?.type==='choice'?gate.probabilities:null,minimumCompleteConfidence:minimum,atomicRiskThreshold:riskThreshold,atomicRiskScores,atomicRiskFlags,reviewReasons};
}
export function createWorkflow({settings, policy, apiKey, fetcher, execute=executeRegistered}) {
  const cfg=settings.workflow;
  if(!cfg?.enabled||!path.isAbsolute(cfg.artifactDirectory))throw new Error('Project-local workflow opt-in required');
  const engines=new Map();
  const reserveProviderRequest=persistentProviderBudget(cfg.limiterDirectory||path.join(cfg.artifactDirectory,'provider-budget'),{requestsPerMinute:policy.requestsPerMinute,maxRunInput:policy.maxProviderInputTokensPerRun});
  async function context(workflowId,runId,mode) {
    if(!safeId(workflowId)||!safeId(runId))throw new Error('Invalid registered ID');
    const registration=cfg.registrations?.[workflowId];if(!registration)throw new Error('Unsupported workflow ID');
    const manifest=await loadManifest(registration),dir=path.join(cfg.artifactDirectory,runId);
    await fs.mkdir(dir,{recursive:true});
    const identity={runId,workflowId,manifestHash:manifest.manifestHash,policyVersion:policy.version,policyHash:digest(policy),model:policy.model,mode};
    try{await immutable(path.join(dir,'identity.json'),identity);}catch(e){if(e.code!=='EEXIST')throw e;const old=await json(path.join(dir,'identity.json'));if(digest(old)!==digest(identity))throw new Error('Run identity changed; use a fresh run ID');}
    return {manifest,dir,identity};
  }
  function engine(ctx) {
    if(!engines.has(ctx.identity.runId))engines.set(ctx.identity.runId,createDecisionEngine({policy,apiKey,fetcher,cacheDirectory:path.join(ctx.dir,'cache'),schedulerEnabled:cfg.batchSchedulerEnabled===true,reserveProviderRequest,budgetRunId:ctx.identity.runId,recordReceipt:r=>immutable(path.join(ctx.dir,'receipts',r.id+'.json'),r)}));
    return engines.get(ctx.identity.runId);
  }
  async function prepare({workflowId,runId,mode='deterministic',maxExcerptChars=12000,shareWithTypeSafe=false,signal}) {
    if(!['deterministic','jev'].includes(mode)||!Number.isInteger(maxExcerptChars)||maxExcerptChars<1000||maxExcerptChars>24000)throw new Error('Invalid packet bounds');
    const ctx=await context(workflowId,runId,mode), entries=await sources(ctx.manifest), sourceHashes=hashes(entries);
    const exact=entries.filter(e=>!e.missing).flatMap(e=>{
      const lines=e.text.split(/\r?\n/),out=[];
      // Bounded original spans; mandatory files retain every span in the artifact.
      for(let start=0;start<lines.length;){let end=start+1;while(end<lines.length&&lines.slice(start,end+1).join('\n').length<6000)end++;
        out.push({id:`${e.id}_${start+1}`,sourceId:e.id,file:e.file,sha256:e.sha256,start:start+1,end,text:lines.slice(start,end).join('\n'),mandatory:!!e.mandatory||!!e.directlyReferenced||!!e.acceptance,builderVisible:e.acceptance!==true,acceptance:e.acceptance===true});start=end;}
      return out;
    });
    const judgments={},failures=[];
    if(mode==='jev') {
      // Context differs between bounded groups: queue requests in windows of four.
      const groups=[];let group=[];
      for(const item of exact){const proposed=[...group,item];if(estimateTokens({contract:ctx.manifest.contract,requirements:ctx.manifest.requirements,evidence:proposed})>10000&&group.length){groups.push(group);group=[];}group.push(item);}
      if(group.length)groups.push(group);
      for(let i=0;i<groups.length;i+=4) {
        const results=await Promise.all(groups.slice(i,i+4).map((evidence,offset)=>{
          const questions={...Object.fromEntries(evidence.flatMap(e=>[
            [e.id+'_rel',{type:'score',instructions:`${policy.templates.relevance} Source ID: ${e.id}`,criteria:['Unrelated','Relevant']}],
            [e.id+'_exists',{type:'noul',instructions:`${policy.templates.exists} Source ID: ${e.id}`}],
            [e.id+'_conflict',{type:'noul',instructions:`${policy.templates.conflict} Source ID: ${e.id}`}]
          ])),...(i+offset===0?toolPlanQuestions(policy):{})};
          return engine(ctx).evaluate({runId,state:{contract:cleanText(ctx.manifest.contract),requirements:ctx.manifest.requirements.map(cleanText),evidence},questions,sourceHashes,shareWithTypeSafe,signal});
        }));
        for(const result of results){Object.assign(judgments,result.answers);failures.push(...result.errors);}
      }
    }
    const candidates=[...exact].sort((a,b)=>Number(b.mandatory)-Number(a.mandatory)||(judgments[b.id+'_rel']?.score??0)-(judgments[a.id+'_rel']?.score??0));
    let used=0;const selected=[],omitted=[];
    for(const e of candidates){if(used+e.text.length<=maxExcerptChars){selected.push(e);used+=e.text.length;}else omitted.push({id:e.id,file:e.file,sha256:e.sha256,start:e.start,end:e.end,mandatory:e.mandatory});}
    const missing=entries.filter(e=>e.missing).map(e=>({id:e.id,path:e.path,mandatory:!!e.mandatory||!!e.directlyReferenced||!!e.acceptance}));
    const toolPlan=Object.fromEntries(Object.keys(policy.toolPlan).map(id=>{const answer=judgments['tool_'+id];return [id,answer?.type==='choice'?{actionId:answer.choice,confidence:answer.confidence,probabilities:answer.probabilities}:null];}));
    const needsRetrieval=omitted.some(e=>e.mandatory)||missing.length>0;
    const artifact=await immutable(path.join(ctx.dir,`packet-${crypto.randomUUID()}.json`),{...ctx.identity,createdAt:new Date().toISOString(),sourceHashes,contract:ctx.manifest.contract,requirements:ctx.manifest.requirements,allEvidence:exact,selected,omitted,missing,toolPlan,judgments,failures});
    const flags=exact.filter(e=>(judgments[e.id+'_conflict']?.noul??0)>=policy.thresholds.conflict||(judgments[e.id+'_exists']?.noul??1)<.5).map(e=>({evidenceId:e.id,sourceId:e.sourceId,start:e.start,end:e.end,conflict:judgments[e.id+'_conflict']?.noul??null,support:judgments[e.id+'_exists']?.noul??null}));
    return {...ctx.identity,status:needsRetrieval?'needs_evidence':failures.length?'needs_review':'prepared',contract:ctx.manifest.contract,requirements:ctx.manifest.requirements,sourceHashes,selected,omitted,missing,toolPlan,artifact,failures,advisoryFlags:flags.slice(0,20),additionalFlagCount:Math.max(0,flags.length-20),warning:'Jev selects only registered workflow actions and skills. Deterministic schemas, permissions, tests and independent review remain mandatory.'};
  }
  async function stage({workflowId,runId,actionId,operationId,mode='deterministic',expectedSourceHashes,shareWithTypeSafe=false,signal}) {
    if(!safeId(operationId)||!['inspect','verify','report'].includes(actionId)||!policy.actions.includes(actionId))throw new Error('Unsupported action or operation ID');
    const ctx=await context(workflowId,runId,mode);
    if(actionId==='inspect')return prepare({workflowId,runId,mode,shareWithTypeSafe,signal});
    if(actionId==='report')return report({workflowId,runId,mode});
    const file=path.join(ctx.dir,'stages',operationId+'.json');
    try{const prior=await json(file);if(prior.actionId!==actionId)throw new Error('Operation identity mismatch');return prior;}catch(e){if(e.code!=='ENOENT')throw e;}
    await immutable(path.join(ctx.dir,'stages',operationId+'.started.json'),{...ctx.identity,actionId,operationId,startedAt:new Date().toISOString()});
    const before=await sources(ctx.manifest), beforeHashes=hashes(before);
    if(!expectedSourceHashes||digest(beforeHashes)!==digest(expectedSourceHashes))throw new Error('Missing or stale source hashes; retrieve current evidence');
    const protectedChanged=before.filter(e=>(e.missing&&(e.mandatory||e.directlyReferenced||e.acceptance))||(e.acceptance&&(!e.frozenHash||e.sha256!==e.frozenHash))).map(e=>e.id);
    const results=[];
    if(!protectedChanged.length)for(const operation of ctx.manifest.actions.verify){
      signal?.throwIfAborted();
      if(!safeId(operation.id)||!path.isAbsolute(operation.executable)||!Array.isArray(operation.args)||operation.args.some(a=>typeof a!=='string'))throw new Error('Invalid registered command');
      const executable=await fs.realpath(operation.executable);
      if(!cfg.allowedExecutables?.some(p=>path.resolve(p).toLowerCase()===executable.toLowerCase()))throw new Error('Executable not registered');
      const logfile=path.join(ctx.dir,'stages',`${operationId}-${operation.id}.log`);
      results.push({id:operation.id,...await execute({...operation,executable,cwd:ctx.manifest.root,logfile,signal})});
    }
    const afterHashes=hashes(await sources(ctx.manifest));
    const passed=!protectedChanged.length&&results.length===ctx.manifest.actions.verify.length&&results.every(r=>r.exitCode===0&&!r.interrupted&&!r.timedOut)&&digest(beforeHashes)===digest(afterHashes);
    const result={...ctx.identity,actionId,operationId,finishedAt:new Date().toISOString(),beforeHashes,afterHashes,protectedChanged,results,status:passed?'passed':'failed'};
    const reviewEvidence=passed?before.filter(e=>!e.missing&&e.review!==false&&(e.mandatory||e.directlyReferenced||e.acceptance)).map(({id,file,sha256,text})=>({id,file,sha256,text})):[];
    if(reviewEvidence.reduce((total,e)=>total+e.text.length,0)>40000)throw new Error('Verified review evidence exceeds the registered compact-context limit');
    if(passed)result.reviewEvidence=reviewEvidence;
    if(passed&&mode==='jev'){
      const decision=await engine(ctx).evaluate({runId,state:{contract:cleanText(ctx.manifest.contract),requirements:ctx.manifest.requirements.map(cleanText),tests:results.map(({id,exitCode,timedOut,interrupted})=>({id,exitCode,timedOut,interrupted})),finalSource:reviewEvidence},questions:completionQuestions(policy,ctx.manifest.requirements),sourceHashes:afterHashes,shareWithTypeSafe,signal});
      const gate=decision.answers.completion_gate,route=decision.answers.review_route,selectedRoute=route?.type==='choice'?policy.completionGate.reviewRoutes[route.choice]:null;
      result.completionDecision=deriveCompletionDecision({gate,answers:decision.answers,errors:decision.errors,policy});
      result.reviewRoute=selectedRoute?{routeId:route.choice,model:selectedRoute.model,effort:selectedRoute.effort,confidence:route.confidence,probabilities:route.probabilities}:null;
      result.completionErrors=decision.errors;
    } else if(!passed&&mode==='jev'&&results.length){
      const failureState=await boundedFailureState(results);
      result.advisory=await engine(ctx).evaluate({runId,state:failureState,questions:diagnosticQuestions(policy),sourceHashes:afterHashes,shareWithTypeSafe,signal});
      const decision=deriveDiagnosticDecision(result.advisory,policy);
      if(decision.status==='selected'){
        const retrieval=await retrieveDiagnosticEvidence(results,decision.actionId);
        const complete=retrieval.status==='found'&&retrieval.omittedFailedTests===0&&retrieval.evidence.every(e=>e.excerpts.length>0);
        result.diagnostic=complete?{...decision,retrieval}:{...decision,status:'escalate',actionId:null,reason:'selected_evidence_incomplete',retrieval};
      } else result.diagnostic=decision;
    }
    await immutable(file,result);return {...result,artifact:file};
  }
  async function report({workflowId,runId,mode='deterministic'}) {
    const ctx=await context(workflowId,runId,mode), current=hashes(await sources(ctx.manifest));
    const readDir=async sub=>{const dir=path.join(ctx.dir,sub);return Promise.all((await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>n.endsWith('.json')).map(n=>json(path.join(dir,n))));};
    const receipts=await readDir('receipts'),stages=await readDir('stages');
    const seen=new Map();for(const r of receipts){if(r.runId!==runId||r.policyVersion!==policy.version||r.requestedModel!==policy.model||typeof r.id!=='string'||!r.usage||!['failed','cache','coalesced','provider'].includes(r.status))throw new Error('Invalid provider receipt identity');if(seen.has(r.id)&&digest(seen.get(r.id))!==digest(r))throw new Error('Conflicting duplicate provider receipt');seen.set(r.id,r);}
    const unique=[...seen.values()],known=n=>unique.every(r=>Number.isSafeInteger(r.usage[n]))?unique.reduce((v,r)=>v+r.usage[n],0):null;
    for(const s of stages)if(s.runId!==runId||s.workflowId!==workflowId||s.manifestHash!==ctx.identity.manifestHash||s.policyHash!==ctx.identity.policyHash||s.actionId!=='verify')throw new Error('Invalid stage identity');
    const completed=stages.filter(s=>s.finishedAt),pending=stages.filter(s=>s.startedAt&&!completed.some(c=>c.operationId===s.operationId));
    const latest=completed.sort((a,b)=>a.finishedAt.localeCompare(b.finishedAt)).at(-1);
    const verified=!pending.length&&latest?.status==='passed'&&digest(latest.afterHashes)===digest(current);
    const registrations=cfg.usageRegistrations?.[runId]||[];
    const turnReports=await Promise.all(registrations.map(r=>collectCompletedUsage(r.file,r.sessionId,r.turnIds||[])));
    const usageComplete=turnReports.length>0&&turnReports.every(r=>r.reconciled);
    const codexUsage={status:usageComplete?'registered_turns_reconciled':'requires_completed_turn_records',rawTokens:usageComplete?turnReports.reduce((s,r)=>s+r.rawTokens,0):null,turnReports,scope:'Only registered turns; coordinator and reviewer allocations must also be registered or explicitly added before a complete-task claim.'};
    if(turnReports.length)codexUsage.receipt=await immutable(path.join(ctx.dir,'codex-usage-'+crypto.randomUUID()+'.json'),{...ctx.identity,recordedAt:new Date().toISOString(),...codexUsage});
    return {...ctx.identity,currentSourceHashes:current,verification:verified?'passed':'unproved',independentReview:'pending',acceptance:'not_established',pendingOperations:pending.map(s=>s.operationId),stages:completed.map(s=>({operationId:s.operationId,status:s.status,results:s.results})),provider:{receipts:unique.length,inputTokens:known('input_tokens'),outputTokens:known('output_tokens'),unknownUsageReceipts:unique.filter(r=>r.usage.input_tokens===null||r.usage.output_tokens===null).map(r=>r.id),cacheHits:unique.filter(r=>r.status==='cache').length},codexUsage,artifactDirectory:ctx.dir};
  }
  return {prepare_work_packet:prepare,run_workflow_stage:stage,get_run_report:report};
}

export async function executeRegistered({executable,args,cwd,logfile,timeoutMs=120000,signal}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Invalid operation timeout');
  const log=await fs.open(logfile,'wx');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC|NODE_PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(k)));
  const start=Date.now();let timedOut=false,interrupted=false;
  try{return await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
    const stop=()=>{if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGKILL');};
    const abort=()=>{interrupted=true;stop();};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.on('error',e=>{cleanup();reject(e);});
    child.on('close',(exitCode,terminationSignal)=>{cleanup();resolve({exitCode,terminationSignal,timedOut,interrupted,elapsedMs:Date.now()-start,logfile});});
  });}finally{await log.close();}
}
