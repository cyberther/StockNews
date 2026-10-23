import re,json,hashlib,unicodedata,math,sys,logging
from pathlib import Path
import pdfplumber
from footnotes import number_parts,definitions
logging.getLogger('pdfminer').setLevel(logging.ERROR)
def fold(s):return ''.join(c for c in unicodedata.normalize('NFD',str(s)) if unicodedata.category(c)!='Mn').lower()
def ident(*args):return 's'+hashlib.sha256('|'.join(map(str,args)).encode()).hexdigest()[:12]
def lines(words):
 groups=[]
 for w in sorted(words,key=lambda w:(round(w['top'],1),w['x0'])):
  g=next((g for g in reversed(groups[-5:]) if abs(g['y']-w['top'])<3),None)
  if g is None:g={'y':w['top'],'words':[]};groups.append(g)
  g['words'].append(w)
 for g in groups:
  g['words'].sort(key=lambda w:w['x0']);g['text']=' '.join(w['text'] for w in g['words']);g['bottom']=max(w['bottom'] for w in g['words'])
 return sorted(groups,key=lambda g:g['y'])
def parse_number(s,locale='ro'):
 t=s.strip().replace('−','-').replace(' ','').replace('\u00a0','');negative=t.startswith('(') and t.endswith(')');t=t.strip('()')
 if not re.fullmatch(r'[-+]?\d+(?:[.,]\d+)*',t):return None
 if '.' in t and ',' in t:
  decimal='.' if t.rfind('.')>t.rfind(',') else ',';t=t.replace(',' if decimal=='.' else '.','').replace(decimal,'.')
 elif ',' in t:
  if locale=='en' and all(len(p)==3 for p in t.split(',')[1:]):t=t.replace(',','')
  else:t=t.replace(',','.')
 elif '.' in t:
  if locale=='ro' and all(len(p)==3 for p in t.split('.')[1:]) and not t.startswith('0.'):t=t.replace('.','')
  elif t.count('.')>1:return None
 try:return (-1 if negative else 1)*float(t)
 except ValueError:return None
PERIOD=re.compile(r'\b(?:s([12])|h([12])|t([1-4])|q([1-4])|semestr(?:ul|u|e)?\s+(i{1,2}|[12])|trimestr(?:ul|u|e)?\s+(iv|iii|ii|i|[1-4]))\s*[-–/:]?\s*(20\d{2})',re.I)
def periods(text):
 out=[]
 for m in PERIOD.finditer(fold(text)):
  typ='S' if any(m.group(i) for i in [1,2,5]) else 'T';raw=next(m.group(i) for i in [1,2,3,4,5,6] if m.group(i));n={'i':'1','ii':'2','iii':'3','iv':'4'}.get(raw,raw)
  out.append((typ+n+' '+m.group(7),m.group(0)))
 return out
def metric(text):
 s=fold(text)
 if re.search(r'rata|marj|margin|%|^din care|financial revenues|venituri financiare|inregistrate in avans',s):return None
 if re.search(r'\beps\b|pe actiune|per share',s) and 'dividend' not in s:return 'eps'
 if re.search(r'\bebitda\b',s):return 'ebitda'
 if re.search(r'profit(?:ul)?\s+net|net\s+(?:profit|loss)|pierdere(?:a)?\s+net',s):return 'net_profit'
 if re.search(r'cifra\s+de\s+afaceri|turnover|net sales',s):return 'turnover'
 if re.match(r'^operating revenues?\b',s):return 'operating_revenue'
 if re.match(r'^venituri din (?!exploatare)',s):return None
 if re.search(r'^venituri(?:\s+din\s+exploatare|\s+operationale)?(?:[, :]|$)|^revenue(?:s)?(?:[, :]|$)|^total revenues?',s):return 'operating_revenue' if re.search(r'operation|exploatare|operating',s) else 'total_revenue'
 return None
def unit(text):
 s=fold(text)
 currency='RON' if re.search(r'\bron\b|\blei\b|\bleu\b',s) else 'EUR' if re.search(r'\beur\b|euro',s) else 'USD' if re.search(r'\busd\b|dollar',s) else None
 scale=1 if re.search(r'million|milioane|\bmil\.?\b',s) else 1000 if re.search(r'thousand|\bmii\b|000',s) else None
 # scale is the divisor converting a source value into millions.
 return (currency,scale,'en' if re.search('million|thousand',s) else 'ro')
def basis(text):
 s=fold(text);a=bool(re.search(r'consolidat(?:e|ed|a)?\b',s));b=bool(re.search(r'individual(?:e|a)?\b|separate|standalone|neconsolidat|unconsolidated',s))
 return True if a and not b else False if b and not a else None

def read_pdf(path,limit=8,page_numbers=None):
 digest=hashlib.sha256(Path(path).read_bytes()).hexdigest();out=[]
 with pdfplumber.open(path) as doc:
  indices=[p-1 for p in page_numbers] if page_numbers is not None else range(min(limit,len(doc.pages)))
  for n in indices:
   page=doc.pages[n]
   words=page.extract_words(x_tolerance=2,y_tolerance=3,keep_blank_chars=False);ls=lines(words)
   for l in ls:l['id']=ident(digest,n+1,l['y'],l['text'])
   out.append({'page':n+1,'width':page.width,'height':page.height,'lines':ls,'native_words':len(words)})
 return {'sha256':digest,'pages':out}

def table_number(raw,locale='ro'):
 return parse_number(number_parts(raw)[0],locale)

def finance(layout):
 sources={};cells=[];issues=[];active_basis=None;basis_id=None
 def register(page,line,kind='line',extra=None):
  sid=line['id'];sources[sid]={'page':page,'kind':kind,'text':line['text'],'bbox':[min(w['x0'] for w in line['words']),line['y'],max(w['x1'] for w in line['words']),line['bottom']],**(extra or {})};return sid
 prefix='\n'.join(l['text'] for p in layout['pages'][:3] for l in p['lines'][:30]);counts={}
 for value,raw in periods(prefix):counts[value]=counts.get(value,0)+1
 # Explicit report periods use the latest reporting year; comparative years do not vote.
 if counts:
  latest=max(int(k.split()[1]) for k in counts);current={k:v for k,v in counts.items() if int(k.split()[1])==latest}
  ordered=sorted(current,key=lambda k:current[k],reverse=True);target=ordered[0] if len(ordered)==1 or current[ordered[0]]>current[ordered[1]] else None
 else:
  dated=re.findall(r'30\s+iunie\s+(20\d{2})|30[./]06[./](20\d{2})',fold(prefix))
  years=[int(a or b) for a,b in dated];target='S1 '+str(max(years)) if years else None
 previous_page=None
 for p in layout['pages']:
  ls=p['lines'];page=p['page']
  if previous_page is not None and page!=previous_page+1:active_basis=None;basis_id=None
  previous_page=page
  for i,l in enumerate(ls):
   # Only explicit accounting headings change basis, not an incidental mention of a group.
   if re.search(r'contul.*profit|situati|statement|rezultate financiare|nivel consolidat|raport.*consolidat',fold(l['text'])):
    b=basis(l['text'])
    if b is not None:active_basis=b;basis_id=register(page,l,'basis')
   nums=[w for w in l['words'] if table_number(w['text']) is not None and not re.fullmatch(r'20\d{2}',w['text'])]
   # Labels are read separately from numeric cells; row-index/caption numbers are not values.
   label=' '.join(w['text'] for w in l['words'] if table_number(w['text']) is None and not re.fullmatch(r'[-()%]+|[-+()0-9.,]+%|[0-9.,]+\*+',w['text']))
   m=metric(label)
   if not m or len(nums)<2:continue
   header_rows=[h for h in ls[:i] if l['y']-h['y']<350 and len([w for w in h['words'] if re.fullmatch(r'20\d{2}',w['text'])])>=2]
   if not header_rows:continue
   header=header_rows[-1];years=[w for w in header['words'] if re.fullmatch(r'20\d{2}',w['text'])];header_id=register(page,header,'column_header')
   # A unit must be explicit in or immediately above this table, not inferred from share capital.
   us=[h for h in ls[:i] if l['y']-h['y']<350 and unit(h['text'])[0] and unit(h['text'])[1] is not None and h['y']<=header['y']+3]
   u=us[-1] if us else None;cur,scale,locale=unit(u['text']) if u else (None,None,'ro');uid=register(page,u,'unit') if u else None
   # A continuation page may repeat a table header without a nearby accounting heading.
   if active_basis is None:
    b=basis(' '.join(x['text'] for x in ls[max(0,i-12):i]))
    if b is not None:active_basis=b
   label_id=register(page,l,'row',{'metric':m})
   for y in years:
    xc=(y['x0']+y['x1'])/2
    adjacent=[w for w in nums if abs((w['x0']+w['x1'])/2-xc)<32]
    if not adjacent:continue
    numeric=min(adjacent,key=lambda w:abs((w['x0']+w['x1'])/2-xc))
    # Period tokens directly above the year have priority over the document-wide period.
    ps=[]
    for h in ls[:i]:
     if not 0<=header['y']-h['y']<=45:continue
     for w in h['words']:
      if re.fullmatch(r'[STHQ][1-4]',w['text'],re.I) and abs((w['x0']+w['x1'])/2-xc)<30:ps.append((abs((w['x0']+w['x1'])/2-xc),w['text'].upper().replace('H','S').replace('Q','T'),h))
    period=min(ps,key=lambda x:x[0])[1] if ps else None;period_line=min(ps,key=lambda x:x[0])[2] if ps else None
    if period is None:
     # Explicit dated half-year/quarter headers, or table captions naming that period.
     band=' '.join(h['text'] for h in ls[:i] if l['y']-h['y']<350)
     if re.search(r'30\s+iunie|30[./]06|6\s+luni|six\s+months',fold(band)):period='S1'
     elif re.search(r'31\s+martie|31[./]03|3\s+luni|three\s+months',fold(band)):period='T1'
     elif re.search(r'31\s+decembrie|31[./]12|year ended',fold(band)):period='FY'
    raw=numeric['text'];clean,marker=number_parts(raw);value=parse_number(clean,locale);notes=definitions(ls,marker,after=l['y']) if marker else [];note_ids=[register(page,n,'footnote') for n in notes];cid=ident(layout['sha256'],page,numeric['x0'],numeric['top'],raw)
    sources[cid]={'page':page,'kind':'cell','text':raw,'numeric_text':clean,'footnote_marker':marker,'bbox':[numeric['x0'],numeric['top'],numeric['x1'],numeric['bottom']]}
    p_id=register(page,period_line,'period_header') if period_line else header_id
    if m=='eps':normalized=value;effective_unit='RON/share' if cur=='RON' else (cur or '?')+'/share'
    else:normalized=value/scale if scale and value is not None else None;effective_unit=(cur or '?')+' million'
    cells.append({'id':cid,'metric':m,'label':label,'year':int(y['text']),'period':period,'consolidated':active_basis,'currency':cur,'raw':raw,'numeric_text':clean,'footnote_marker':marker,'footnotes':[n['text'] for n in notes],'review_required':bool(marker and not notes),'value':normalized,'unit':effective_unit,'page':page,'sources':[cid,label_id,header_id,p_id,*note_ids,*([uid] if uid else []),*([basis_id] if basis_id else [])]})
 # Keep conflicts visible; never take a later page merely because it is later.
 return {'target_period':target,'period_candidates':counts,'cells':cells,'sources':sources,'issues':issues}

if __name__=='__main__':
 path=sys.argv[1];layout=read_pdf(path);result={'layout':layout,'finance':finance(layout)}
 Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False,indent=2))
