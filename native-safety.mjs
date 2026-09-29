import fs from 'node:fs/promises';
import path from 'node:path';

const runtimeVariables=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','ALLUSERSPROFILE','HOMEDRIVE','HOMEPATH','LANG','LC_ALL','TERM','CODEX_HOME']);
export function nativeWorkerEnvironment(parent=process.env){
 const env={};
 for(const [name,value] of Object.entries(parent))if(runtimeVariables.has(name.toUpperCase())&&typeof value==='string')env[name]=value;
 env.JEV_NATIVE_CONTROLLER_CHILD='1';
 return env;
}
export const nativeSessionRoot=(env=process.env)=>path.join(env.CODEX_HOME||env.codex_home||path.join(env.HOME||env.USERPROFILE||'', '.codex'),'sessions');
const inside=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
export async function validateRegisteredImages(values,workingDirectory){
 if(values===undefined||Array.isArray(values)&&values.length===0)return [];
 if(!Array.isArray(values)||values.length>8)throw Error('Registered images must be a bounded array');
 const lexicalRoot=path.resolve(workingDirectory);
 for(const file of values){
  if(typeof file!=='string'||!path.isAbsolute(file)||!/\.(?:png|jpe?g|webp|gif)$/i.test(file))throw Error('Registered image path is invalid');
  if(!inside(lexicalRoot,path.resolve(file)))throw Error('Registered image escapes the working directory');
 }
 const root=await fs.realpath(workingDirectory),seen=new Set(),images=[];
 for(const file of values){
  const target=await fs.realpath(file);
  if(!inside(root,target))throw Error('Registered image escapes the working directory through a link');
  if(!(await fs.stat(target)).isFile())throw Error('Registered image must be a regular file');
  if(seen.has(target))throw Error('Registered image is duplicated');
  seen.add(target);images.push(target);
 }
 return images;
}

// CLI events expose completed usage, not a pre-request spending control.
// Do not silently turn a hard-budget contract into an accounting-only ceiling.
export function requireObservedSpendOptIn(mode){
 if(mode!=='observed')throw Error('Codex CLI cannot enforce hard request/token budgets. Register spendingLimitMode="observed" only if post-run accounting ceilings are acceptable.');
}
