import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {collectCompletedUsage} from './benchmark-control.mjs';
import {runNativeRoutedWorkflow} from './native-routed-runner.mjs';
import {nativeWorkerEnvironment,nativeSessionRoot,requireObservedSpendOptIn,validateRegisteredImages} from './native-safety.mjs';

const requestFile=process.argv[2];
if(!requestFile||!path.isAbsolute(requestFile))throw Error('Absolute request JSON path required');
const request=JSON.parse(await fs.readFile(requestFile,'utf8'));
requireObservedSpendOptIn(request.spendingLimitMode);
if(!request.stateFile||!path.isAbsolute(request.stateFile))throw Error('Absolute stateFile required');
request.outputDirectory??=path.dirname(request.stateFile);
request.review??={};
request.review.outputSchema??=fileURLToPath(new URL('./native-review-schema.json',import.meta.url));
request.builder??={};
if(request.builderMode==='structured-edit'){
 request.builder.outputSchema??=fileURLToPath(new URL('./native-builder-edit-schema.json',import.meta.url));
 request.limits??={};request.limits.repair??={maxRequests:1,maxToolCalls:0,timeoutMs:240000};
}
await fs.mkdir(request.outputDirectory,{recursive:true});

const writeState=async state=>{
 const temp=request.stateFile+'.tmp';await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n');await fs.rename(temp,request.stateFile);
};
async function findSession(threadId){
 const pending=[nativeSessionRoot()];
 while(pending.length){const directory=pending.pop();for(const entry of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);if(entry.isDirectory())pending.push(full);else if(entry.isFile()&&entry.name.endsWith(threadId+'.jsonl'))return full;}}
 throw Error(`Session file not found for ${threadId}`);
}
async function runCodex({kind,prompt,cwd,model,effort,useDefaultModel,sandbox,outputSchema,images=[],limits,onStarted}){
 const eventsFile=path.join(request.outputDirectory,`${kind}-events.jsonl`),stderrFile=path.join(request.outputDirectory,`${kind}-stderr.log`),lastFile=path.join(request.outputDirectory,`${kind}-last-message.txt`);
 if(!limits)throw Error(`${kind} execution limits required`);
 const args=['-a','never','exec','--json','--skip-git-repo-check','-s',sandbox,'-C',cwd,'-o',lastFile,'-c','use_memories=false','-c','generate_memories=false','-c','agents.enabled=false'];
 for(const image of await validateRegisteredImages(images,cwd))args.push('-i',image);
 if(!useDefaultModel)args.push('-m',model,'-c',`model_reasoning_effort="${effort}"`);
 if(outputSchema)args.push('--output-schema',outputSchema);args.push('-');
 const child=spawn(process.env.CODEX_CLI_PATH||(process.platform==='win32'?'codex.exe':'codex'),args,{cwd,windowsHide:true,env:nativeWorkerEnvironment(),stdio:['pipe','pipe','pipe']});
 const eventStream=createWriteStream(eventsFile,{encoding:'utf8'}),errorStream=createWriteStream(stderrFile,{encoding:'utf8'});
 child.stderr.pipe(errorStream);let threadId=null,eventTokens=0,startCheckpoint=Promise.resolve(),timedOut=false,toolCalls=0,limitExceeded=null,stopping=false;
 const toolTypes=new Set(['command_execution','mcp_tool_call','dynamic_tool_call','computer_tool_call','web_search','file_change']);
 const stop=()=>{if(stopping)return;stopping=true;if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGKILL');};
 const lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
 lines.on('line',line=>{eventStream.write(line+'\n');let event;try{event=JSON.parse(line);}catch{return;}if(event.type==='thread.started'&&typeof event.thread_id==='string'&&!threadId){threadId=event.thread_id;startCheckpoint=Promise.resolve(onStarted?.(threadId));}if(event.type==='item.started'&&toolTypes.has(event.item?.type)){toolCalls++;if(toolCalls>limits.maxToolCalls){limitExceeded=`${kind} exceeded registered tool-call limit (${toolCalls}/${limits.maxToolCalls})`;stop();}}if(event.type==='turn.completed'){const usage=event.usage;if(Number.isSafeInteger(usage?.input_tokens)&&Number.isSafeInteger(usage?.output_tokens))eventTokens+=usage.input_tokens+usage.output_tokens;}});
 child.stdin.end(prompt);const timer=setTimeout(()=>{timedOut=true;stop();},limits.timeoutMs);
 const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);await startCheckpoint;
 await Promise.all([new Promise(resolve=>eventStream.end(resolve)),new Promise(resolve=>errorStream.end(resolve))]);
 if(limitExceeded||timedOut||exitCode!==0){const stderr=await fs.readFile(stderrFile,'utf8').catch(()=>"");throw Error(limitExceeded??(timedOut?`${kind} timed out after ${limits.timeoutMs}ms`:`${kind} exited ${exitCode}: ${stderr.slice(-2000)}`));}
 if(!threadId)throw Error(`${kind} did not report a thread ID`);
 const finalMessage=await fs.readFile(lastFile,'utf8'),sessionFile=await findSession(threadId),usage=await collectCompletedUsage(sessionFile,threadId);
 if(!usage.reconciled||usage.rawTokens!==eventTokens)throw Error(`${kind} usage did not reconcile`);
 return {threadId,finalMessage,usage,toolCalls,eventFile:eventsFile,stderrFile,sessionFile,limitEnforcement:{requests:'post-run-accounting',rawTokens:'post-run-accounting',toolCalls:'observed-event-stop',timeout:'process-timeout',hardSpendingCeiling:false}};
}

async function loadCompletedBuilder(threadId){
 if(typeof threadId!=='string'||!/^01[a-z0-9-]{20,}$/.test(threadId))throw Error('Valid completed builder thread ID required');
 const sessionFile=await findSession(threadId),usage=await collectCompletedUsage(sessionFile,threadId);
 if(!usage.reconciled)throw Error('Completed builder usage did not reconcile');
 const eventFile=path.join(request.outputDirectory,'builder-events.jsonl'),lastFile=path.join(request.outputDirectory,'builder-last-message.txt');
 const events=(await fs.readFile(eventFile,'utf8')).split(/\r?\n/);let toolCalls=0;
 for(const line of events){if(!line)continue;let event;try{event=JSON.parse(line);}catch{continue;}if(event.type==='item.started'&&['command_execution','mcp_tool_call','dynamic_tool_call','computer_tool_call','web_search','file_change'].includes(event.item?.type))toolCalls++;}
 return {threadId,finalMessage:await fs.readFile(lastFile,'utf8'),usage,toolCalls,eventFile,stderrFile:path.join(request.outputDirectory,'builder-stderr.log'),sessionFile,resumed:true};
}

const client=new Client({name:'jev-native-routed-runner',version:'0.10.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./launch.mjs',import.meta.url))],stderr:'pipe',env:{...process.env}});
const decode=result=>{if(result?.isError)throw Error(result.content?.find(c=>c.type==='text')?.text||'MCP tool failed');const text=result?.content?.find(c=>c.type==='text')?.text;if(!text)throw Error('MCP tool returned no JSON');return JSON.parse(text);};
try{
 await client.connect(transport);
 const completedBuilder=request.resumeBuilderThreadId?await loadCompletedBuilder(request.resumeBuilderThreadId):null;
 const state=await runNativeRoutedWorkflow(request,{callTool:async(name,args)=>decode(await client.callTool({name,arguments:args})),runCodex,checkpoint:writeState,...(completedBuilder?{completedBuilder}:{})});
 process.stdout.write(JSON.stringify({phase:state.phase,route:state.route,reviewRoute:state.reviewRoute,builder:{threadId:state.builder.threadId,usage:state.builder.usage},repair:state.repair?{threadId:state.repair.threadId,usage:state.repair.usage}:null,reviewer:state.reviewer?{threadId:state.reviewer.threadId,usage:state.reviewer.usage}:null,reviewer2:state.reviewer2?{threadId:state.reviewer2.threadId,usage:state.reviewer2.usage}:null,verification:{tests:state.verification.tests,completionDecision:state.verification.completionDecision},acceptance:state.acceptance,codexTokens:state.codexTokens})+'\n');
}catch(error){
 let prior={};try{prior=JSON.parse(await fs.readFile(request.stateFile,'utf8'));}catch{}
 await writeState({...prior,phase:'needs_attention',error:error.message});throw error;
}finally{await client.close();}
