// Politici 2.0 in the app (StockNewsWeb.dc.html, hif-policy.js, hif-data.js): fact sheets with
// their reasons, automatic analyses labelled and warned about, withdrawal, and the "Cine câștigă"
// tab with its fixed legal band. Behind the autoImpact and whoGains flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('templates/stock-news-web/StockNewsWeb.dc.html');
const win = { };
vm.runInNewContext(read('templates/shared/hif-data.js'), { window: win, console, location: { protocol: 'https:', hostname: 'x', origin: 'https://x', pathname: '/', search: '' }, fetch: () => Promise.reject(new Error('offline')), document: { dispatchEvent() {} }, CustomEvent: function(){} });
const UI = win.HIF.UI;
const REASONS = ['no_figures', 'no_financial_sheet', 'type_not_modelled', 'no_company_data', 'missing_assumption', 'quote_not_found', 'ai_pending', 'source_unreadable'];
const LEGAL_RO = 'Informații despre deciziile statului, nu recomandări de investiții. Strategia și deciziile îți aparțin. Market Pulse nu este consultant de investiții autorizat (ASF).';

test('every reason code and every new label has Romanian, English and German text', () => {
  for (const lang of ['RO', 'EN', 'DE']) {
    for (const c of REASONS) assert.ok(UI[lang]['polWhy_' + c], lang + ' polWhy_' + c);
    for (const k of ['polWhyTitle', 'polSheetSummary', 'polDocs', 'autoLabel', 'autoWarn', 'withdrawnLabel', 'withdrawBtn', 'withdrawAsk', 'gainsTab', 'gainsLegal',
      'gainsMeasures', 'gainsCompanies', 'gainsSectors', 'gainsMine', 'gainsGains', 'gainsLoses', 'gainsNeutral', 'gainsContracts12m', 'gainsAid12m', 'gainsPctRevenue',
      'gainsEvidence', 'gainsEmpty', 'gainsCpv', 'gainsActs', 'link_named', 'link_sector', 'link_contract', 'link_state_aid', 'link_tax_payer'])
      assert.ok(UI[lang][k], lang + ' ' + k);
  }
  assert.equal(UI.RO.gainsLegal, LEGAL_RO);
});

test('no new text sounds like advice, in any language', () => {
  const advice = /cump[aă]r|vinde|v[aâ]nz|recomand|[tț]int[aă] de pre[tț]|\bbuy|\bsell|recommend|price target|kaufen|verkauf|empfehl|kursziel/i;
  for (const lang of ['RO', 'EN', 'DE']) for (const [k, v] of Object.entries(UI[lang]))
    if (/^(polWhy|polSheet|polDocs|auto|withdraw|gains|link_)/.test(k)) assert.doesNotMatch(String(v).replace(/nu recomandări de investiții|not investment recommendations|keine Anlageempfehlungen/gi, ''), advice, lang + ' ' + k);
});

test('the legal band is always shown on the tab and the automatic label on automatic analyses', () => {
  const tab = app.slice(app.indexOf('<sc-if value="{{ gainsShow }}"'), app.indexOf('<!-- /gains -->'));
  assert.ok(tab.length > 100, 'the tab exists');
  const band = tab.indexOf('{{ ui.gainsLegal }}');
  assert.ok(band > 0 && band < tab.indexOf('{{ gainsViews }}') + 1000, 'the band is at the top');
  assert.doesNotMatch(tab.slice(0, band), /<sc-if value="\{\{ (?!gainsShow)/, 'nothing can hide the band');
  assert.match(app, /impDAuto[\s\S]{0,400}ui\.autoLabel[\s\S]{0,400}ui\.autoWarn/);
  assert.match(app, /origin === 'auto'/);
  assert.match(app, /admin_withdraw_analysis/);
});

test('with the flags off nothing new is asked for or shown', () => {
  assert.match(app, /flagOn\('whoGains'\) \? \[tabBtn\('gains'/);
  assert.match(app, /if \(!flagOn\('autoImpact'\)\) return/);
  const flags = JSON.parse(read('config/flags.json'));
  assert.equal(flags.autoImpact, false);
  assert.equal(flags.whoGains, false);
});

test('the policy client asks for sheets, links, exposure and flows with safe filters', () => {
  const ctx = { window: { HIFAuth: null }, encodeURIComponent };
  vm.runInNewContext(read('templates/shared/hif-policy.js'), ctx);
  const Q = ctx.window.HIFPolicy.Q;
  assert.equal(Q.sheets(['cdep:1', 'bad id"', 'gov:hg-781-2026']), 'fact_sheets?select=event_id,summary,reasons,base,origin&event_id=in.(%22cdep:1%22,%22gov:hg-781-2026%22)');
  assert.match(Q.links({ tickers: ['TLV.RO', 'x"y'] }), /^state_links\?select=\*&subject_ticker=in\.\(%22TLV\.RO%22\)&order=at\.desc\.nullslast&limit=400$/);
  assert.match(Q.exposure(), /^company_state_exposure\?select=\*/);
  assert.match(Q.flows('2025-10-01'), /^sector_state_flows\?select=\*&month=gte\.2025-10-01/);
  assert.match(Q.flows('bad'), /month=gte\.\d{4}-\d{2}-\d{2}/);
});

test('the legal page explains automatic analyses, "who gains" and the new sources, in Romanian and English', () => {
  const legal = read('templates/stock-news-web/legal.html');
  const ro = legal.slice(0, legal.indexOf('<template id="doc-en">')), en = legal.slice(legal.indexOf('<template id="doc-en">'));
  assert.match(ro, /Analizele de impact automate[\s\S]{0,600}pot conține erori/);
  assert.match(ro, /„Cine câștigă”[\s\S]{0,400}nu (sunt )?recomandări/);
  assert.match(ro, /de verificat juridic/i);
  assert.match(ro, /Sursa: SEAP \/ data\.gov\.ro/);
  assert.match(ro, /CC BY 4\.0/);
  assert.match(en, /Automatic impact analyses[\s\S]{0,600}can contain errors/);
  assert.match(en, /“Who gains”[\s\S]{0,400}not (investment )?recommendations/);
  assert.match(en, /Source: SEAP \/ data\.gov\.ro/);
});
