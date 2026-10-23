import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runHistoricalAudit,sameFigures} from '../tools/filings-audit.mjs';

const figures={holder:'Example Fund',before_pct:4,after_pct:6,date:'2026-05-20'};
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'filings-audit-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const paths={snapshot:join(dir,'snapshot.json'),state:join(dir,'state.json'),report:join(dir,'report.md')};
 const rows=[1,2].map(id=>({id,ticker:'TEST.RO',kind:'holding',title:'Holding notification',url:'https://example.org/'+id,data:figures}));
 writeFileSync(paths.snapshot,JSON.stringify({rows}));
 const deps={cfg:{secret:'test-only',model:'test',lmUrl:'http://localhost'},log:()=>{},allowed:async()=>true,
   rpc:()=>{throw new Error('Audit must never call real database RPC');},
   httpGet:async()=>({status:200,type:'text/html',body:Buffer.from('Example Fund held 4%, now holds 6% as of 20 May 2026. '.repeat(8))}),
   postJson:async()=>({status:200,body:JSON.stringify({choices:[{message:{content:JSON.stringify(figures)}}]})})};
 return {paths,deps};
}
test('audit resumes, compares JSON irrespective of key order and leaves database untouched',async t=>{
 const {paths,deps}=setup(t);
 assert.equal(sameFigures({a:1,b:2},{b:2,a:1}),true);
 let r=await runHistoricalAudit(1,deps,paths);assert.equal(r.counts.unchanged,1);assert.equal(r.pending,true);
 r=await runHistoricalAudit(1,deps,paths);assert.equal(r.counts.unchanged,2);assert.equal(r.pending,false);
 let calls=0;await runHistoricalAudit(1,{...deps,postJson:async()=>{calls++;throw Error('already processed');}},paths);assert.equal(calls,0);
});
test('different valid figures are findings, never automatic corrections',async t=>{
 const {paths,deps}=setup(t);deps.postJson=async()=>({status:200,body:JSON.stringify({choices:[{message:{content:JSON.stringify({...figures,after_pct:7})}}]})});
 const r=await runHistoricalAudit(1,deps,paths);assert.equal(r.counts.differences,1);
 const s=JSON.parse(readFileSync(paths.state));assert.equal(s.results[1].oldData.after_pct,6);assert.equal(s.results[1].newData.after_pct,7);
});
test('temporary failures wait, let other documents pass and stop after three attempts',async t=>{
 const {paths,deps}=setup(t);let calls=0;
 deps.httpGet=async()=>{calls++;return {status:503,type:'text/html',body:Buffer.from('Unavailable')};};
 let r=await runHistoricalAudit(1,deps,paths);assert.equal(r.counts.processed,0);
 let state=JSON.parse(readFileSync(paths.state));assert.equal(state.retries[1].attempt,1);assert.ok(state.retries[1].nextAttemptAt>Date.now());
 await runHistoricalAudit(1,deps,paths);assert.equal(calls,2); // second document proceeds
 await runHistoricalAudit(1,deps,paths);assert.equal(calls,2); // both cooling down
 for(let i=0;i<2;i++){
   state=JSON.parse(readFileSync(paths.state));state.retries[1].nextAttemptAt=0;writeFileSync(paths.state,JSON.stringify(state));
   r=await runHistoricalAudit(1,deps,paths);
 }
 assert.equal(r.counts.unverifiable,1);state=JSON.parse(readFileSync(paths.state));
 assert.deepEqual(state.results[1].oldData,figures);assert.equal(state.results[1].newData,null);
});
test('permanent HTTP errors require review without repeated downloads',async t=>{
 const {paths,deps}=setup(t);deps.httpGet=async()=>({status:404,body:Buffer.from('missing')});
 const r=await runHistoricalAudit(1,deps,paths);assert.equal(r.counts.unverifiable,1);
});
test('expired budgets preserve the queue and changed snapshots require review',async t=>{
 const {paths,deps}=setup(t);let r=await runHistoricalAudit(1,{...deps,deadline:Date.now()-1000},paths);assert.equal(r.counts.processed,0);
 writeFileSync(paths.snapshot,JSON.stringify({rows:[]}));await assert.rejects(runHistoricalAudit(1,deps,paths),/snapshot changed/);
});


test('known OCR gaps cannot be falsely confirmed by an identical re-extraction', async t => {
 const {paths,deps}=setup(t);
 paths.warnings=join(paths.snapshot,'..','warnings.json');
 writeFileSync(paths.warnings,JSON.stringify({'1':'Scanned annex omitted by current extraction'}));
 deps.postJson=async()=>{throw new Error('Do not spend model time on an already established OCR gap');};
 const result=await runHistoricalAudit(1,deps,paths);
 assert.equal(result.counts.unverifiable,1);
 const state=JSON.parse(readFileSync(paths.state));
 assert.equal(state.results[1].extractionStatus,'known_ocr_gap');
 assert.deepEqual(state.results[1].oldData,figures);
});


test('pipeline upgrades archive prior audit outcomes and recheck using the new extractor',async t=>{
 const {paths,deps}=setup(t);
 await runHistoricalAudit(1,deps,paths);
 const result=await runHistoricalAudit(1,{...deps,extractionVersion:'page-ocr-v2',pageAwareOcr:true},paths);
 const state=JSON.parse(readFileSync(paths.state));
 assert.equal(state.extractionVersion,'page-ocr-v2');
 assert.equal(Object.keys(state.previousRuns[0].results).length,1);
 assert.equal(result.counts.processed,1);
 assert.deepEqual(state.results[1].oldData,figures);
});
test('page-aware pipeline rechecks previously flagged OCR gaps',async t=>{
 const {paths,deps}=setup(t);paths.warnings=join(paths.snapshot,'..','warnings.json');
 writeFileSync(paths.warnings,JSON.stringify({'1':'Old OCR gap'}));
 const result=await runHistoricalAudit(1,{...deps,extractionVersion:'page-ocr-v2',pageAwareOcr:true},paths);
 assert.equal(result.counts.unchanged,1);
 const state=JSON.parse(readFileSync(paths.state));assert.equal(state.results[1].previousOcrConcern,'Old OCR gap');
});
