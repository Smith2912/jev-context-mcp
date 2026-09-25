import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWorkflow} from './workflow-runtime.mjs';
import {createWorkflowController} from './workflow-controller.mjs';
const [command,configFile,inputFile]=process.argv.slice(2);
if(!['prepare_work_packet','run_workflow_stage','get_run_report'].includes(command)||!configFile||!inputFile)throw new Error('Usage: node workflow-cli.mjs <interface> <settings.json> <input.json>');
const settings=JSON.parse(await fs.readFile(configFile,'utf8'));
const policy=JSON.parse(await fs.readFile(settings.workflow.policyFile||new URL('./decision-policy.json',import.meta.url),'utf8'));
const input=JSON.parse(await fs.readFile(inputFile,'utf8'));
let apiKey=process.env.TYPESAFE_API_KEY;
if(!apiKey&&input.mode==='jev'&&input.shareWithTypeSafe&&settings.credentialFile){
  try{apiKey=execFileSync(settings.powershellPath,['-NoLogo','-NoProfile','-File',fileURLToPath(new URL('./decrypt-key.ps1',import.meta.url)),settings.credentialFile],{encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','pipe']}).trim();}catch{process.stderr.write('Provider credential unavailable; returning evidence without remote judgments.\n');}
}
const workflow=createWorkflow({settings,policy,apiKey});
const runner=createWorkflowController(workflow);
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
const args={...input,signal:controller.signal};
const result=command==='prepare_work_packet'&&input.compact?await runner.prepare_work_packet(args):command==='run_workflow_stage'&&input.actionId==='finish'?await runner.finish_work_packet(args):await workflow[command](args);
process.stdout.write(JSON.stringify(result)+'\n');
