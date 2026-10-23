// Evidence is internal to extraction; public filing JSON keeps its existing shape.
const fold = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
export const EVIDENCE_RULES = {
  dividend: `Determine the dividend stage ONLY from this document, never from today's date, a scheduled payment date, or the meeting date. A board proposal, explanatory note, agenda or draft resolution remains proposed even when its draft says "AGOA aprobă". "Hotărârea propusă", "propune spre aprobarea", "subject to approval", "proposed resolution" describe a proposal, not a completed vote. approved requires an explicit account of an adopted resolution or completed shareholder approval; paid requires an actual payment announcement, not a proposed payment timetable. Return status_evidence: one EXACT contiguous quote of 2-12 words from the document supporting that stage, with NO ellipses, NO omitted words and NO surrounding quotation marks. Prefer a short heading such as Hotărârea propusă when it appears verbatim; do not quote the amount instead of the stage. For a proposal quote its proposal wording, not the draft decision. For none quote an explicit statement that no dividend is distributed, or use null when no dividend terms are present. Do not infer approval from a future payment date.`,
  results: `consolidated describes the BASIS OF THE FIGURES YOU EXTRACT, not whether the issuer belongs to a group. true means consolidated/group financial statements; false means separate/standalone/individual financial statements. A mention of subsidiaries, a parent or "the Group and the Company" alone is not evidence of consolidation. If both bases appear, prefer clearly labelled consolidated figures and keep all figures on that basis; do not mix the bases. If the basis cannot be tied to the extracted figures, use null. Return consolidated_evidence: one EXACT contiguous quote of 2-12 words supporting the basis, with NO ellipses, omitted words or surrounding quotation marks, or null if consolidated is null. Preserve the heading identifying the statements even when the financial figures occur elsewhere.`
};

export function evidenceSchema(kind, schema) {
  const key = kind === 'dividend' ? 'status_evidence' : kind === 'results' ? 'consolidated_evidence' : null;
  return key ? { ...schema, required: [...schema.required, key], properties: { ...schema.properties, [key]: { type: ['string', 'null'] } } } : schema;
}

export function checkEvidence(kind, data, source) {
  if (!data || !['dividend', 'results'].includes(kind)) return '';
  const quote = kind === 'dividend' ? data.status_evidence : data.consolidated_evidence;
  const q = fold(quote).replace(/^["“”]+|["“”]+$/g, '').trim(), text = fold(source);
  if (quote != null && (!q || !text.includes(q))) return 'evidence quote not found in document';
  if (kind === 'results') {
    if (data.consolidated == null) return '';
    if (!q) return 'financial basis needs evidence';
    const negatedGroup = /\b(?:non[- ]?consolidated|unconsolidated|not consolidated|neconsolidat[ae]?)\b/.test(q);
    const separate = negatedGroup || /\b(?:separate|stand[- ]?alone|individual[ae]?)\b/.test(q);
    const group = !negatedGroup && /\bconsolidat(?:ed|e|a)?\b/.test(q);
    if (data.consolidated === true && (!group || separate)) return 'consolidated basis not supported unambiguously';
    if (data.consolidated === false && (!separate || group)) return 'separate basis not supported unambiguously';
  } else {
    if (data.status === 'none') return '';
    if (!q) return 'dividend stage needs evidence';
    const proposal = /propus|propun|propos|subject to approval|draft|spre aprobare|supus.{0,30}aprobar/.test(q);
    if (data.status === 'proposed' && !proposal) return 'proposal stage needs explicit proposal wording';
    if (['approved', 'paid'].includes(data.status) && /not (?:yet )?approved|nu (?:a|au) aprobat|neaprobat|not (?:yet )?paid/.test(q)) return 'negative evidence cannot support approval or payment';
    if (['approved', 'paid'].includes(data.status) && proposal) return 'proposal evidence cannot support approved or paid';
    if (data.status === 'approved' && !/aprobat|a aprobat|au aprobat|adoptat|approved|adopted/.test(q)) return 'completed shareholder approval not evidenced';
    if (data.status === 'paid' && !/plata|platii|platit|payment|paid/.test(q)) return 'payment announcement not evidenced';
    // A clearly labelled proposed resolution must not be promoted using its draft wording.
    if (['approved', 'paid'].includes(data.status) && /hotararea propusa|proposed resolution|draft resolution/.test(text)
      && !/hotarar(?:ea|ile).{0,25}adoptat|resolution.{0,25}adopted|a aprobat|au aprobat|has approved|have approved/.test(q)) return 'draft resolution is not an adopted decision';
  }
  return '';
}

export function publicFigures(data) {
  const { status_evidence, consolidated_evidence, ...figures } = data;
  return figures;
}
