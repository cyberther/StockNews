"""Explicit fiscal-year groups, preserving ranges versus lists and conflicting events."""
import re
from layout import fold
LABEL=r'(?:financial years?|fiscal years?|exercitiul(?:ui)? financiar|exercitiilor financiare|an(?:ul|ului) financiar|anilor financiari)'
EXPR=re.compile(LABEL+r'\s*(20\d{2}(?:\s*(?:and|si|,|[-–])\s*20\d{2})*)')
def year_groups(text):
 out=[]
 for m in EXPR.finditer(fold(text)):
  raw=m.group(1);years=[int(y) for y in re.findall('20[0-9]{2}',raw)]
  if re.fullmatch(r'20\d{2}\s*[-–]\s*20\d{2}',raw):
   a,b=years
   if b<a or b-a>10:continue
   years=list(range(a,b+1))
  out.append((tuple(sorted(set(years))),m.group(0)))
 return out

def canonical_years(groups):
 unique={g for g,raw in groups}
 # Separate announcements for different years must never be silently unioned.
 return list(next(iter(unique))) if len(unique)==1 else None
