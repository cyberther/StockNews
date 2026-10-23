import test from 'node:test';
import assert from 'node:assert/strict';
import { runFilings } from '../tools/filings-extract.mjs';

test('rejects draft approval, retries with feedback, and saves only public fields', async () => {
  const source='Hotărârea propusă: AGOA aprobă dividendul. Directoratul propune spre aprobarea AGOA repartizarea profitului. '+ 'Document financiar. '.repeat(20);
  const messages=[];let saved;
  const base={fiscal_year:2025,gross_dps:1,currency:'RON',record_date:null,ex_date:null,payment_date:null};
  await runFilings(1,{
    cfg:{secret:'test',lmUrl:'http://localhost',model:'test'},allowed:async()=>true,log:()=>{},
    rpc:async(fn,body)=>{if(fn==='filings_pending')return [{id:1,ticker:'TEST.RO',url:'https://example.org/doc',title:'Dividend',kind:'dividend'}];saved=body;},
    httpGet:async()=>({status:200,type:'text/html',body:Buffer.from(source)}),
    postJson:async(_,request)=>{
      messages.push(request);
      const data=messages.length===1?{...base,status:'approved',status_evidence:'AGOA aprobă dividendul.'}:{...base,status:'proposed',status_evidence:'Directoratul propune spre aprobarea AGOA repartizarea profitului.'};
      return {status:200,body:JSON.stringify({choices:[{message:{content:JSON.stringify(data)}}]})};
    }
  });
  assert.equal(messages.length,2);
  assert.ok(messages[0].response_format.json_schema.schema.required.includes('status_evidence'));
  assert.match(messages[1].messages[1].content,/Previous extraction was rejected/);
  assert.equal(saved.p_status,'ok');
  assert.equal(saved.p_data.status,'proposed');
  assert.equal('status_evidence' in saved.p_data,false);
});

test('unverifiable evidence is failed rather than a document without figures', async () => {
  let saved;
  await runFilings(1,{
    cfg:{secret:'test',lmUrl:'http://localhost',model:'test'},allowed:async()=>true,log:()=>{},
    rpc:async(fn,body)=>{if(fn==='filings_pending')return [{id:2,ticker:'TEST.RO',url:'https://example.org/doc',title:'Results',kind:'results'}];saved=body;},
    httpGet:async()=>({status:200,type:'text/html',body:Buffer.from('Revenue 100. Net profit 10. '.repeat(20))}),
    postJson:async()=>({status:200,body:JSON.stringify({choices:[{message:{content:JSON.stringify({revenue:100,net_profit:10,consolidated:true,consolidated_evidence:'Invented consolidated financial statements'})}}]})})
  });
  assert.equal(saved.p_status,'failed');
  assert.equal(saved.p_data,null);
});
