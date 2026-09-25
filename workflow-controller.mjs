import fs from 'node:fs/promises';
import {cleanText} from './evidence.mjs';

// Composition stays inside the existing runner. Model-facing pass path:
// prepare -> implement -> finish. Accounting and source checks stay in code.
function providerSummary(provider) {
  return {receipts:provider.receipts,inputTokens:provider.inputTokens,outputTokens:provider.outputTokens,cacheHits:provider.cacheHits,usageKnown:provider.unknownUsageReceipts.length===0};
}
export function compactPacket(packet, report) {
  return {
    status:packet.status,workflowId:packet.workflowId,runId:packet.runId,
    contract:packet.contract,requirements:packet.requirements,
    toolPlan:packet.toolPlan,
    selected:packet.selected.map(({id,file,sha256,start,end,text,mandatory,builderVisible,acceptance})=>({id,file,sha256,start,end,text,mandatory,builderVisible,acceptance})),
    missing:packet.missing,
    // Retain every mandatory retrieval reference. Optional inventory stays local.
    requiredRetrieval:packet.omitted.filter(e=>e.mandatory),
    optionalOmittedCount:packet.omitted.filter(e=>!e.mandatory).length,
    advisoryFlags:packet.advisoryFlags||[],failures:packet.failures,
    provider:providerSummary(report.provider),artifact:packet.artifact,
    next:packet.status==='prepared'?'Implement, then call run_workflow_stage with actionId finish once. No receipt or hash-report inspection is needed.':'Resolve missing evidence or provider failures before implementation.'
  };
}
async function logTail(file,maxBytes) {
  let handle;
  try{handle=await fs.open(file,'r');const {size}=await handle.stat(),start=Math.max(0,size-maxBytes),buffer=Buffer.alloc(size-start);const {bytesRead}=await handle.read(buffer,0,buffer.length,start);return {file,startByte:start,endByte:start+bytesRead,text:cleanText(buffer.subarray(0,bytesRead).toString('utf8'))};}
  catch(e){return {file,error:['ENOENT','EACCES','EPERM'].includes(e.code)?e.code:'Log unavailable'};}
  finally{await handle?.close();}
}
export function createWorkflowController(workflow) {
  return {
    async prepare_work_packet(input) {
      const packet=await workflow.prepare_work_packet(input);
      const report=await workflow.get_run_report(input);
      return compactPacket(packet,report);
    },
    async finish_work_packet(input) {
      if(!input.operationId)throw new Error('An explicit operation ID is required for safe retries');
      // Fresh hashes are captured locally, then rechecked by the existing stage.
      // Caller paths/commands or caller-supplied hashes cannot replace this check.
      const before=await workflow.get_run_report(input);
      const stage=await workflow.run_workflow_stage({...input,actionId:'verify',expectedSourceHashes:before.currentSourceHashes});
      const report=await workflow.get_run_report(input);
      const passed=stage.status==='passed'&&report.verification==='passed';
      const failed=stage.results.filter(r=>r.exitCode!==0||r.interrupted||r.timedOut);
      const focused=!passed&&stage.diagnostic?.status==='selected';
      const failures=passed||focused?[]:await Promise.all(failed.slice(0,4).map(async r=>({id:r.id,exitCode:r.exitCode,timedOut:r.timedOut,interrupted:r.interrupted,...await logTail(r.logfile,1000)})));
      return {
        workflowId:input.workflowId,runId:input.runId,operationId:input.operationId,
        status:passed?'verified':'needs_repair',
        verification:report.verification,
        tests:stage.results.map(({id,exitCode,timedOut,interrupted})=>({id,exitCode,timedOut,interrupted})),
        protectedChanged:stage.protectedChanged,failures,additionalFailedOperations:Math.max(0,failed.length-4),
        diagnostic:stage.diagnostic||null,
        pendingOperations:report.pendingOperations,
        advisory:stage.advisory?{status:stage.advisory.status,answers:stage.advisory.answers,errors:stage.advisory.errors}:null,
        completionDecision:stage.completionDecision||null,
        reviewRoute:stage.reviewRoute||null,
        reviewEvidence:stage.reviewEvidence||[],
        completionErrors:stage.completionErrors||[],
        provider:providerSummary(report.provider),
        codexUsage:{status:report.codexUsage.status,rawTokens:report.codexUsage.rawTokens},
        independentReview:report.independentReview,acceptance:report.acceptance,
        artifact:stage.artifact||report.artifactDirectory,
        next:passed?(stage.completionDecision?.actionId==='complete'?'Required verification and Jev completion review passed.':'Follow the registered completion decision; no extra status call is needed.'):(focused?'Repair from the exact diagnostic log excerpts, then verify with a new operation ID.':'Inspect the failure packet or retrieve missing evidence, repair, then verify with a new operation ID.')
      };
    }
  };
}
