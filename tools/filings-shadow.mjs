// Observation only: bounded local spool, no RPC client and no model calls.
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,statSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {createHash,randomBytes} from 'node:crypto';
export const SHADOW_ROOT='/home/yoda/Documents/Codex/2026-10-22/inst/outputs/filings-shadow';
export const SHADOW_VERSION='observe-v5-20261023-1';
export const KEY=/^\d+-[a-f0-9]{12}-[a-f0-9]{10}$/;
export function atomicJson(path,value){const tmp=path+'.'+randomBytes(4).toString('hex')+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});renameSync(tmp,path);}
export function enabled(root=SHADOW_ROOT){try{return JSON.parse(readFileSync(join(root,'config.json'),'utf8')).enabled===true;}catch{return false;}}
export function directories(root){for(const name of ['jobs','sources','texts','reports'])mkdirSync(join(root,name),{recursive:true,mode:0o700});}
export function spoolUsage(root){let bytes=0,pending=0;for(const dir of ['jobs','sources','texts','reports'])for(const name of readdirSync(join(root,dir))){const p=join(root,dir,name);if(statSync(p).isFile())bytes+=statSync(p).size;if(dir==='jobs'&&name.endsWith('.json')){try{if(['capturing','ready','processing'].includes(JSON.parse(readFileSync(p,'utf8')).state))pending++;}catch{}}}return {bytes,pending};}
const boundedData=value=>{if(value==null)return null;const s=JSON.stringify(value);return s.length<=65536?JSON.parse(s):null;};
export function createShadowObserver({root=SHADOW_ROOT,log=()=>{},maxBytes=200*1024*1024,maxPending=50}={}){
 const jobs=new Map();
 const guard=fn=>async(...args)=>{try{if(enabled(root))return await fn(...args);}catch(e){try{log('shadow observation unavailable',String(e.code||e.message||e).slice(0,160));}catch{}}};
 return {
  source:guard(({filing,pdf,origin='pending'})=>{
   if(!['dividend','results','agm'].includes(filing.kind)||!Number.isSafeInteger(filing.id)||filing.id<1||!Buffer.isBuffer(pdf)||pdf.length>15*1024*1024||pdf.subarray(0,5).toString()!=='%PDF-')return;
   directories(root);const statsPath=join(root,'capture-statistics.json');let stats={eligibleAttempts:0,captured:0,skippedAtLimits:0};try{stats=JSON.parse(readFileSync(statsPath,'utf8'));}catch{}stats.eligibleAttempts++;stats.updatedAt=new Date().toISOString();
   const usage=spoolUsage(root);if(usage.pending>=maxPending||usage.bytes+pdf.length+8*1024*1024>maxBytes){stats.skippedAtLimits++;atomicJson(statsPath,stats);log('shadow observation skipped: spool limit');return;}
   stats.captured++;atomicJson(statsPath,stats);
   const sha256=createHash('sha256').update(pdf).digest('hex'),key=`${filing.id}-${sha256.slice(0,12)}-${randomBytes(5).toString('hex')}`;
   const row={id:filing.id,kind:filing.kind,ticker:String(filing.ticker||'').slice(0,80),title:String(filing.title||'').slice(0,1000),url:String(filing.url||'').slice(0,3000),published_at:filing.published_at||null};
   const job={key,version:SHADOW_VERSION,sha256,filing:row,origin:['historical_audit','validation_replay'].includes(origin)?origin:'pending',historicalData:origin==='historical_audit'?boundedData(filing.data):null,state:'capturing',capturedAt:new Date().toISOString(),attempts:0};
   const target=join(root,'sources',key+'.pdf');writeFileSync(target+'.tmp',pdf,{mode:0o600});renameSync(target+'.tmp',target);atomicJson(join(root,'jobs',key+'.json'),job);jobs.set(filing.id,key);
  }),
  text:guard(({id,text})=>{const key=jobs.get(id);if(!key||typeof text!=='string'||Buffer.byteLength(text)>8*1024*1024)return;const p=join(root,'texts',key+'.txt');writeFileSync(p+'.tmp',text,{mode:0o600});renameSync(p+'.tmp',p);const path=join(root,'jobs',key+'.json');const job=JSON.parse(readFileSync(path,'utf8'));job.textSha256=createHash('sha256').update(text).digest('hex');atomicJson(path,job);}),
  complete:guard(({id,status,data=null,reason=null})=>{const key=jobs.get(id);if(!key)return;const p=join(root,'jobs',key+'.json');const job=JSON.parse(readFileSync(p,'utf8'));job.production={status:String(status).slice(0,40),data:boundedData(data),reason:reason?String(reason).slice(0,200):null};job.completedAt=new Date().toISOString();job.state='ready';atomicJson(p,job);jobs.delete(id);})
 };
}
export function pruneSpool(root,{now=Date.now(),retentionMs=14*86400000}={}){
 directories(root);let removed=0;
 for(const name of readdirSync(join(root,'jobs'))){if(!name.endsWith('.json'))continue;const key=name.slice(0,-5);if(!KEY.test(key))continue;let job;try{job=JSON.parse(readFileSync(join(root,'jobs',name),'utf8'));}catch{continue;}
  if(job.state==='capturing'&&now-Date.parse(job.capturedAt)>24*3600000){job.state='abandoned';atomicJson(join(root,'jobs',name),job);}
  if(['done','error','abandoned'].includes(job.state)&&now-Date.parse(job.completedAt||job.capturedAt)>retentionMs){for(const [dir,ext] of [['jobs','.json'],['sources','.pdf'],['texts','.txt'],['reports','.json']])rmSync(join(root,dir,key+ext),{force:true});removed++;}
 }
 // Under pressure reclaim only completed observations, never queued sources.
 const completed=readdirSync(join(root,'jobs')).filter(n=>n.endsWith('.json')&&KEY.test(n.slice(0,-5))).flatMap(n=>{try{const j=JSON.parse(readFileSync(join(root,'jobs',n),'utf8'));return ['done','error','abandoned'].includes(j.state)?[j]:[];}catch{return [];}}).sort((a,b)=>String(a.capturedAt).localeCompare(String(b.capturedAt)));
 let usage=spoolUsage(root);
 while(completed.length&&(usage.bytes>150*1024*1024||completed.length>500)){
  const job=completed.shift();for(const [dir,ext] of [['jobs','.json'],['sources','.pdf'],['texts','.txt'],['reports','.json']])rmSync(join(root,dir,job.key+ext),{force:true});removed++;usage=spoolUsage(root);
 }
 return removed;
}
