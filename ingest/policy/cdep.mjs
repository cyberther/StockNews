// The Chamber of Deputies' legislative tracking (www.cdep.ro, "Urmărirea procesului
// legislativ"): the initiatives registered in a year, and the laws promulgated in a year.
// Kept per row: the file number, the title, the stage as the Chamber words it, the dates and
// the links. Status comes only from which list a row is on and the stage's wording:
//   laws list                                  -> adopted     (official_act)
//   initiatives, stage with a law number        -> adopted     (official_act)
//   initiatives, "adoptat" / "la promulgare"    -> adopted     (official_procedure)
//   initiatives, stage ended/rejected/withdrawn -> stopped     (official_procedure)
//   initiatives, anything else                  -> draft       (official_procedure)
import { text, roDate, clip } from './common.mjs';

const BASE = 'https://www.cdep.ro';
export const cdepUrl = (kind, year) => `${BASE}/ords/pls/proiecte/upl_pck2015.lista?${kind === 'laws' ? 'anl' : 'anp'}=${year}`;
const STOPPED = /\b(incetat|respins|retras|clasat|restituit|scos de pe ordinea de zi)/;
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function parseCdepList(html, { kind }) {
  const out = [];
  for (const row of String(html || '').match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
    if (cells.length < 4) continue;
    const link = /href="([^"]*upl_pck2015\.proiect[^"]*idp=(\d+)[^"]*)"[^>]*>([^<]+)</i.exec(cells[1]);
    if (!link) continue;
    const doc = text(link[3]), title = text(cells[2]);
    if (!title) continue;
    const stageText = text(cells[3]), stageDate = roDate(stageText);
    const regDate = roDate(doc);
    const item = {
      id: 'cdep:' + link[2],
      title: clip(title, 500),
      event_date: stageDate || regDate,
      institution: 'Camera Deputaților',
      // PL-x: a government bill; Pl-x: a proposal by members of parliament.
      initiator: /^PL-x/.test(doc) ? 'Guvern' : /^Pl-x/i.test(doc) ? 'Parlamentari' : null,
      doc_number: doc,
      source_url: BASE + link[1].replace(/&amp;/g, '&'),
      status: 'draft',
      stage: stageText,
      certainty: 'official_procedure'
    };
    if (kind === 'laws') {
      const law = /href="([^"]*legis_pck\.htp_act[^"]*)"[^>]*>([^<]+)</i.exec(cells[3]);
      if (!law) continue;
      Object.assign(item, { status: 'adopted', certainty: 'official_act', doc_number: text(law[2]),
        stage: 'promulgată: ' + stageText, law_url: BASE + law[1].replace(/&amp;/g, '&') });
    } else {
      const law = /href="([^"]*legis_pck\.htp_act[^"]*)"[^>]*>([^<]+)</i.exec(cells[3]);
      const st = fold(stageText);
      if (law) Object.assign(item, { status: 'adopted', certainty: 'official_act', doc_number: text(law[2]), law_url: BASE + law[1].replace(/&amp;/g, '&') });
      // Passed by the deciding chamber, or sent for promulgation: adopted, as a procedure.
      else if (/^(adoptat|la promulgare)\b/.test(st)) item.status = 'adopted';
      else if (STOPPED.test(st)) item.status = 'stopped';
    }
    if (item.event_date) out.push(item);
  }
  return out;
}
