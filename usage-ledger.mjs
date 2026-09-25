import fs from 'node:fs/promises';
import crypto from 'node:crypto';
export async function recordUsage(file,tool,result){
  if(!result.provider||!file)return result;
  const p=result.provider,id=crypto.randomUUID();
  const entry={id,time:new Date().toISOString(),tool,sourceHash:result.sha256??result.sourceHash??null,status:p.status,model:p.model??null,inputTokens:p.usage?.input_tokens??null,outputTokens:p.usage?.output_tokens??null,elapsedMs:p.elapsedMs??null};
  if(result.invocation)entry.invocation=result.invocation;
  try{await fs.appendFile(file,JSON.stringify(entry)+'\n',{encoding:'utf8',mode:0o600});result.usageReceipt=id;}
  catch{result.usageLedgerWarning='Receipt could not be persisted. Do not repeat the paid call solely for accounting.';}
  return result;
}
