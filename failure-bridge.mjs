import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {cleanText} from './evidence.mjs';

const patterns={
  inspect_assertion:/\b(?:AssertionError|assertion|expected|actual|not equal|failed test|test failed|FAIL)\b|\bat\s+\S+:\d+/i,
  inspect_environment:/\b(?:ENOENT|EACCES|EPERM|MODULE_NOT_FOUND|ECONN\w*|dependency|permission|certificate|spawn|not found)\b/i,
  inspect_timeout:/\b(?:timeout|timed out|interrupted|cancelled|canceled|SIGTERM|SIGKILL)\b/i
};

export function diagnosticQuestions(policy) {
  const rules=policy.failureBridge;
  if(!rules||!Number.isFinite(rules.minimumActionConfidence)||!Number.isFinite(rules.missingEvidenceThreshold)||
      !rules.actions||Object.keys(rules.actions).some(id=>!Object.hasOwn(patterns,id)))throw new Error('Invalid registered failure bridge policy');
  return {
    diagnostic_action:{type:'choice',instructions:rules.actionInstruction,criteria:{...rules.actions,escalate:'No registered retrieval is justified; send the failure to Codex.'}},
    missing_evidence:{type:'noul',instructions:rules.missingEvidenceInstruction}
  };
}

export function deriveDiagnosticDecision(result,policy) {
  const rules=policy.failureBridge,choice=result?.answers?.diagnostic_action,missing=result?.answers?.missing_evidence;
  const base={status:'escalate',actionId:null,confidence:choice?.confidence??null,missingEvidence:missing?.noul??null,
    reason:'provider_unavailable_or_invalid'};
  if(result?.status!=='complete'||choice?.type!=='choice'||missing?.type!=='noul')return base;
  if(choice.choice==='escalate')return {...base,reason:'jev_requested_escalation'};
  if(!Object.hasOwn(rules.actions,choice.choice))return {...base,reason:'unregistered_action'};
  const confidence=Math.min(choice.confidence,choice.probabilities?.[choice.choice]??0);
  if(confidence<rules.minimumActionConfidence)return {...base,confidence,reason:'low_confidence'};
  if(missing.noul>=rules.missingEvidenceThreshold)return {...base,confidence,reason:'missing_evidence'};
  return {...base,status:'selected',actionId:choice.choice,confidence,reason:'registered_read_only_retrieval'};
}

// Keep both the provider state and the eventual repair packet bounded. Only failed
// registered test logs are read; Jev never supplies a path, command or selector.
export async function boundedFailureState(results,maxChars=4500) {
  const failed=results.filter(r=>r.exitCode!==0||r.timedOut||r.interrupted);
  const tests=failed.map(({id,exitCode,timedOut,interrupted})=>({id,exitCode,timedOut,interrupted}));
  const perLog=Math.max(500,Math.floor(maxChars/Math.max(1,Math.min(failed.length,4))));
  const output=[];
  for(const r of failed.slice(0,4)){
    try{const handle=await fs.open(r.logfile,'r');try{const {size}=await handle.stat(),start=Math.max(0,size-perLog),bytes=Buffer.alloc(size-start);const {bytesRead}=await handle.read(bytes,0,bytes.length,start);output.push({id:r.id,tailStartByte:start,text:cleanText(bytes.subarray(0,bytesRead).toString('utf8')).slice(-perLog)});}finally{await handle.close();}}
    catch(e){output.push({id:r.id,error:['ENOENT','EACCES','EPERM'].includes(e.code)?e.code:'Log unavailable'});}
  }
  return {tests,output,omittedFailedTests:Math.max(0,failed.length-4)};
}

export async function retrieveDiagnosticEvidence(results,actionId,{maxBytes=65536,maxChars=5000}={}) {
  const pattern=patterns[actionId];
  if(!pattern)throw new Error('Unsupported registered diagnostic action');
  const failed=results.filter(r=>r.exitCode!==0||r.timedOut||r.interrupted);
  const evidence=[];let used=0;
  for(const r of failed.slice(0,4)){
    let handle;
    try{
      handle=await fs.open(r.logfile,'r');const {size}=await handle.stat(),startByte=Math.max(0,size-maxBytes),buffer=Buffer.alloc(size-startByte);
      const {bytesRead}=await handle.read(buffer,0,buffer.length,startByte),tail=buffer.subarray(0,bytesRead);
      const lines=cleanText(tail.toString('utf8')).split(/\r?\n/),hits=[];
      for(let i=0;i<lines.length&&hits.length<3;i++)if(pattern.test(lines[i]))hits.push(i);
      const excerpts=[];
      for(const hit of hits){const start=Math.max(0,hit-1),end=Math.min(lines.length,hit+3),text=lines.slice(start,end).map((line,j)=>`${start+j+1}: ${line}`).join('\n');
        if(used+text.length>maxChars)break;used+=text.length;excerpts.push({tailLineStart:start+1,tailLineEnd:end,text});}
      evidence.push({testId:r.id,file:r.logfile,tailStartByte:startByte,tailSha256:crypto.createHash('sha256').update(tail).digest('hex'),excerpts});
    }catch(e){evidence.push({testId:r.id,file:r.logfile,error:['ENOENT','EACCES','EPERM'].includes(e.code)?e.code:'Log unavailable',excerpts:[]});}
    finally{await handle?.close();}
  }
  return {status:evidence.some(x=>x.excerpts.length)?'found':'missing',actionId,evidence,omittedFailedTests:Math.max(0,failed.length-4)};
}
