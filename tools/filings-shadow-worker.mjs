import {readFileSync,writeFileSync,readdirSync,mkdirSync,rmSync,statSync,existsSync} from 'node:fs';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile,execFileSync} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
import {writeReport} from './filings-shadow-report.mjs';
import {SHADOW_ROOT,KEY,SHADOW_VERSION,atomicJson,directories,enabled,pruneSpool} from './filings-shadow.mjs';
const exec=promisify(execFile),here=dirname(fileURLToPath(import.meta.url));
export function summaryIdle(run=execFileSync){try{return ['dead','failed','exited'].includes(run('systemctl',['--user','show','market-pulse-summaries.service','-p','SubState','--value'],{encoding:'utf8',timeout:3000}).trim());}catch{return false;}}
export function lock(root){const path=join(root,'.worker-lock');try{mkdirSync(path,{mode:0o700});writeFileSync(join(path,'pid'),String(process.pid),{mode:0o600});return ()=>rmSync(path,{recursive:true,force:true});}catch(e){if(e.code!=='EEXIST')throw e;try{const pid=Number(readFileSync(join(path,'pid'),'utf8'));if(pid>1){try{process.kill(pid,0);return null;}catch(error){if(error.code!=='ESRCH')return null;}}else if(Date.now()-statSync(path).mtimeMs<120000)return null;rmSync(path,{recursive:true,force:true});}catch{return null;}return lock(root);}}
export async function runWorker({root=SHADOW_ROOT,idle=summaryIdle,run=exec,python=join(root,'runtime/bin/python'),log=console.log}={}){
 if(!enabled(root))return {status:'disabled'};if(!idle())return {status:'busy'};
 directories(root);const unlock=lock(root);if(!unlock)return {status:'locked'};
 try{
  pruneSpool(root);
  let choices=[];
  for(const name of readdirSync(join(root,'jobs'))){if(!name.endsWith('.json')||!KEY.test(name.slice(0,-5)))continue;try{const j=JSON.parse(readFileSync(join(root,'jobs',name),'utf8'));if(['ready','processing'].includes(j.state))choices.push(j);}catch{}}
  choices.sort((a,b)=>String(a.completedAt).localeCompare(String(b.completedAt)));const job=choices[0];if(!job)return {status:'empty'};
  if(!KEY.test(job.key))return {status:'invalid_key'};
  const path=join(root,'jobs',job.key+'.json'),pdf=join(root,'sources',job.key+'.pdf'),text=join(root,'texts',job.key+'.txt');
  if(!idle()||!enabled(root))return {status:'busy'};
  job.state='processing';job.attempts=(job.attempts||0)+1;atomicJson(path,job);
  try{
   if(job.version!==SHADOW_VERSION)throw Error('Unsupported shadow version');
   if(job.attempts>2)throw Error('Observation retry limit');
   if(!existsSync(pdf)||statSync(pdf).size>15*1024*1024||createHash('sha256').update(readFileSync(pdf)).digest('hex')!==job.sha256)throw Error('Captured source integrity failed');
   const out=await run(python,[join(here,'filings-shadow/worker.py'),path,pdf,text],{timeout:30000,killSignal:'SIGKILL',maxBuffer:8*1024*1024,env:{...process.env,OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',PYTHONDONTWRITEBYTECODE:'1'}});
   const result=JSON.parse(out.stdout);if(result.id!==job.filing.id||result.sha256!==job.sha256||result.llmCalled!==false||result.promotionAllowed!==false)throw Error('Invalid observation output');
   result.observedAt=new Date().toISOString();atomicJson(join(root,'reports',job.key+'.json'),result);job.state='done';job.observedAt=result.observedAt;atomicJson(path,job);
   // PDF and text remain briefly for source review, bounded by spool quota and TTL.
   log('shadow observed',job.filing.id,result.route);return {status:'done',id:job.filing.id,key:job.key};
  }catch(e){job.state='error';job.observationError=String(e.code||e.message||e).slice(0,200);job.observedAt=new Date().toISOString();atomicJson(path,job);log('shadow worker failed',job.filing.id,job.observationError);return {status:'error',id:job.filing.id};}
 }finally{unlock();}
}
if(import.meta.url===`file://${process.argv[1]}`){
 if(process.argv.includes('--idle-check'))process.exit(summaryIdle()?0:1);
 try{const result=await runWorker();writeReport({lastRun:result});console.log(JSON.stringify(result));}catch(e){console.error('shadow worker unavailable',String(e.code||e.message||e).slice(0,160));process.exitCode=1;}
}
