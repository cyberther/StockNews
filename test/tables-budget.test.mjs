import test, { after } from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {pdfText,compactDocument,answerBudget,runFilings} from '../tools/filings-extract.mjs';


// The runner is mocked; supply only the installation paths checked before invoking it.
const doclingDir = mkdtempSync(join(tmpdir(), 'test-docling-'));
mkdirSync(join(doclingDir, 'runtime/bin'), { recursive: true });
writeFileSync(join(doclingDir, 'runtime/bin/python'), 'fixture, never executed');
writeFileSync(join(doclingDir, 'market-pulse-ocr.py'), '# fixture, never executed');
after(() => rmSync(doclingDir, { recursive: true, force: true }));

test('mixed PDF invokes OCR even when a different page has enough text',async()=>{
 let calls=0;
 const out=await pdfText(Buffer.from('fake'),8,{doclingDir,run:async(_,args)=>{
  if(++calls===1)return {stdout:'Text financiar nativ. '.repeat(30)+'\f\f'};
  assert.ok(args.includes('--json'));
  return {stdout:JSON.stringify({text:'Pagina 2: 160,800 actiuni',pages:[{page:2,ocr:true,rotation:90}],pipeline:'page-ocr-v2',cache_hit:true})};
 }});
 assert.equal(calls,2);assert.match(out,/160,800/);
});
test('formatting compaction preserves all data cells and negative values',()=>{
 const source='| Person | Shares | Loss |\n| -------- | -------- | -------- |\n| Raț | 160,800 | -1 |\n| Dividend | 0,035778913 | 0 |';
 const text=compactDocument(source);
 for(const value of ['Person','Shares','Loss','Raț','160,800','-1','0,035778913'])assert.ok(text.includes(value));
 assert.ok(!text.includes('--------'));
});
test('context budgets preserve a meaningful answer allowance and fail closed',()=>{
 assert.equal(answerBudget('dividend',{tokens:4000,contextLength:8192}),2500);
 assert.equal(answerBudget('dividend',{tokens:6000,contextLength:8192}),1680);
 assert.throws(()=>answerBudget('insider',{tokens:6000,contextLength:8192}),/safe model context/);
 assert.throws(()=>answerBudget('results',{tokens:8000,contextLength:8192}),/safe model context/);
});
async function extract(measureInput,postJson){
 let saved;
 const text='Header table information. '.repeat(350)+' FINAL_ROW holder Example Fund after 6%';
 await runFilings(1,{cfg:{secret:'test',model:'test',lmUrl:'http://localhost'},measureInput,postJson,log:()=>{},allowed:async()=>true,
  rpc:async(fn,body)=>{if(fn==='filings_pending')return [{id:1,ticker:'TEST.RO',url:'https://example.org/doc',kind:'holding',title:'Holding'}];saved=body;},
  httpGet:async()=>({status:200,type:'text/html',body:Buffer.from(text)})});
 return saved;
}
test('full table tail beyond 7000 characters reaches the model when it fits',async()=>{
 const saved=await extract(async()=>({tokens:4000,contextLength:8192}),async(_,request)=>{
  assert.match(request.messages[1].content,/FINAL_ROW holder Example Fund after 6%/);
  return {status:200,body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({holder:'Example Fund',before_pct:4,after_pct:6,date:null})}}]})};
 });
 assert.equal(saved.p_status,'ok');
});
test('oversized documents are failed for review rather than silently sliced',async()=>{
 let calls=0;
 const saved=await extract(async()=>({tokens:8000,contextLength:8192}),async()=>{calls++;throw Error('should not call model');});
 assert.equal(saved.p_status,'failed');assert.equal(calls,0);
});

test('damaged embedded OCR is replaced rather than trusted as native text',async()=>{
 let calls=0;
 const text=await pdfText(Buffer.from('fake'),8,{doclingDir,run:async()=>{
  if(++calls===1)return {stdout:'Native text '.repeat(50)+'\ufffd\ufffd\ufffd'};
  return {stdout:JSON.stringify({text:'Repaired 321,600',pages:[],pipeline:'page-ocr-v2',cache_hit:false})};
 }});
 assert.equal(calls,2);assert.match(text,/321,600/);
});

test('invalid OCR output and uncertain orientation do not return partial native text',async()=>{
 await assert.rejects(pdfText(Buffer.from('fake'),8,{doclingDir,run:async cmd=>cmd==='pdftotext'?{stdout:''}:{stdout:'not JSON'}}),{code:'OCR_INVALID_RESPONSE'});
 await assert.rejects(pdfText(Buffer.from('fake'),8,{doclingDir,run:async cmd=>{
  if(cmd==='pdftotext')return {stdout:''};
  throw Object.assign(new Error('conversion failed'),{stderr:'OrientationUncertain: text directions disagree'});
 }}),{code:'OCR_UNCERTAIN'});
});
