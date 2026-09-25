import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {createReadStream} from 'node:fs';
import {digest} from './decision-engine.mjs';
const allocations={pilot:2000000,confirmation:5000000,reserve:1000000};
export async function reserveBenchmark(directory,{id,stage,tokens}) {
 if(!/^[\w-]{1,100}$/.test(id)||!Object.hasOwn(allocations,stage)||!Number.isSafeInteger(tokens)||tokens<1)throw new Error('Invalid benchmark reservation');
 await fs.mkdir(directory,{recursive:true});const lock=await fs.open(path.join(directory,'budget.lock'),'wx');
 try{const file=path.join(directory,'budget.json');let ledger;try{ledger=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;ledger={totalLimit:8000000,allocations,platformHardTokenCap:false,runs:[]};}
 const existing=ledger.runs.find(r=>r.id===id);if(existing){if(existing.stage!==stage||existing.reservedTokens!==tokens)throw new Error('Reservation identity mismatch');return existing;}
 const committed=ledger.runs.filter(r=>r.stage===stage).reduce((s,r)=>s+(r.actualTokens??r.reservedTokens),0);
 const total=ledger.runs.reduce((s,r)=>s+(r.actualTokens??r.reservedTokens),0);
 if(committed+tokens>allocations[stage]||total+tokens>8000000)throw new Error('Benchmark budget reservation exceeds remaining allocation');
 const entry={id,stage,reservedTokens:tokens,actualTokens:null,status:'reserved',createdAt:new Date().toISOString()};ledger.runs.push(entry);
 await fs.writeFile(file,JSON.stringify(ledger,null,2));return entry;
 }finally{await lock.close();await fs.unlink(path.join(directory,'budget.lock'));}
}
export async function settleBenchmark(directory,id,rawTokens) {
 if(!Number.isSafeInteger(rawTokens)||rawTokens<0)throw new Error('Completed reconciled token count required');
 const lock=await fs.open(path.join(directory,'budget.lock'),'wx');
 try{const file=path.join(directory,'budget.json'),ledger=JSON.parse(await fs.readFile(file,'utf8')),entry=ledger.runs.find(r=>r.id===id);if(!entry)throw new Error('Unreserved run');if(entry.actualTokens!==null&&entry.actualTokens!==rawTokens)throw new Error('Conflicting settlement');entry.actualTokens=rawTokens;entry.status=rawTokens>entry.reservedTokens?'over_reservation':'settled';await fs.writeFile(file,JSON.stringify(ledger,null,2));return entry;}finally{await lock.close();await fs.unlink(path.join(directory,'budget.lock'));}
}
export async function correctBenchmarkSettlement(directory,id,rawTokens,{reason,evidence}={}) {
 if(!Number.isSafeInteger(rawTokens)||rawTokens<0||typeof reason!=='string'||!reason.trim()||typeof evidence!=='string'||!evidence.trim())throw new Error('Audited settlement correction requires tokens, reason and evidence');
 const lock=await fs.open(path.join(directory,'budget.lock'),'wx');
 try{const file=path.join(directory,'budget.json'),ledger=JSON.parse(await fs.readFile(file,'utf8')),entry=ledger.runs.find(r=>r.id===id);if(!entry||entry.actualTokens===null)throw new Error('Only a settled run can be corrected');if(entry.actualTokens===rawTokens)return entry;const correction={from:entry.actualTokens,to:rawTokens,reason:reason.trim(),evidence:evidence.trim(),correctedAt:new Date().toISOString()};entry.corrections??=[];entry.corrections.push(correction);entry.actualTokens=rawTokens;entry.status=rawTokens>entry.reservedTokens?'over_reservation':'settled_corrected';await fs.writeFile(file,JSON.stringify(ledger,null,2));return entry;}finally{await lock.close();await fs.unlink(path.join(directory,'budget.lock'));}
}
export async function collectCompletedUsage(file,sessionId,turnIds=[]) {
 const requested=new Set(turnIds),events=new Map(),turns=new Map(),issues=[];let identity=null;
 const bucket=id=>{if(!turns.has(id))turns.set(id,{id,completed:false,input:0,output:0,requests:0,reported:null,configuration:null});return turns.get(id);};
 for await(const line of readline.createInterface({input:createReadStream(file),crlfDelay:Infinity})){
  if(!line.trim())continue;let row;try{row=JSON.parse(line);}catch{issues.push('Malformed event');continue;}const p=row.payload;
  if(row.type==='session_meta'){identity=p.id;if(identity!==sessionId)throw new Error('Session identity mismatch');}
  if(requested.size&&!requested.has(p?.turn_id))continue;
  if(row.type==='turn_context'&&p.turn_id)bucket(p.turn_id).configuration={model:p.model??null,effort:p.effort??null,observedServiceTier:p.service_tier??null};
  if(row.type==='event_msg'&&p.turn_id){if(p.type==='task_started')bucket(p.turn_id).completed=false;if(['task_complete','task_completed'].includes(p.type))bucket(p.turn_id).completed=true;}
  if(row.type==='token_usage_record'){
   if(!p.response_id||!p.turn_id){issues.push('Missing response or turn ID');continue;}
   const event={turnId:p.turn_id,usage:p.usage,reported:p.turn_token_usage};
   if(events.has(p.response_id)){if(digest(events.get(p.response_id))!==digest(event))issues.push('Conflicting duplicate usage event');continue;}events.set(p.response_id,event);
   const u=p.usage;if(!Number.isSafeInteger(u?.input_tokens)||u.input_tokens<0||!Number.isSafeInteger(u?.output_tokens)||u.output_tokens<0||u.total_tokens!==u.input_tokens+u.output_tokens){issues.push('Invalid usage');continue;}
   const b=bucket(p.turn_id);b.input+=u.input_tokens;b.output+=u.output_tokens;b.requests++;b.reported=p.turn_token_usage;
  }
 }
 if(identity!==sessionId)throw new Error('Missing session identity');
 for(const id of requested)if(!turns.has(id))issues.push('Missing selected turn');
 for(const t of turns.values()){if(!t.completed)issues.push('Incomplete turn');if(!t.requests||t.input!==t.reported?.input_tokens||t.output!==t.reported?.output_tokens)issues.push('Unreconciled turn');if(!t.configuration?.model||!t.configuration?.effort)issues.push('Missing model or effort');}
 const records=[...turns.values()],rawTokens=issues.length?null:records.reduce((s,t)=>s+t.input+t.output,0);
 return {sessionId,turns:records,rawTokens,requests:records.reduce((s,t)=>s+t.requests,0),reconciled:rawTokens!==null&&records.length>0,issues:[...new Set(issues)],configurationEvidenceMissing:records.some(t=>!t.configuration?.observedServiceTier)?['Observed service tier unavailable; configured tier must be recorded separately']:[]};
}
export function evaluatePairs(pairs,{sharedRawTokens=0,investmentRawTokens=null}={}) {
 if(!Number.isSafeInteger(sharedRawTokens)||sharedRawTokens<0||(investmentRawTokens!==null&&(!Number.isSafeInteger(investmentRawTokens)||investmentRawTokens<0)))throw new Error('Nonnegative integer overhead and investment required');
 const limitations=[],categories={};
 if(pairs.length!==6)limitations.push('Six frozen matched pairs required');
 const valid=pairs.every(p=>Number.isSafeInteger(p.baselineTokens)&&p.baselineTokens>0&&Number.isSafeInteger(p.optimizedTokens)&&p.optimizedTokens>=0&&p.reconciled===true&&p.qualityPassed===true&&p.blindedReviewPassed===true&&p.configurationMatched===true);
 if(!valid)limitations.push('Acceptance, configuration, blinded review or accounting gate failed');
 const share=pairs.length?sharedRawTokens/(pairs.length*2):0;
 const reductions=pairs.map(p=>1-(p.optimizedTokens+share)/(p.baselineTokens+share)).sort((a,b)=>a-b);
 const baseline=pairs.reduce((s,p)=>s+p.baselineTokens+share,0),optimized=pairs.reduce((s,p)=>s+p.optimizedTokens+share,0);
 for(const p of pairs){categories[p.category]??={baseline:0,optimized:0,count:0};categories[p.category].baseline+=p.baselineTokens+share;categories[p.category].optimized+=p.optimizedTokens+share;categories[p.category].count++;}
 const pooledReduction=1-optimized/baseline,medianReduction=reductions.length%2?reductions[Math.floor(reductions.length/2)]:(reductions[reductions.length/2-1]+reductions[reductions.length/2])/2;
 const categoryGate=['feature','bugfix','maintenance'].every(c=>categories[c]?.count===2&&categories[c].optimized<categories[c].baseline);
 return {passed:valid&&pairs.length===6&&categoryGate&&pooledReduction>=.6&&medianReduction>=.6,pooledReduction,medianReduction,categories,baselineTokens:baseline,optimizedTokens:optimized,limitations,investmentRawTokens,breakEvenTasks:investmentRawTokens!==null&&baseline>optimized?Math.ceil(investmentRawTokens/((baseline-optimized)/pairs.length)):null};
}
export async function makeBlindCopies(candidates,directory) {
 const shuffled=[...candidates];for(let i=shuffled.length-1;i>0;i--){const j=crypto.randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
 const mapping=[];for(let i=0;i<shuffled.length;i++){const label=`candidate-${String(i+1).padStart(2,'0')}`,destination=path.join(directory,label);await fs.mkdir(destination,{recursive:true});for(const rel of shuffled[i].files){if(path.isAbsolute(rel)||rel.split(/[\\/]/).includes('..'))throw new Error('Unsafe candidate path');const target=path.join(destination,rel);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(shuffled[i].root,rel),target);}mapping.push({label,id:shuffled[i].id});}return mapping;
}
