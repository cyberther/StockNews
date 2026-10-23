import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {failurePolicy,retryRegistry} from '../tools/filings-retry.mjs';
import {runFilings} from '../tools/filings-extract.mjs';
test('retry policy distinguishes transport failures from review and caps retries',()=>{
 for(const e of [{status:503},{status:429},{code:'ECONNRESET'},{message:'request timeout'}]){
  assert.equal(failurePolicy(e,1,0).nextAttemptAt,1200000);
  assert.equal(failurePolicy(e,2,0).nextAttemptAt,7200000);
  assert.equal(failurePolicy(e,3,0).retryable,false);
 }
 for(const e of [{status:404},{status:403},{code:'OCR_UNCERTAIN'},{code:'DOCUMENT_CONTEXT_LIMIT'},{code:'EVIDENCE_INVALID'}])assert.equal(failurePolicy(e,1).retryable,false);
});
test('regular queue retains temporary failures pending and persists cooldown across restarts',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'retry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'state.json');const saved=[];let calls=0;
 const deps={cfg:{secret:'test',model:'test'},allowed:async()=>true,log:()=>{},retry:retryRegistry(path),
 rpc:async(fn,args)=>fn==='filings_pending'?[{id:1,kind:'holding',url:'https://example.org/doc'}]:saved.push(args),
 httpGet:async()=>{calls++;return {status:503};}};
 await runFilings(1,deps);assert.equal(calls,1);assert.equal(saved.length,0);
 await runFilings(1,{...deps,retry:retryRegistry(path)});assert.equal(calls,1);
});
