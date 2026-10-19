// The Government's notes (gov.ro, "Note de fundamentare"): one per decision (HG) it adopted, the
// note itself carrying the financial impact section. Read as adopted acts; the note page is the
// event's document (ingest/policy/documents.mjs).
import { text, clip } from './common.mjs';

export const GOV_NOTES_URL = 'https://gov.ro/ro/guvernul/procesul-legislativ/note-de-fundamentare';

export function parseGovNotes(html) {
  const out = [], seen = new Set();
  for (const m of String(html || '').matchAll(/<div class="album[^"]*">([\s\S]*?)(?=<div class="album|<\/section|$)/g)) {
    const block = m[1];
    const a = /<h2[^>]*>\s*<a href="(https:\/\/gov\.ro\/ro\/guvernul\/procesul-legislativ\/note-de-fundamentare\/[^"&]+)[^"]*">([^<]*)<\/a>/.exec(block);
    if (!a) continue;
    const head = /HG\s+nr\.?\s*(\d+)\s*\/\s*(\d{2})\.(\d{2})\.(\d{4})/i.exec(text(a[2]));
    if (!head) continue;
    const [, num, d, mo, y] = head, id = `gov:hg-${num}-${y}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const desc = /<div class="description"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const subject = text(desc ? desc[1] : '').replace(/^Hot[aă]r[aâ]re\s+\d+\/\d{4}-\d{2}-\d{2}\s*/i, '').replace(/^Guvernul Rom[aâ]niei\s*/i, '').replace(/\s*Monitorul Oficial al Rom[aâ]niei\b.*$/i, '').trim();
    out.push({
      id, title: clip(`HG ${num}/${y}: ${subject || 'hotărâre a Guvernului'}`, 500), summary: null,
      event_date: `${y}-${mo}-${d}`, institution: 'Guvernul României', initiator: 'Guvernul României', doc_number: `HG ${num}/${y}`,
      source_url: a[1], status: 'adopted', stage: `adoptată ${d}.${mo}.${y}`, certainty: 'official_act'
    });
  }
  return out;
}
