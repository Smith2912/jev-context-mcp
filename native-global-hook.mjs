import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRegisteredLaunch,parseRegisteredJevLaunch} from './native-bounded-entry.mjs';

function output(value){process.stdout.write(JSON.stringify(value)+'\n');}
function pass(systemMessage){output(systemMessage?{continue:true,systemMessage}:{continue:true});}

if(process.env.JEV_NATIVE_CONTROLLER_CHILD==='1'){pass();process.exit(0);}
let raw='';for await(const chunk of process.stdin)raw+=chunk;
let input;try{input=JSON.parse(raw);}catch{pass();process.exit(0);}
if(input?.hook_event_name!=='UserPromptSubmit'||typeof input.prompt!=='string'){pass();process.exit(0);}
const workflowId=parseRegisteredJevLaunch(input.prompt);
if(!workflowId){
 if(/^\s*jev\s*:/i.test(input.prompt))pass('Jev launch skipped. Use the exact registered form: jev: workflow=<registered-id>. Continuing in the current task.');
 else pass();
 process.exit(0);
}
if(input.permission_mode==='plan'){pass('Registered Jev execution is unavailable in plan mode. Continuing read-only in the current task.');process.exit(0);}

const settingsFile=path.resolve(process.env.JEV_SETTINGS_FILE||fileURLToPath(new URL('./settings.json',import.meta.url)));
const outputRoot=path.resolve(process.env.JEV_NATIVE_CONTROLLER_ROOT||path.join(os.homedir(),'.codex','jev-native-controller','bounded-runs'));
try{
 const {request}=await createRegisteredLaunch({workflowId,settingsFile,outputRoot,sourceSessionId:input.session_id??null,sourceTurnId:input.turn_id??null});
 fs.mkdirSync(request.outputDirectory,{recursive:true});
 const requestFile=path.join(request.outputDirectory,'request.json');
 fs.writeFileSync(requestFile,JSON.stringify(request,null,2)+'\n',{encoding:'utf8',flag:'wx'});
 const cli=fileURLToPath(new URL('./native-routed-cli.mjs',import.meta.url));
 if(process.env.JEV_NATIVE_CONTROLLER_TEST_NO_SPAWN!=='1'){
  const child=spawn(process.execPath,[cli,requestFile],{cwd:request.workingDirectory,windowsHide:true,detached:true,env:{...process.env,JEV_NATIVE_CONTROLLER_LAUNCH:'1'},stdio:'ignore'});
  child.unref();
 }
 output({decision:'block',reason:`Registered Jev workflow ${workflowId} accepted with fixed request, tool-call, timeout, evidence, verification, and escalation limits. Controller state: ${request.stateFile}`});
}catch(error){
 pass(`Registered Jev workflow did not launch; continuing in this task with the normal Codex workflow. ${error.message}`);
}
