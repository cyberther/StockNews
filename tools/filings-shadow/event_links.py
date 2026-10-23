import re,collections,math
from layout import fold,parse_number

def normalized(text):return re.sub(r'\s+',' ',fold(text))
def fiscal_years(text):
 q=normalized(text);out=set()
 for m in re.finditer(r'(?:exercitiul(?:ui)?\s+financiar|an(?:ul|ului)\s+financiar|financial year|fiscal year)\s*(20\d{2})',q):out.add(int(m.group(1)))
 for m in re.finditer(r'(?:anul|exercitiul) financiar incheiat la 31 (?:decembrie|december) (20\d{2})',q):out.add(int(m.group(1)))
 return out

def issuer_key(text):
 q=normalized(text)
 names=re.findall(r'\b([a-z][a-z0-9-]{3,})\s+s\.?\s*a\.?\b',q)
 names=[n for n in names if n not in {'central','generale','bucuresti','bank','banca'}]
 counts={n:len(re.findall(r'\b'+re.escape(n)+r'\b',q)) for n in names}
 if not counts:return None
 top=max(counts.values());best=[k for k,v in counts.items() if v==top]
 return best[0] if len(best)==1 else None

def link_page(anchor,page,between,amount,currency,years,prices):
 """Same PDF is guaranteed by caller. Never borrow another issuer/year/amount calendar."""
 key=issuer_key(anchor['text']);q=normalized(page['text']);reason=[]
 if not key or not re.search(r'\b'+re.escape(key)+r'\b',q):return None
 if page['page']<=anchor['page'] or page['page']-anchor['page']>3:return None
 chain=[*between,page];explicit=set().union(*(fiscal_years(p['text']) for p in chain))
 if not years or not explicit or not explicit.issubset(years):return None
 # Amount must be attached to per-share language/table, not occur as an arbitrary number.
 ps=prices(page['text'])
 if ps:
  if any(p['currency']!=currency or not math.isclose(p['value'],amount,rel_tol=0,abs_tol=1e-12) for p in ps):return None
 else:
  matched=False;column=None
  for line in page['text'].splitlines():
   if '|' not in line:
    if line.strip():column=None
    continue
   cols=[normalized(c).strip() for c in line.strip().strip('|').split('|')]
   headers=[i for i,c in enumerate(cols) if re.search(r'dividend brut.*(?:actiune|share)',c)]
   if headers:column=headers[0];continue
   if column is not None and len(cols)>column:
    value=parse_number(cols[column]);row_years={int(c) for c in cols if re.fullmatch('20[0-9]{2}',c)}
    if value is not None and math.isclose(value,amount,rel_tol=0,abs_tol=1e-12) and row_years and row_years.issubset(years):matched=True
  if not matched:return None
 currency_pattern=r'\bron\b|\blei\b' if currency=='RON' else r'\beur\b|\beuro\b'
 if not re.search(currency_pattern,q):return None
 return {'issuer':key,'gross_dps':amount,'currency':currency,'fiscal_years':sorted(years),'kind':'same_pdf_issuer_amount_year','sources':list(dict.fromkeys([anchor['source_id'],*[p['source_id'] for p in chain]]))}
