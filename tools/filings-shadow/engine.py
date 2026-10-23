import re,json,calendar,collections
from pathlib import Path
from layout import fold,ident,parse_number,finance
from event_links import link_page,fiscal_years
MONTHS={'ianuarie':1,'january':1,'februarie':2,'february':2,'martie':3,'march':3,'aprilie':4,'april':4,'mai':5,'may':5,'iunie':6,'june':6,'iulie':7,'july':7,'august':8,'septembrie':9,'september':9,'octombrie':10,'october':10,'noiembrie':11,'november':11,'decembrie':12,'december':12}
NAMES='|'.join(MONTHS)
DATE=re.compile(rf'\b(?:\d{{1,2}}[./-]\d{{1,2}}[./-]20\d{{2}}|20\d{{2}}-\d{{2}}-\d{{2}}|\d{{1,2}}\s+(?:{NAMES})\s+20\d{{2}}|(?:{NAMES})\s+\d{{1,2}},?\s+20\d{{2}})\b',re.I)
def date_value(text):
 s=fold(text).strip();nums=re.findall(r'\d+',s)
 try:
  if re.match(r'20\d{2}-',s):y,m,d=map(int,nums)
  elif any(k in s for k in MONTHS):
   name=next(k for k in MONTHS if re.search(r'\b'+k+r'\b',s));m=MONTHS[name];y=int(nums[-1]);d=int(nums[0])
  else:d,m,y=map(int,nums)
  if 1<=m<=12 and 1<=d<=calendar.monthrange(y,m)[1]:return f'{y:04}-{m:02}-{d:02}'
 except (ValueError,StopIteration):pass
 return None

def pages_text(ident_,layout):
 fallback=layout.get('fallback_text','')
 if '\f' in fallback:parts=fallback.split('\f')
 elif re.search(r'^\[Pagina \d+\]',fallback,re.M):parts=re.split(r'^\[Pagina \d+\]\s*',fallback,flags=re.M)[1:]
 else:parts=[fallback]
 out=[]
 for p in layout['pages']:
  native='\n'.join(l['text'] for l in p['lines']);quality=p['native_words']>=40 and native.count('�')<3
  text=native if quality else parts[p['page']-1] if p['page']<=len(parts) else ''
  out.append({'page':p['page'],'text':text,'origin':'native_geometry' if quality else 'oriented_ocr_text','source_id':ident(layout['sha256'],p['page'],text)})
 return out

def fact(field,value,sources,**meta):return {'id':ident(field,value,*sources,*sorted(meta.items())), 'field':field,'value':value,'sources':sources,**meta}
def unique(items):
 d={}
 for f in items:d.setdefault(json.dumps(f['value'],sort_keys=True),f)
 return list(d.values())
def select_fields(catalog,required,allow_null=[]):
 selected={};issues=[]
 for field in required:
  options=unique([f for f in catalog if f['field']==field and f.get('scope','primary')=='primary'])
  if len(options)==1:selected[field]=options[0]
  elif len(options)>1:issues.append(f'{field}: conflicting supported primary values')
  elif field not in allow_null:issues.append(f'{field}: explicit support missing')
 return selected,issues

def financial_document(row,layout,fin):
 catalog=[];issues=[];target=fin['target_period'];sources=fin['sources']
 if not target:return {'status':'needs_review','issues':['No unambiguous document period'],'catalog':[],'selected':{},'sources':sources}
 code,year=target.split();year=int(year);pool=[c for c in fin['cells'] if c['period']==code and c['year'] in (year,year-1) and c['value'] is not None]
 bases={c['consolidated'] for c in pool if c['consolidated'] is not None};selected_basis=True if True in bases else False if False in bases else None
 currencies={c['currency'] for c in pool if c['consolidated']==selected_basis and c['currency']};cur=next(iter(currencies)) if len(currencies)==1 else None
 if selected_basis is None:issues.append('Financial basis not explicit')
 if cur is None:issues.append('Currency missing or conflicting')
 pool=[c for c in pool if c['consolidated']==selected_basis and c['currency']==cur]
 # Turnover is a separate metric, never mixed with total operating revenue.
 revenue_metric='turnover' if any(c['metric']=='turnover' for c in pool) else 'total_revenue' if any(c['metric']=='total_revenue' for c in pool) else 'operating_revenue'
 mapping={'revenue':(revenue_metric,year),'revenue_prev':(revenue_metric,year-1),'net_profit':('net_profit',year),'net_profit_prev':('net_profit',year-1),'ebitda':('ebitda',year),'eps':('eps',year)}
 for field,(metric_,y) in mapping.items():
  for c in fin['cells']:
   if c['metric']!=metric_ or c['value'] is None:continue
   # Wrong-year/period/basis candidates stay visible as decoys; the validator rejects them.
   primary=c['year']==y and c['period']==code and c['consolidated']==selected_basis and c['currency']==cur and not c.get('review_required',False)
   catalog.append(fact(field,c['value'],c['sources'],scope='primary' if primary else 'other_period_or_basis',year=c['year'],period=c['period'],consolidated=c['consolidated'],currency=c['currency'],metric=metric_,page=c['page'],cell_id=c['id'],footnote_marker=c.get('footnote_marker',''),footnotes=c.get('footnotes',[]),original_label=c['label']))
 selected,more=select_fields(catalog,list(mapping),allow_null=['revenue_prev','net_profit_prev','ebitda','eps']);issues+=more
 basis_sources=list(dict.fromkeys(s for c in pool for s in c['sources'] if sources.get(s,{}).get('kind')=='basis'))
 period_sources=list(dict.fromkeys(s for c in pool for s in c['sources'] if re.search(r'20\d{2}',sources.get(s,{}).get('text',''))))
 if not period_sources:
  for p in layout['pages'][:3]:
   for line in p['lines']:
    if str(year) in line['text'] and re.search(r'S[12]|T[1-4]|iunie|martie|semestr|trimestr',line['text'],re.I):
     sid=line['id'];sources[sid]={'page':p['page'],'kind':'report_period','text':line['text']};period_sources.append(sid)
     break
   if period_sources:break
 if code.startswith('S'):month=6*int(code[1])
 elif code.startswith('T'):month=3*int(code[1])
 else:month=12
 for field,value,src in [('period',target,period_sources),('period_end',f'{year}-{month:02}-{calendar.monthrange(year,month)[1]}',period_sources),('consolidated',selected_basis,basis_sources),('currency',cur,period_sources)]:
  if value is not None and src:
   f=fact(field,value,src,scope='primary',derived='calendar boundary' if field=='period_end' else 'explicit table scope');catalog.append(f);selected[field]=f
 return {'status':'source_bound_draft' if not issues else 'needs_review','issues':issues,'selected':selected,'catalog':catalog,'sources':sources,'target':{'period':target,'basis':selected_basis,'currency':cur,'revenueMetric':revenue_metric}}

NUM=r'\d+(?:[.,]\d+)+'
DPS=[re.compile(rf'dividend(?:ul|ului)?\s+brut\s+(?:pe\s+actiune|per\s+share).{{0,55}}?({NUM})\s*(ron|lei|eur|euro)',re.I),re.compile(rf'dividend(?:ul|ului)?\s+brut\s+(?:este\s+de|in\s+valoare\s+de)\s*({NUM})\s*(ron|lei|eur|euro)(?=.{{0,20}}(?:pentru\s+o\s+actiune|pe\s+actiune|/actiune))',re.I)]
def prices(text):
 text=re.sub(r'(?i)ac[țţt]\s+iune','actiune',text)
 f=re.sub(r'\s+',' ',fold(text));out=[]
 for pattern in DPS:
  for m in pattern.finditer(f):out.append({'value':parse_number(m.group(1)),'currency':'EUR' if m.group(2) in ('eur','euro') else 'RON','raw':m.group(0)})
 # English currency-before-amount announcements; base/special components remain separate.
 for m in re.finditer(r'(?:total\s+)?gross\s+dividend(?:\s*\([^)]*\))?(?:\s+per\s+share)?\s+(?:is|of|is\s+of)\s+(RON|EUR)\s+(\d+[.,]\d+)(?=.{0,20}(?:per share|;|,|$))',f,re.I):
  out.append({'value':parse_number(m.group(2)),'currency':m.group(1).upper(),'raw':m.group(0)})
 return out
ROLES={'record_date':r'data\s+(?:de\s+)?inregistrare|record\s+date|registration\s+date', 'ex_date':r'ex[- ]?date|ex[- ]?data', 'payment_date':r'data\s+(?:de\s+)?plat(?:ii|a)|payment\s+date|date\s+of\s+payment'}
CONDITIONAL=r'amanat|deferred|nerezident|non.resident|certificate?|certificat|documente|supporting documents|no later than|pana (?:la|cel)|in cazul|in case|daca|\bif\b'
def dividend_document(row,pages):
 catalog=[];sources={};primary_pages=[];issues=[];anchor=None;event_links=[];event=None
 for p in pages:
  sid=p['source_id'];sources[sid]={'page':p['page'],'text':p['text'],'kind':'page_text','origin':p['origin']};q=re.sub(r'\s+',' ',fold(p['text']));ps=prices(p['text'])
  announced=bool(re.search(r'anunta\s+plata|informeaza.*plata|plata dividendelor|payment of.*dividend|dividends.*payment|hotararea propusa|propune spre|convoca',q,re.S))
  # A primary calendar must be linked to the per-share amount, not merely share a year.
  primary=bool(ps and announced and p['page']<=3 and not primary_pages)
  if primary:
   primary_pages.append(p['page']);anchor=p
   if len({(v['value'],v['currency']) for v in ps})==1:event={'amount':ps[0]['value'],'currency':ps[0]['currency'],'years':fiscal_years(p['text'])}
  linked=None
  if not primary and event and anchor:
   between=[x for x in pages if anchor['page']<x['page']<p['page']]
   linked=link_page(anchor,p,between,event['amount'],event['currency'],event['years'],prices)
   if linked:event_links.append({'page':p['page'],**linked})
  for price in ps:
   catalog += [fact('gross_dps',price['value'],[sid],scope='primary' if primary else 'unclassified',page=p['page'],role='gross dividend per share'),fact('currency',price['currency'],[sid],scope='primary' if primary else 'unclassified',page=p['page'])]
  if primary:
   years=re.findall(r'(?:exercitiului\s+financiar|exercitiul\s+financiar|anului\s+(?:financiar\s+)?|profitului\s+net.{0,15})\s*(20\d{2})',q)
   years+=re.findall(r'(?:financial year|fiscal year)\s+(20\d{2})|(20\d{2})\s+financial year',q);years=[next((v for v in y if v),'') if isinstance(y,tuple) else y for y in years]
   for ym in re.finditer(r'(?:financial year|fiscal year|exercitiul financiar)\s+(20\d{2})\s+(?:and|si|[-–])\s*(20\d{2})',q):years.extend(ym.groups())
   for y in set(years):catalog.append(fact('fiscal_year',int(y),[sid],scope='primary',page=p['page']))
   stage='proposed' if re.search(r'hotararea propusa|propune spre aprobarea|proposed resolution|draft resolution',q) else 'paid' if re.search(r'anunta\s+plata|informeaza.*va efectua plata|announces.*payment|plata dividendelor',q,re.S) else 'approved' if re.search(r'a aprobat|au aprobat|hotarar.{0,25}adoptat',q) else None
   if stage:catalog.append(fact('status',stage,[sid],scope='primary',page=p['page'],meaning='payment announcement, not proof of completion' if stage=='paid' else stage))
  for match in DATE.finditer(q):
   value=date_value(match.group());
   if not value:continue
   # Roles must be directly attached to this date; distant mentions are not sufficient.
   previous=[d.end() for d in DATE.finditer(q[:match.start()])]
   before=q[max(previous[-1] if previous else 0,match.start()-110):match.start()];after=q[match.end():match.end()+65];options=[]
   for field,pattern in ROLES.items():
    for role in re.finditer(pattern,before):
     gap=before[role.end():]
     if not re.search(r'[;.]|20\d{2}',gap):options.append((len(gap),field))
    for role in re.finditer(pattern,after):
     prefix=after[:role.start()];following=after[role.end():].lstrip(' :')
     if re.fullmatch(r'\s*[(–—-]?\s*',prefix) and len(prefix)<10 and not DATE.match(following):options.append((role.start(),field))
   # Explicit announcement syntax handles dates after the payment agent, where the role is distant.
   if re.search(r'(?:incepand cu data de|starting with)\s*$',before):options.append((0,'payment_date'))
   if re.search(r'(?:registrul actionarilor|shareholders.{0,12}registry).{0,20}(?:la data de|on)\s*$',before):options.append((0,'record_date'))
   if not options:continue
   distance,field=min(options)
   if distance>70:continue
   paragraph=q[max(0,q.rfind('\n\n',0,match.start())):q.find('\n\n',match.end()) if q.find('\n\n',match.end())>=0 else len(q)]
   # For native line text there may be no blank-line separators; use a bounded local window.
   if len(paragraph)>1200:paragraph=q[max(0,match.start()-180):match.end()+120]
   conditional=bool(re.search(CONDITIONAL,q[max(0,match.start()-110):match.start()]))
   scope='primary' if (primary or linked) and not conditional else 'conditional' if conditional else 'unclassified'
   catalog.append(fact(field,value,linked['sources'] if linked else [sid],scope=scope,page=p['page'],role=field,event_link=linked,context=q[max(0,match.start()-90):match.end()+70]))
 if any(f['field']=='status' and f['value']=='proposed' for f in catalog):
  for f in catalog:
   if f['field']=='status' and f['value']!='proposed':f['scope']='draft_timetable'
 selected,more=select_fields(catalog,['gross_dps','currency','fiscal_year','status','record_date','ex_date','payment_date'],allow_null=['ex_date','record_date','payment_date']);issues+=more
 if not primary_pages:issues.append('No explicit primary per-share dividend announcement')
 # Reject a calendar that does not supply its key event date; never promote a deferred date.
 if 'payment_date' not in selected and selected.get('status',{}).get('value')=='paid':issues.append('Primary payment date missing')
 return {'status':'source_bound_draft' if not issues else 'needs_review','issues':issues,'selected':selected,'catalog':catalog,'sources':sources,'primaryPages':primary_pages,'eventLinks':event_links}

ACTION=r'(?:se\s+)?aprob|imputernic|empowerment|prezent|stabil|aleg|revoc|mandat|autoriza|rectific|nomin|desemn|modific|ratific|afect|constat|approval|election|appointment|setting|empower|authoriz'
def agm_document(row,pages):
 sources={p['source_id']:{'page':p['page'],'text':p['text'],'kind':'page_text','origin':p['origin']} for p in pages};catalog=[];issues=[]
 text='\n'.join(p['text'] for p in pages);root=fold('\n'.join(p['text'] for p in pages[:2]));scope='proposed_agenda' if re.search(r'convoca|convening|notice.*meeting',root) else 'adopted_resolutions' if re.search(r'hotar|resolution|adopt',root) else 'unknown'
 for p in pages[:2]:
  q=fold(p['text'])
  for m in re.finditer(r'(?:pentru\s+data\s+de|for\s+(?:the\s+)?date\s+of|general meeting of shareholders.{0,35}?on|a avut.{0,20}?data de)\s*',q):
   date=DATE.match(q,m.end())
   if date:catalog.append(fact('meeting_date',date_value(date.group()),[p['source_id']],scope='primary',page=p['page']))
  # Restrict event type to the convening heading, before historical recitals.
  if p['page']==1:
   event=re.split(r'avand in vedere|whereas',q,maxsplit=1)[0]
   ordinary=bool(re.search(r'\bordinar[ae]\b|\bordinary\b|\bagoa\b|\bagms\b',event))
   extra=bool(re.search(r'extraordinar[ae]|extraordinary|\bagea\b|\begms\b',event))
   if ordinary or extra:catalog.append(fact('meeting_type','AGOA+AGEA' if ordinary and extra else 'AGOA' if ordinary else 'AGEA',[p['source_id']],scope='primary',page=p['page']))
   # The date following the current convening heading is the first call.
   heading=re.search(r'(?:adunar(?:ea|ile)\s+general[^\n]*|general meeting[^\n]*)\n',event)
   if heading:
    window=event[heading.end():heading.end()+220]
    first=re.search(r'(?:in data de|pentru data de|on)\s*('+DATE.pattern+r')',window,re.I)
    if first:
     value=date_value(first.group(1))
     if value:catalog.append(fact('meeting_date',value,[p['source_id']],scope='primary',page=p['page']))
 # Surface contradictory dates explicitly attached to a second call.
 secondary=set()
 for page in pages:
  q=fold(page['text'])
  for m in DATE.finditer(q):
   before=q[max(0,m.start()-75):m.start()];after=q[m.end():m.end()+85]
   following=re.search(r'a doua convocare',after)
   preceding=re.search(r'a doua convocare[^.]{0,65}$',before)
   if (following and not DATE.search(after[:following.start()])) or (preceding and not DATE.search(before[preceding.start():])):
    value=date_value(m.group())
    if value:secondary.add(value)
 if len(secondary)>1:issues.append('Source has conflicting second-convocation dates: '+', '.join(sorted(secondary)))
 items=[];active=None;kind='AGEA' if any(f['field']=='meeting_type' and f['value']=='AGEA' for f in catalog) else 'AGOA';serial=0
 for p in pages:
  for line in p['text'].splitlines():
   q=fold(line)
   # Only an agenda section heading changes the type; references inside an item cannot.
   section=bool(re.match(r'^(?:[ivx]+|[ab])[.)]\s*|^ordinea de zi',q)) or (line.strip()==line.strip().upper())
   heading=re.sub(r'^(?:[ivx]+|[ab])[.)]\s*','',q).strip()
   heading=re.sub(r'^ordinea de zi(?: pentru)?\s+','',heading)
   if section and re.match(r'adunarea generala (?:extra)?ordinar|(?:extraordinary|ordinary) general',heading) and active:
    items.append(active);active=None
   if section and re.match(r'adunarea generala extraordinar[ae]\b|extraordinary general',heading):kind='AGEA'
   elif section and re.match(r'adunarea generala ordinar[ae]\b|ordinary general',heading):kind='AGOA'
   m=re.match(r'^\s*(\d{1,2})\s*[.)]\s*(.*)',line)
   if m and re.match(ACTION,fold(m.group(2))):
    if active:items.append(active)
    serial+=1;active={'number':int(m.group(1)),'text':m.group(2),'sources':[p['source_id']],'meeting_type':kind,'serial':serial,'page':p['page']}
   elif active:
    if re.search(r'^in cazul|^documentele ce fac obiectul|proiectul de hotarare|actionarii.*(?:pot|drept)|the shareholders.*(?:right|may)|^\s*(?:public|\d+/\d+)\s*$',q):
     items.append(active);active=None
    else:active['text']+='\n'+line;active['sources']=list(dict.fromkeys(active['sources']+[p['source_id']]))
 if active:items.append(active)
 # Prefer the Romanian agenda when a full bilingual duplicate exists.
 ro=[i for i in items if re.match(r'(?:se\s+)?aprob|imputernic|prezent|stabil|aleg|revoc|mandat|autoriza|rectific|nomin|desemn|modific|ratific|afect|constat',fold(i['text']))]
 if len(ro)>=3:items=ro
 seen=set();clean=[]
 for item in items:
  key=(item['meeting_type'],item['number'],fold(item['text'][:80]))
  if key in seen:continue
  seen.add(key);clean.append(item)
 for item in clean:
  first=re.sub(r'\s+',' ',item['text']).strip();f=fact('decisions',first,item['sources'],scope='primary',page=item['page'],meeting_type=item['meeting_type'],agenda_number=item['number'],full_text=item['text'],document_context=scope);catalog.append(f)
  for price in prices(item['text']):catalog.append(fact('dividend_dps',price['value'],item['sources'],scope='primary',page=item['page'],role='per-share dividend on agenda'))
 selected,more=select_fields(catalog,['meeting_date','meeting_type','dividend_dps'],allow_null=['dividend_dps']);issues+=more
 agenda=[f for f in catalog if f['field']=='decisions'];n=min(6,len(agenda))
 # Balance distinct meeting types, then prioritize financial statements/dividend/budget/board.
 score=lambda f:(5 if re.match(r'stabilirea datei|approval of.{0,30}(?:record date|ex-date)',fold(f['full_text'])) else 0 if re.search(r'dividend',fold(f['full_text'])) else 1 if re.search(r'situati.*financ|financial statement',fold(f['full_text'])) else 2 if re.search(r'buget|budget|consili|board|capital',fold(f['full_text'])) else 3,f['page'],f['agenda_number'])
 chosen=[]
 for typ in dict.fromkeys(f['meeting_type'] for f in agenda):
  pool=sorted([f for f in agenda if f['meeting_type']==typ],key=score)
  if pool:chosen.append(pool[0])
 for f in sorted(agenda,key=score):
  if f not in chosen and len(chosen)<n:chosen.append(f)
 selected['decisions']=sorted(chosen,key=lambda f:(f['page'],f['agenda_number']))
 if 'meeting_type' in selected:
  header_types=set(selected['meeting_type']['value'].split('+'));agenda_types={f['meeting_type'] for f in agenda}
  if header_types!=agenda_types:issues.append('Meeting-type header and extracted agenda disagree')
 if len(agenda)<2:issues.append('Agenda coverage too small for automatic summary')
 if scope=='unknown':issues.append('Meeting document context unknown')
 return {'status':'source_bound_draft' if not issues else 'needs_review','issues':issues,'selected':selected,'catalog':catalog,'sources':sources,'agendaCount':len(agenda),'summaryCount':len(chosen),'documentContext':scope}

def process(row,layout):
 pages=pages_text(row['id'],layout['layout'])
 if row['kind']=='results':result=financial_document(row,layout['layout'],layout['finance'])
 elif row['kind']=='dividend':result=dividend_document(row,pages)
 elif row['kind']=='agm':result=agm_document(row,pages)
 else:raise ValueError('Unsupported prototype task')
 from enrich import enrich
 result=enrich(result,pages,layout['finance'],row['kind'])
 result.update(id=row['id'],ticker=row['ticker'],kind=row['kind']);return result
