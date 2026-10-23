"""Conservative table footnotes: retain raw token and explicit, same-page definitions."""
import re
MARKERS=r'\*{1,4}|[†‡]|[¹²³⁴⁵⁶⁷⁸⁹]+'
def number_parts(raw):
 m=re.fullmatch(r'(.+?)('+MARKERS+r')',raw.strip())
 return (m.group(1).strip(),m.group(2)) if m else (raw,'')
def definitions(lines,marker,after=None):
 # Match the entire marker, so '*' cannot borrow the explanation of '**'.
 pattern=r'^\s*'+re.escape(marker)+r'(?![\*†‡¹²³⁴⁵⁶⁷⁸⁹])\s*\S'
 matches=[l for l in lines if re.match(pattern,l['text']) and (after is None or 0<l['y']-after<=250)]
 return matches if len(matches)==1 else []
