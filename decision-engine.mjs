import crypto from 'node:crypto';
import {getEncoding} from 'js-tiktoken';
import {createCachedFetch} from './cached-fetch.mjs';
import {validateQuestion, normalizeResponse} from './decision-types.mjs';
const encoding = getEncoding('o200k_base');
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const estimateTokens = value => encoding.encode(JSON.stringify(value)).length;
export function splitQuestions(state, questions, policy) {
  const batches = []; let pending = {};
  for (const [id, q] of Object.entries(questions)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid question ID');
    validateQuestion(q);
    if (estimateTokens({state:JSON.stringify(state), question:q}) > policy.maxStateAndQuestionTokens) throw new Error('State plus question exceeds context limit');
    const proposed = {...pending, [id]:q};
    if (Object.keys(proposed).length > policy.maxQuestions || estimateTokens({model:policy.model,state:JSON.stringify(state),questions:proposed}) > policy.maxInputTokens) {
      if (Object.keys(pending).length) batches.push(pending);
      pending = {[id]:q};
      if (estimateTokens({model:policy.model,state:JSON.stringify(state),questions:pending}) > policy.maxInputTokens) throw new Error('A single question exceeds batch context limit');
    } else pending = proposed;
  }
  if (Object.keys(pending).length) batches.push(pending);
  return batches;
}
export function createDecisionEngine({policy, apiKey, cacheDirectory, fetcher=fetch, recordReceipt=async()=>{}, schedulerEnabled=false, reserveProviderRequest, budgetRunId, sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  if (!policy.version || policy.model !== 'jev-1.13.0' || !Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency < 1 || policy.maxConcurrency > 4 || !Number.isInteger(policy.maxQuestions) || policy.maxQuestions < 1 || policy.maxQuestions > 64 || policy.maxInputTokens < 1 || policy.maxInputTokens > 24000 || policy.maxStateAndQuestionTokens > 32000 || !Number.isInteger(policy.maxThrottleRetries) || policy.maxThrottleRetries < 0 || policy.maxThrottleRetries > 2) throw new Error('Invalid bounded policy');
  if (policy.requestsPerMinute !== 6 && !schedulerEnabled) throw new Error('New spending limit requires explicit scheduler opt-in');
  const times=[], reserved=new Map(), queue=[]; let active=0;
  const schedule=fn=>new Promise((resolve,reject)=>{queue.push({fn,resolve,reject});pump();});
  function pump(){while(active<(schedulerEnabled?policy.maxConcurrency:1)&&queue.length){const x=queue.shift();active++;Promise.resolve().then(x.fn).then(x.resolve,x.reject).finally(()=>{active--;pump();});}}
  const reserve=()=>{const now=Date.now();while(times.length&&times[0]<=now-60000)times.shift();if(times.length>=policy.requestsPerMinute)return false;times.push(now);return true;};
  const cached=createCachedFetch({directory:cacheDirectory,fetcher,namespace:digest(policy),legacy:false,reserve:async({request,runId})=>reserve()&&(!reserveProviderRequest||await reserveProviderRequest({runId:budgetRunId??runId,estimatedInputTokens:estimateTokens(request)}))});
  return {async evaluate({runId,state,questions,sourceHashes={},shareWithTypeSafe=false,signal}) {
    if (!runId) throw new Error('Run ID required');
    if (!shareWithTypeSafe || !apiKey) return {status:'needs_review',answers:{},receipts:[],errors:['Provider authorization or credential unavailable']};
    const shared={evidence:state,sourceHashes}, batches=splitQuestions(shared,questions,policy);
    const results=await Promise.allSettled(batches.map((qs,index)=>schedule(async()=>{
      const request={model:policy.model,state:JSON.stringify(shared),questions:qs};
      const receipt={id:crypto.randomUUID(),runId,batch:index,policyVersion:policy.version,requestedModel:policy.model,sourceHashes,requestHash:digest(request),estimatedInputTokens:estimateTokens(request),startedAt:new Date().toISOString(),status:'failed',usage:{input_tokens:null,output_tokens:null},attempts:[]};
      const start=Date.now();
      try {
        if (receipt.estimatedInputTokens>policy.maxInputTokens) throw new Error('Encoded request exceeds context limit');
        for(let attempt=0;;attempt++) {
          signal?.throwIfAborted();
          const next=(reserved.get(runId)||0)+receipt.estimatedInputTokens;
          if(next>policy.maxProviderInputTokensPerRun)throw new Error('Conservative run input reservation exhausted');
          reserved.set(runId,next);
          const response=await cached('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(request),reservationRunId:runId,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(policy.timeoutMs)]):AbortSignal.timeout(policy.timeoutMs)});
          receipt.attempts.push({httpStatus:response.status,providerRequestId:response.headers.get('x-request-id'),localLimit:response.headers.get('x-local-limit')==='true'});
          if(response.status===429&&response.headers.get('x-local-limit')!=='true'&&attempt<policy.maxThrottleRetries){
            const retry=response.headers.get('retry-after');
            const delay=retry===null?1000:Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now();
            if(!Number.isFinite(delay)||delay<0||delay>policy.maxRetryDelayMs)throw new Error('Provider throttle exceeds bounded backoff');
            await sleep(delay);continue;
          }
          if(!response.ok){
            // Retain validation locations, not potentially echoed source or secrets.
            try{const error=await response.json();receipt.validationLocations=Array.isArray(error.detail)?error.detail.map(e=>({location:e.loc,type:e.type})):[];}catch{}
            throw new Error(`Decision request failed (${response.status})`);
          }
          const raw=await response.json();
          // Keep usage even if the response fails semantic validation.
          receipt.usage={input_tokens:Number.isSafeInteger(raw.usage?.input_tokens)?raw.usage.input_tokens:null,output_tokens:Number.isSafeInteger(raw.usage?.output_tokens)?raw.usage.output_tokens:null};
          receipt.actualModel=typeof raw.model==='string'?raw.model:null;
          const result=normalizeResponse(raw,request);
          receipt.status=raw._localCacheHit?'cache':raw._coalesced?'coalesced':'provider';
          receipt.usage=result.usage;
          return {answers:result.answers,receipt};
        }
      } catch(error){receipt.error=error.name==='AbortError'?'Interrupted':String(error.message);throw error;}
      finally {receipt.elapsedMs=Date.now()-start;await recordReceipt(receipt);}
    })));
    return {status:results.every(x=>x.status==='fulfilled')?'complete':'needs_review',answers:Object.assign({},...results.filter(x=>x.status==='fulfilled').map(x=>x.value.answers)),receipts:results.filter(x=>x.status==='fulfilled').map(x=>x.value.receipt),errors:results.filter(x=>x.status==='rejected').map(x=>String(x.reason.message))};
  }};
}
