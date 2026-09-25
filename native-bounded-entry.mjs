import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {normalizeNativeLimits} from './native-routed-runner.mjs';

const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const allowedProfiles=new Set(['small_edit','bounded_project','tool_heavy','visual_spatial']);
const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
function registeredPaths(root,values,{images=false,max=8}={}){
 if(values===undefined)return [];
 if(!Array.isArray(values)||values.length>max)throw Error('Registered path list is invalid or oversized');
 const output=[];
 for(const value of values){if(typeof value!=='string'||path.isAbsolute(value)||value.split(/[\\/]/).includes('..'))throw Error('Registered path must be relative and cannot traverse');const absolute=path.resolve(root,value);if(!inside(root,absolute)||(images&&!/\.(?:png|jpe?g|webp|gif)$/i.test(absolute)))throw Error('Registered path escapes the project or has an unsupported image type');if(output.includes(absolute))throw Error('Registered path is duplicated');output.push(absolute);}
 return output;
}

export function parseRegisteredJevLaunch(prompt){
 const match=String(prompt??'').match(/^\s*jev\s*:\s*workflow\s*=\s*([a-zA-Z0-9_-]{1,100})\s*$/i);
 return match?.[1]??null;
}

export async function createRegisteredLaunch({workflowId,settingsFile,outputRoot,sourceSessionId=null,sourceTurnId=null}){
 if(!safeId(workflowId)||!path.isAbsolute(settingsFile)||!path.isAbsolute(outputRoot))throw Error('Validated registered launch input required');
 const settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));
 const workflow=settings?.workflow;
 if(workflow?.enabled!==true||workflow.batchSchedulerEnabled!==true)throw Error('Bounded workflow scheduler is disabled');
 const registration=workflow.registrations?.[workflowId];
 if(!registration?.path||!registration.sha256||!path.isAbsolute(registration.path))throw Error(`Unsupported workflow ID: ${workflowId}`);
 const manifestBytes=await fs.readFile(registration.path);
 if(sha256(manifestBytes)!==registration.sha256)throw Error('Workflow manifest changed; explicit registration required');
 const manifest=JSON.parse(manifestBytes);
 const workingDirectory=await fs.realpath(manifest.root);
 if(typeof manifest.contract!=='string'||!manifest.contract.trim()||!Array.isArray(manifest.requirements)||!manifest.requirements.length||!Array.isArray(manifest.files)||!manifest.actions?.verify?.length)throw Error('Registered workflow manifest is incomplete');
 const execution=manifest.execution??{},builderMode=execution.builderMode??'packet';
 if(!['packet','ordinary','structured-edit'].includes(builderMode))throw Error('Registered workflow builder mode is invalid');
 const defaultProfiles=builderMode==='structured-edit'?['small_edit','bounded_project']:builderMode==='packet'?['small_edit','bounded_project','tool_heavy']:['small_edit','bounded_project','tool_heavy','visual_spatial'];
 const supportedExecutionProfiles=execution.supportedExecutionProfiles??defaultProfiles;
 if(!Array.isArray(supportedExecutionProfiles)||!supportedExecutionProfiles.length||supportedExecutionProfiles.some(profile=>!allowedProfiles.has(profile)))throw Error('Registered execution profiles are invalid');
 const reviewFiles=manifest.files.filter(file=>(file.mandatory===true||file.directlyReferenced===true)&&file.acceptance!==true&&file.review!==false).map(file=>path.resolve(workingDirectory,file.path));
 if(!reviewFiles.length)throw Error('Registered workflow has no reviewable implementation source');
 const mutableFiles=registeredPaths(workingDirectory,execution.mutableFiles,{max:4}),builderImages=registeredPaths(workingDirectory,execution.builderImages),reviewImages=registeredPaths(workingDirectory,execution.reviewImages);
 if(builderMode==='structured-edit'&&!mutableFiles.length)throw Error('Structured registered workflow requires mutableFiles');
 const maxExcerptChars=execution.maxExcerptChars??6000;if(!Number.isInteger(maxExcerptChars)||maxExcerptChars<1000||maxExcerptChars>24000)throw Error('Registered excerpt bound is invalid');
 const maxRepairs=execution.maxRepairs??1;if(!Number.isInteger(maxRepairs)||maxRepairs<0||maxRepairs>1)throw Error('Registered repair count is invalid');
 const requireReviewer=execution.requireReviewer??false;if(typeof requireReviewer!=='boolean')throw Error('Registered reviewer requirement is invalid');
 const defaultLimits=builderMode==='structured-edit'?{builder:{maxRequests:1,maxToolCalls:0,maxRawTokens:90000,timeoutMs:300000},repair:{maxRequests:1,maxToolCalls:0,maxRawTokens:90000,timeoutMs:240000},reviewer:{maxRequests:1,maxToolCalls:0,maxRawTokens:70000,timeoutMs:180000}}:{builder:{maxRequests:4,maxToolCalls:3,maxRawTokens:250000,timeoutMs:300000},repair:{maxRequests:3,maxToolCalls:3,maxRawTokens:150000,timeoutMs:240000},reviewer:{maxRequests:1,maxToolCalls:0,maxRawTokens:70000,timeoutMs:180000}};
 const runId=`${workflowId}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
 const outputDirectory=path.join(outputRoot,runId),stateFile=path.join(outputDirectory,'state.json');
 return {
  request:{
   workflowId,runId,title:`Jev ${workflowId}`,contract:manifest.contract,workingDirectory,
   assignmentPrefix:'Execute only the pinned registered workflow contract. Do not expand scope or inspect unrelated files.',
   builderMode,supportedExecutionProfiles,...(builderMode==='structured-edit'?{structuredEdit:{allowedFiles:mutableFiles}}:{}),
   maxExcerptChars,shareWithTypeSafe:true,maxRepairs,requireReviewer,outputDirectory,stateFile,sourceSessionId,sourceTurnId,
   limits:normalizeNativeLimits(execution.limits??defaultLimits),builder:{images:builderImages},
   review:{files:reviewFiles,criteria:manifest.requirements.slice(0,8),images:reviewImages}
  },
  registration:{workflowId,manifestPath:registration.path,manifestHash:registration.sha256}
 };
}
