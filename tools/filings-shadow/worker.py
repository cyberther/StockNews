"""No network, LLM, database or corpus-fixture access. Reads one captured PDF."""
import sys,json,hashlib
from pathlib import Path
from layout import read_pdf,finance
from engine import process,pages_text
from routes import route
from protocol import validate,expected

def compare(candidate,baseline,kind,metrics):
 if not isinstance(baseline,dict):return {'status':'no_baseline_data','fields':[],'note':'No claim of semantic accuracy.'}
 fields=[]
 for key,new in candidate.items():
  if key=='decisions':continue # summaries are not comparable to source extracts
  if key=='fiscal_year' and 'fiscal_years' in candidate:continue
  old=baseline.get(key)
  if key=='fiscal_years' and old is None and isinstance(baseline.get('fiscal_year'),int):old=[baseline['fiscal_year']]
  if old is None:fields.append({'field':key,'status':'baseline_missing','candidate':new});continue
  if key in ('revenue','revenue_prev'):
   fields.append({'field':key,'status':'baseline_metric_untyped','baseline':old,'candidate':new,'candidate_metric':metrics.get(key),'sameNumericValue':old==new});continue
  fields.append({'field':key,'status':'same_literal' if old==new else 'difference_requires_review','baseline':old,'candidate':new})
 return {'status':'requires_review' if any(f['status']!='same_literal' for f in fields) else 'same_comparable_literals','fields':fields,'note':'Literal agreement does not prove semantic correctness; financial baseline revenue has no explicit metric type.'}

def main(job_path,pdf_path,text_path):
 job=json.loads(Path(job_path).read_text());pdf=Path(pdf_path)
 if hashlib.sha256(pdf.read_bytes()).hexdigest()!=job['sha256']:raise ValueError('Captured PDF checksum mismatch')
 fallback=Path(text_path).read_bytes() if Path(text_path).exists() else b''
 if job.get('textSha256') and hashlib.sha256(fallback).hexdigest()!=job['textSha256']:raise ValueError('Captured text checksum mismatch')
 layout=read_pdf(pdf,limit=8);layout['fallback_text']=fallback.decode('utf-8')
 data=process(job['filing'],{'layout':layout,'finance':finance(layout)})
 missing=[p['page'] for p in pages_text(job['filing']['id'],layout) if not p['text'].strip()]
 choice=route(data,input_complete=not missing);checked=validate(data,expected(data));metrics={r['field']:r['metric'] for r in data.get('metric_records',[])}
 # No request payload is sent, even for AGA. Explicitly record the unmet LLM stage.
 result={'version':job['version'],'id':job['filing']['id'],'kind':job['filing']['kind'],'origin':job['origin'],'sha256':job['sha256'],'scope':'first_8_pages_observation_only','route':choice['route'],'llmCalled':False,'needsLlm':choice['route']=='llm_agenda_selection','candidateStatus':data['status'],'issues':data['issues'],'unreadablePages':missing,'candidate':checked['resolved'],'candidateValidation':checked,'metric_records':data.get('metric_records',[]),'documentContext':data.get('documentContext'),'facts':data['selected'],'sources':data['sources'],'production':job.get('production'),'vsProduction':compare(checked['resolved'],job.get('production',{}).get('data'),data['kind'],metrics),'vsHistorical':compare(checked['resolved'],job.get('historicalData'),data['kind'],metrics),'promotionAllowed':False}
 print(json.dumps(result,ensure_ascii=False,allow_nan=False))
if __name__=='__main__':main(*sys.argv[1:])
