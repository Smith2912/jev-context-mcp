import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const settings=JSON.parse(await fs.readFile(process.env.JEV_SETTINGS_FILE||new URL('./settings.json',import.meta.url),'utf8'));
if(settings.refreshSkillCatalog){
  try{
    execFileSync(settings.pythonPath||'python',[fileURLToPath(new URL('./refresh-catalog.py',import.meta.url)),...(settings.skillProjectRoots||[])],{windowsHide:true,timeout:5000,stdio:['ignore','pipe','pipe']});
  }catch{process.stderr.write('Skill catalog refresh unavailable; retaining the last local catalog.\n');}
}
if(!process.env.TYPESAFE_API_KEY && settings.credentialFile){
  // The helper's output is captured in memory, never forwarded to MCP stdout or logs.
  try{
    process.env.TYPESAFE_API_KEY=execFileSync(settings.powershellPath,['-NoLogo','-NoProfile','-File',fileURLToPath(new URL('./decrypt-key.ps1',import.meta.url)),settings.credentialFile],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  }catch{process.stderr.write('TypeSafe credential unavailable; local-only triage remains available.\n');}
}
await import('./server.mjs');
delete process.env.TYPESAFE_API_KEY;
