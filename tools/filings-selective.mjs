import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
export const SELECTIVE_ROOT='/home/yoda/Documents/Codex/2026-10-22/inst/outputs/filings-selective';
const parser=fileURLToPath(new URL('./filings-shadow/worker.py',import.meta.url));
const python='/home/yoda/Documents/Codex/2026-10-22/inst/outputs/filings-shadow/runtime/bin/python';
const consumerUrl='https://www.marketpulse.ro/templates/stock-news-web/StockNewsWeb.dc';
export async function consumerReady(config,fetcher=fetch){
 try{
  if(!/^[a-f0-9]{64}$/.test(config.consumerSha256||''))return false;
  const checks=await Promise.all([consumerUrl,'https://www.marketpulse.ro/'].map(async url=>{
   const r=await fetcher(url,{method:'HEAD',signal:AbortSignal.timeout(5000),headers:{'Cache-Control':'no-cache'}});
   if(!r.ok)return false;
   return r.headers?.get('x-mp-consumer-sha256')===config.consumerSha256;
  }));return checks.every(Boolean);
 }catch{return false;}
}
const version='source-bound-selective-v1';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function acceptCandidate(filing,report,config,digest) {
 if(!config.enabled || !['dividend','results'].includes(filing.kind) || !config.issuers?.[filing.kind]?.includes(filing.ticker))return null;
 if(report.id!==filing.id || report.kind!==filing.kind || report.sha256!==digest || report.route!=='deterministic' || report.llmCalled!==false || report.candidateValidation?.accepted!==true || report.unreadablePages?.length!==0 || report.issues?.length!==0)return null;
 const d=report.candidate;if(!d || typeof d!=='object')return null;
 let data;
 if(filing.kind==='dividend'){
  const years=d.fiscal_years || [d.fiscal_year];
  if(!years.length || years.some(y=>!Number.isInteger(y)||y<1995||y>2100) || new Set(years).size!==years.length || (years.length>1 && !config.multiYear))return null;
  if(d.fiscal_year!=null && (years.length!==1 || d.fiscal_year!==years[0]))return null;
  if(!['proposed','approved','paid'].includes(d.status)||typeof d.gross_dps!=='number'||!Number.isFinite(d.gross_dps)||d.gross_dps<0||!['RON','EUR','USD'].includes(d.currency))return null;
  data=Object.fromEntries(['gross_dps','currency','status','record_date','ex_date','payment_date'].map(k=>[k,d[k]??null]));
  data.fiscal_years=years;data.fiscal_year=years.length===1?years[0]:null;
 } else {
  if(!config.typedRevenue || typeof d.consolidated!=='boolean' || !['RON','EUR','USD'].includes(d.currency))return null;
  const records=report.metric_records||[], current=records.find(r=>r.field==='revenue'),previous=records.find(r=>r.field==='revenue_prev');
  if(!current || !['turnover','total_revenue','operating_revenue'].includes(current.metric) || current.value!==d.revenue || current.currency!==d.currency || current.consolidated!==d.consolidated)return null;
  if(d.revenue_prev!=null && (!previous || previous.metric!==current.metric || previous.year!==current.year-1 || previous.period!==current.period || previous.currency!==current.currency || previous.consolidated!==current.consolidated || previous.value!==d.revenue_prev))return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d.period_end||''))return null;
  data=Object.fromEntries(['period','period_end','consolidated','currency','revenue','revenue_prev','net_profit','net_profit_prev','ebitda','eps'].map(k=>[k,d[k]??null]));
  data.revenue_metric=current.metric;data.revenue_prev_metric=previous?.metric??null;
  data.metric_records=records;
 }
 data.extraction={version,sha256:digest,scope:'first_8_pages',method:'validated_source_facts'};
 return data;
}
export function createSelectiveExtractor({root=SELECTIVE_ROOT,log=()=>{},execute=run,parserPath=parser,consumerFetch=fetch}={}) {
 let cachedConsumer=null,checkedAt=0;
 const compatible=async config=>{
  if(Date.now()-checkedAt>60000 || cachedConsumer?.sha!==config.consumerSha256){cachedConsumer={sha:config.consumerSha256,ok:await consumerReady(config,consumerFetch)};checkedAt=Date.now();}
  return {...config,typedRevenue:!!config.typedRevenue&&cachedConsumer.ok,multiYear:!!config.multiYear&&cachedConsumer.ok};
 };
 return async ({filing,pdf,text,deadline})=>{
  let dir;
  try {
   let config=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));
   if(!config.enabled || !['dividend','results'].includes(filing.kind) || !config.issuers?.[filing.kind]?.includes(filing.ticker))return null;
   if(config.typedRevenue||config.multiYear)config=await compatible(config);
   if(!config.enabled || !['dividend','results'].includes(filing.kind) || !config.issuers?.[filing.kind]?.includes(filing.ticker) || (filing.kind==='results'&&!config.typedRevenue))return null;
   if(!Buffer.isBuffer(pdf)||pdf.length>15*1024*1024||pdf.subarray(0,5).toString()!=='%PDF-'||Buffer.byteLength(text)>8*1024*1024)return null;
   const timeout=Math.min(30000,deadline?deadline-Date.now()-1500:30000);if(timeout<1000)return null;
   dir=mkdtempSync(join(tmpdir(),'mp-selective-'));const digest=hash(pdf),job=join(dir,'job.json'),file=join(dir,'doc.pdf'),txt=join(dir,'doc.txt');
   writeFileSync(file,pdf,{mode:0o600});writeFileSync(txt,text,{mode:0o600});
   writeFileSync(job,JSON.stringify({version,id:filing.id,filing:{id:filing.id,kind:filing.kind,ticker:filing.ticker},origin:'selective_validation',sha256:digest,textSha256:hash(text)}),{mode:0o600});
   const out=await execute(python,[parserPath,job,file,txt],{timeout,killSignal:'SIGKILL',maxBuffer:8*1024*1024,env:{...process.env,OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',PYTHONDONTWRITEBYTECODE:'1'}});
   const data=acceptCandidate(filing,JSON.parse(out.stdout),config,digest);
   // Re-read the kill switch after parsing: disabling it applies to in-flight work.
   let latest=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));
   if(latest.typedRevenue||latest.multiYear)latest=await compatible(latest);
   return data && acceptCandidate(filing,JSON.parse(out.stdout),latest,digest);
  }catch(e){log('selective fallback',filing.id,e.code||e.name||'error');return null;}
  finally{if(dir)rmSync(dir,{recursive:true,force:true});}
 };
}
