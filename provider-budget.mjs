import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
// Shared across CLI/server processes. A crash leaves a lock requiring explicit
// reconciliation; it never silently restores paid capacity.
export function persistentProviderBudget(directory,{requestsPerMinute=6,maxRunInput=250000}={}) {
 if(!Number.isSafeInteger(requestsPerMinute)||requestsPerMinute<1||!Number.isSafeInteger(maxRunInput)||maxRunInput<1)throw Error('Invalid provider budget');
 return async ({runId,estimatedInputTokens})=>{
  if(typeof runId!=='string'||!runId.length||!Number.isSafeInteger(estimatedInputTokens)||estimatedInputTokens<0)throw Error('Invalid provider reservation');
  await fs.mkdir(directory,{recursive:true});const lockPath=path.join(directory,'reservation.lock');let lock;
  for(let i=0;i<20&&!lock;i++){try{lock=await fs.open(lockPath,'wx');}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,10));}}
  if(!lock)return false;
  try{
   const file=path.join(directory,'reservations.json');let ledger;
   try{ledger=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;ledger={timestamps:[],runs:Object.create(null)};}
   if(!Array.isArray(ledger.timestamps)||ledger.timestamps.some(t=>!Number.isSafeInteger(t)||t<0)||!ledger.runs||typeof ledger.runs!=='object'||Array.isArray(ledger.runs))throw Error('Invalid provider reservation ledger; explicit reconciliation required');
   const runs=Object.create(null);
   for(const [id,count] of Object.entries(ledger.runs)){if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid provider counter; explicit reconciliation required');runs[id]=count;}
   ledger.runs=runs;
   const now=Date.now();ledger.timestamps=ledger.timestamps.filter(t=>t>now-60000);
   const next=(ledger.runs[runId]||0)+estimatedInputTokens;
   if(ledger.timestamps.length>=requestsPerMinute||!Number.isSafeInteger(next)||next>maxRunInput)return false;
   ledger.timestamps.push(now);ledger.runs[runId]=next;
   const temp=path.join(directory,crypto.randomUUID()+'.tmp');await fs.writeFile(temp,JSON.stringify(ledger),{flag:'wx'});await fs.rename(temp,file);return true;
  }finally{await lock.close();await fs.unlink(lockPath);}
 };
}
