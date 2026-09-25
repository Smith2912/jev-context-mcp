import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('fresh MCP server advertises finish and executes the two-call path with no hash-report round trip',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-controller-stdio-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source='export const value = 1;',check='import {value} from "./source.mjs";if(value!==1)process.exit(1);';
 await fs.writeFile(path.join(dir,'source.mjs'),source);await fs.writeFile(path.join(dir,'check.mjs'),check);
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 const manifest=JSON.stringify({root:dir,contract:'Export value one.',requirements:['value === 1'],files:[{id:'source',path:'source.mjs',mandatory:true},{id:'check',path:'check.mjs',acceptance:true,frozenHash:hash(check)}],actions:{verify:[{id:'unit',executable:process.execPath,args:['check.mjs']}]}});
 const manifestFile=path.join(dir,'manifest.json');await fs.writeFile(manifestFile,manifest);
 const configFile=path.join(dir,'settings.json');await fs.writeFile(configFile,JSON.stringify({workflow:{enabled:true,artifactDirectory:path.join(dir,'runs'),allowedExecutables:[process.execPath],registrations:{fixture:{path:manifestFile,sha256:hash(manifest)}}}}));
 const client=new Client({name:'controller-stdio-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:{...process.env,JEV_SETTINGS_FILE:configFile},stderr:'pipe'});
 try{
  await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,10);
  assert.ok(tools.tools.find(t=>t.name==='decide_computer_step'));
  assert.ok(tools.tools.find(t=>t.name==='run_workflow_stage').inputSchema.properties.actionId.enum.includes('finish'));
  const invoke=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
  const ui=await invoke('decide_computer_step',{runId:'stdio-ui',task:'Open settings',surface:'browser',observation:'Settings control visible',actions:[{id:'settings',description:'Select Settings',risk:'routine'}]});
  assert.equal(ui.status,'escalate');assert.equal(ui.provider.status,'not_called');
  const identity={workflowId:'fixture',runId:'stdio',mode:'deterministic'};
  const prepared=await invoke('prepare_work_packet',{...identity,compact:true});assert.equal(prepared.status,'prepared');assert.equal(prepared.sourceHashes,undefined);
  const finished=await invoke('run_workflow_stage',{...identity,actionId:'finish',operationId:'verify-1'});assert.equal(finished.status,'verified');assert.equal(finished.provider.receipts,0);assert.equal(finished.acceptance,'not_established');
 }finally{await client.close();}
});
