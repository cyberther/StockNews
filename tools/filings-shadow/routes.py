"""Prototype routing only. Never writes production data or calls a model."""
import json
from protocol import validate,expected,request

def safe_request(document):
 """Invalid source alternatives are stress-test inputs, not normal model choices."""
 r=request(document);allowed={f['id'] for f in document['catalog'] if f.get('scope','primary')=='primary'}
 body=json.loads(r['messages'][1]['content']);body['facts']=[f for f in body['facts'] if f['id'] in allowed]
 r['messages'][1]['content']=json.dumps(body,ensure_ascii=False)
 for prop in r['schema']['properties'].values():
  enum=prop['items'] if prop['type']=='array' else prop
  enum['enum']=[sid for sid in enum['enum'] if sid in allowed]
 return r

def route(document,input_complete=True):
 if not input_complete:return {'route':'review','reason':['Input pages require OCR or inspection']}
 deterministic=validate(document,expected(document))
 if not deterministic['accepted']:return {'route':'review','reason':deterministic['errors']}
 if document['kind']!='agm':return {'route':'deterministic','result':deterministic,'selection':expected(document)}
 return {'route':'llm_agenda_selection','request':safe_request(document),'prefilled':{k:v for k,v in deterministic['resolved'].items() if k!='decisions'},'note':'LLM output still requires validation; source extracts are not a verified editorial summary.'}
