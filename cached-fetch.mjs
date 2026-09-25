import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {reservePaidCall} from './core.mjs';
import {normalizeResponse} from './decision-types.mjs';
// Cache contains validated typed judgments only, never requests or source text.
export function createCachedFetch({directory,fetcher=fetch,ttlMs=86400000,maxEntries=128,namespace='legacy',legacy=true,reserve=reservePaidCall}={}){
 const inFlight=new Map();
 const wrapped=async(url,options)=>{
  const request=JSON.parse(options.body),key=crypto.createHash('sha256').update('jev-cache-v2\n'+namespace+'\n'+url+'\n'+options.body).digest('hex');
  const file=directory?path.join(directory,key+'.json'):null;
  const valid=data=>{try{normalizeResponse(data,request,{legacy});return true;}catch{return false;}};
  if(file){try{const stat=await fs.stat(file);if(stat.size<=100000){const record=JSON.parse(await fs.readFile(file,'utf8'));if(record.key===key&&Date.now()-record.createdAt>=0&&Date.now()-record.createdAt<ttlMs&&valid(record.data))return Response.json({...record.data,usage:{input_tokens:0,output_tokens:0},_localCacheHit:true});}}catch{}}
  if(inFlight.has(key)) {
   const shared=await inFlight.get(key),response=shared.clone();
   if(!response.ok)return response;
   try{return Response.json({...await response.json(),usage:{input_tokens:0,output_tokens:0},_coalesced:true});}catch{return shared.clone();}
  }
  const work=(async()=>{
  if(!await reserve({request,key}))return new Response('',{status:429,headers:{'x-local-limit':'true'}});
  const response=await fetcher(url,options);
  if(!response.ok||!file)return response;
  const raw=await response.clone().text();if(raw.length>100000)return response;
  try{
   const data=JSON.parse(raw);
   if(valid(data)){
    await fs.mkdir(directory,{recursive:true});
    const temp=path.join(directory,key+'.'+crypto.randomUUID()+'.tmp');
    const normalized=normalizeResponse(data,request,{legacy});
    try{await fs.writeFile(temp,JSON.stringify({key,createdAt:Date.now(),data:normalized}),{mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
    const entries=await Promise.all((await fs.readdir(directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(async n=>({name:n,mtime:(await fs.stat(path.join(directory,n))).mtimeMs})));
    entries.sort((a,b)=>b.mtime-a.mtime);for(const entry of entries.slice(maxEntries))await fs.rm(path.join(directory,entry.name),{force:true});
   }
  }catch{} // A cache failure never repeats a paid call or blocks useful output.
  return response;
  })();
  inFlight.set(key,work);
  try{return (await work).clone();}finally{if(inFlight.get(key)===work)inFlight.delete(key);}
 };
 wrapped.managesBudget=true;return wrapped;
}
