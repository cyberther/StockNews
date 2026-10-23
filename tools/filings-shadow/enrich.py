from periods_schema import year_groups,canonical_years

def enrich(result,pages,finance,kind):
 # Import at call time to avoid an engine module initialization cycle.
 from engine import fact
 if kind=='dividend':
  primary=set(result.get('primaryPages',[]));groups=[];source_ids=[]
  for p in pages:
   if p['page'] not in primary:continue
   g=year_groups(p['text']);groups.extend(g)
   if g:source_ids.append(p['source_id'])
  years=canonical_years(groups)
  if years:
   legacy={f['value'] for f in result['catalog'] if f['field']=='fiscal_year' and f.get('scope')=='primary'}
   if not legacy.issubset(set(years)):
    result['issues'].append('Fiscal-year group disagrees with other primary evidence');result['status']='needs_review';return result
   f=fact('fiscal_years',years,source_ids,scope='primary',expressions=[raw for g,raw in groups]);result['catalog'].append(f);result['selected']['fiscal_years']=f
   if len(years)>1:
    result['selected'].pop('fiscal_year',None)
    for f in result['catalog']:
     if f['field']=='fiscal_year':f['scope']='legacy_scalar_not_applicable'
    result['issues']=[i for i in result['issues'] if not i.startswith('fiscal_year:')]
    result['status']='needs_review' if result['issues'] else 'source_bound_draft'
  elif groups:
   result['issues'].append('Conflicting fiscal-year event groups');result['status']='needs_review'
 if kind=='results':
  cells={c['id']:c for c in finance['cells']};records=[]
  for field,f in result['selected'].items():
   if 'cell_id' not in f:continue
   c=cells[f['cell_id']]
   records.append({'field':field,'metric':c['metric'],'label':c['label'],'value':f['value'],'unit':c['unit'],'year':c['year'],'period':c['period'],'consolidated':c['consolidated'],'currency':c['currency'],'raw':c['raw'],'sources':f['sources'],'footnotes':c.get('footnotes',[])})
  result['metric_records']=records
 return result
