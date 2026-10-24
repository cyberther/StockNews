// The Finance Ministry's yearly statements (data.gov.ro, "Situațiile financiare 2024") read into
// the Financials tab's figures (tools/financials-lib.mjs mfColumns / mfFigures). The fixtures
// are the ministry's own files for 2024, cut down to a few listed companies (CC BY 4.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mfColumns, mfFigures, MF_KINDS } from '../tools/financials-lib.mjs';

const read = f => new TextDecoder('windows-1250').decode(readFileSync(new URL('./fixtures/mf/' + f, import.meta.url)));
function figures(data, spec) {
  const cols = mfColumns(read(spec)), lines = read(data).split(/\r?\n/).filter(Boolean), header = lines[0].split(',');
  return Object.fromEntries(lines.slice(1).map(l => { const c = l.split(','); return [c[0], mfFigures(cols, header, c)]; }));
}

test('column names are read from the ministry\'s .csv, a code written "12" included', () => {
  const c = mfColumns('CUI;CUI\nCifra de afaceri neta;i13\nPatrimoniul regiei;12\nPROFITUL SAU PIERDEREA (SOLD CREDITOR);i17\n');
  assert.equal(c.I13, 'cifra de afaceri neta');
  assert.equal(c.I12, 'patrimoniul regiei');
  assert.equal(c.CUI, undefined);
});

test('a company filing IFRS (Conpet): turnover, net profit, balance sheet, staff', () => {
  const d = figures('web_ir_an2024.txt', 'web_ir_2024.csv')['1350020'];
  assert.deepEqual(d, { revenue: 533618409, net_income: 49323047, assets: 853552052, liabilities: 69455084, equity: 730693250, cash: 136176830, employees: 1387 });
});

test('a bank (Banca Transilvania): operating income and the year\'s result, signed', () => {
  const d = figures('web_instit_de_credit_an2024.txt', 'web_inst_de_credit_2024.csv')['5022670'];
  assert.equal(d.net_income, 3531677657);
  assert.ok(d.revenue > 1e10 && d.cash > 1e10, JSON.stringify(d));
  assert.equal(d.assets, undefined, 'a bank\'s file has no total assets');
});

test('a market firm (BVB, BRK): debts due within and after a year added up, a loss kept negative', () => {
  const all = figures('web_vs_2024.txt', 'web_vs_2024.csv');
  assert.deepEqual(all['17777754'], { revenue: 39857894, net_income: 1188121, assets: 131096576, liabilities: 17133822, equity: 111884340, cash: 3290544, employees: 46 });
  assert.ok(all['6738423'].net_income < 0, 'BRK closed 2024 with a loss');
});

test('every kind of file the ministry publishes for companies has a reader', () => {
  for (const name of ['web_ir_an2024.txt', 'web_ir_2024.csv', 'web_instit_de_credit_an2024.txt', 'web_inst_de_credit_2024.csv', 'web_sif2024.txt', 'web_vs_2024.txt', 'WEBASIG2024.txt', 'web_bl_bs_sl_an2024.txt', 'web_uu_an2024.txt'])
    assert.ok(MF_KINDS.some(([, re]) => re.test(name)), name);
});
