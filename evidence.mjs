import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {redact,rank} from './core.mjs';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const extensions=new Set('.txt .md .log .rpt .json .jsonl .csv .ts .tsx .js .jsx .mjs .cjs .py .cs .java .kt .kts .groovy .gradle .properties .c .cpp .h .hpp .xml .yaml .yml .toml .ini .cfg .html .css .scss .sql .ps1 .diff .patch .sh .lua'.split(' '));
export function cleanText(text){return redact(text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED_PRIVATE_KEY]')).replace(/("(?:password|token|api[_-]?key|secret|authorization|client_secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,'$1"[REDACTED]"');}
export async function textSnapshot(file,roots=[]){
  if(!path.isAbsolute(file)||!extensions.has(path.extname(file).toLowerCase()))throw Error('Select an absolute supported text/code file.');
  const real=await fs.realpath(file);
  if(real.split(/[\\/]/).some(p=>/^\.(?:git|codex|ssh|aws|azure|gnupg)$|^\.env(?:\.|$)|^(?:credentials|secrets?|auth|token)(?:\.|$)/i.test(p)))throw Error('Protected context path.');
  const resolved=await Promise.all(roots.map(r=>fs.realpath(r).catch(()=>null)));
  if(!resolved.some(r=>{if(!r)return false;const relative=path.relative(r,real);return relative && !relative.startsWith('..')&&!path.isAbsolute(relative);}))throw Error('File outside configured context roots.');
  const fd=await fs.open(real,'r');
  try{
    const before=await fd.stat();if(!before.isFile()||before.size>2*1024*1024)throw Error('Text context must be a regular file up to 2 MiB; select a smaller local excerpt.');
    const bytes=await fd.readFile(),after=await fd.stat();
    if(bytes.length>2*1024*1024||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('File changed while reading.');
    const raw=bytes[0]===255&&bytes[1]===254?bytes.subarray(2).toString('utf16le'):bytes.toString('utf8').replace(/^\uFEFF/,'');
    if(raw.includes('\0'))throw Error('Binary text is unsupported.');
    // Redact before chunking so multi-line secrets cannot cross chunk boundaries.
    const text=cleanText(raw);
    // Preserve original line references when replacing multiline secret material.
    const stable=cleanText(raw.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,m=>'[REDACTED_PRIVATE_KEY]'+'\n'.repeat((m.match(/\n/g)||[]).length)));
    return {file:real,sha256:hash(bytes),bytes:bytes.length,text,lines:stable.split(/\r?\n/)};
  }finally{await fd.close();}
}
export function chunks(lines){
  const result=[];let current=[],start=1,size=0;
  const flush=end=>{if(current.length)result.push({id:'p'+result.length,start,end,text:current.join('\n')});current=[];size=0;};
  lines.forEach((line,i)=>{
    if(size+line.length+1>850){flush(i);start=i+1;}
    if(!current.length)start=i+1;
    if(line.length>850){for(let offset=0;offset<line.length;offset+=850)result.push({id:'p'+result.length,start:i+1,end:i+1,columnStart:offset+1,text:line.slice(offset,offset+850)});return;}
    current.push(line);size+=line.length+1;
  });flush(lines.length);return result;
}
export async function selectContext({file,question,shareWithTypeSafe=false,maxExcerptChars=4000,candidateOffset=0},{contextRoots,apiKey,fetcher}={}){
  if(typeof question!=='string'||!question.trim()||question.length>1000||!Number.isInteger(candidateOffset)||candidateOffset<0||!Number.isInteger(maxExcerptChars)||maxExcerptChars<1000||maxExcerptChars>8000)throw Error('Invalid question or context bounds.');
  const snap=await textSnapshot(file,contextRoots),parts=chunks(snap.lines);
  const terms=[...new Set(question.toLowerCase().match(/[a-z_][a-z_0-9]{2,}/g)||[])];
  for(const p of parts)p.localScore=terms.reduce((s,t)=>s+Number(p.text.toLowerCase().includes(t)),0);
  parts.sort((a,b)=>b.localScore-a.localScore||a.start-b.start||((a.columnStart??1)-(b.columnStart??1)));
  const candidates=parts.slice(candidateOffset,candidateOffset+24);
  const fits=parts.reduce((s,p)=>s+p.text.length,0)<=maxExcerptChars;
  const ranking=shareWithTypeSafe&&!fits&&candidates.length?await rank(candidates,question,{apiKey,fetcher}):{status:fits?'local-only: source fits budget':'local-only',scores:{}};
  candidates.sort((a,b)=>(ranking.scores[b.id]??b.localScore)-(ranking.scores[a.id]??a.localScore)||a.start-b.start);
  let used=0;const selected=[];
  for(const p of candidates){if(used+p.text.length>maxExcerptChars)continue;used+=p.text.length;const {localScore,...rest}=p;selected.push({...rest,score:ranking.scores[p.id]??null});}
  const {scores,...provider}=ranking;
  return {file:snap.file,sha256:snap.sha256,sourceBytes:snap.bytes,sourceLines:snap.lines.length,provider,selected,totalChunks:parts.length,candidateCount:candidates.length,unexaminedChunks:Math.max(0,parts.length-candidates.length),omittedChunks:parts.length-selected.length,nextCandidateOffset:candidateOffset+24<parts.length?candidateOffset+24:null,excerptCharacters:used,warnings:['Selection is incomplete evidence, not a summary or verification. Follow exact references before editing or concluding.','Candidate pages are lexical shortlists, not exhaustive semantic coverage. Scores are relevance, not confidence or correctness.','Redaction is best effort. Sharing must be authorized for the selected source.']};
}
export async function readContext({file,sha256,start,count=40},{contextRoots}={}){
  if(!/^[a-f0-9]{64}$/i.test(sha256)||!Number.isInteger(start)||start<1||!Number.isInteger(count)||count<1||count>100)throw Error('Invalid source range.');
  const snap=await textSnapshot(file,contextRoots);if(snap.sha256!==sha256)throw Error('File changed; select context again.');
  const text=snap.lines.slice(start-1,start-1+count).map((s,i)=>`${start+i}: ${s}`).join('\n');
  if(text.length>20000)throw Error('Range too large; select fewer lines or inspect locally.');
  return {file:snap.file,sha256,start,end:Math.min(snap.lines.length,start+count-1),text};
}
