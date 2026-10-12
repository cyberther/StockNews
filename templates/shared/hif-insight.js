// Insight layer: the reasoning the app does on top of quotes — why a stock moved,
// what a holding is worth, and where the evidence disagrees with itself.
// Pure functions on plain data. Consumed via window.HIFInsight.
(function(){

function num(s) {
  const v = parseFloat(String(s == null ? '' : s).replace('\u2212','-').replace(/[^0-9.\-]/g, ''));
  return isFinite(v) ? v : null;
}
function pctNum(s) { const v = num(s); return v == null ? null : v; }
function money(v, cur) {
  const c = cur || '$';
  const a = Math.abs(v);
  const s = a >= 1000 ? a.toLocaleString(undefined, { maximumFractionDigits:0 }) : a.toFixed(2);
  return (v < 0 ? '\u2212' : '') + c + s;
}
function signed(v, cur) { return (v > 0 ? '+' : v < 0 ? '\u2212' : '') + money(Math.abs(v), cur).replace('\u2212',''); }

// ---------------------------------------------------------------- attribution
// Answers "why did it move?" — and, just as importantly, says so when nothing
// in the available evidence explains it. Ranked: company news > filing/insider >
// sector move > unexplained.
function attribute(input) {
  const i = input || {};
  const move = pctNum(i.movePct);
  if (move == null) return null;
  const mag = Math.abs(move);
  if (mag < 0.75) return { kind:'quiet', label:'Quiet session', detail:'Move is inside the normal daily range.', confidence:'', weight:0 };

  const news = (i.news || []).filter(n => n.sameDay !== false);
  const top = news[0];
  const sig = (i.signals || []).filter(s => /^\d+h$/.test(String(s.stamp || '')) || String(s.stamp) === '1d');

  // Sector: how many peers moved the same way, and by how much
  const peers = (i.peers || []).map(p => ({ ticker:p.ticker, move:pctNum(p.move) })).filter(p => p.move != null);
  const sameWay = peers.filter(p => (p.move > 0) === (move > 0) && Math.abs(p.move) > 0.5);
  const peerMed = sameWay.length ? sameWay.map(p => p.move).sort((a,b) => a - b)[Math.floor(sameWay.length/2)] : null;
  const sectorDriven = peers.length >= 2 && sameWay.length >= Math.ceil(peers.length * 0.6) && peerMed != null && Math.abs(peerMed) >= mag * 0.5;

  if (top && mag >= 1.2) {
    // Company news beats sector when the stock clearly outran its peers.
    const excess = peerMed == null ? mag : mag - Math.abs(peerMed);
    if (!sectorDriven || excess >= mag * 0.5) {
      return { kind:'news', label:'Company news', detail:top.headline, source:top.source, url:top.url || '',
        confidence: excess >= mag * 0.6 ? 'high' : 'medium',
        note: peerMed == null ? '' : 'Outran the sector by ' + Math.abs(excess).toFixed(1) + ' pts.', weight:3 };
    }
  }
  if (sectorDriven) {
    return { kind:'sector', label:(i.sector || 'Sector') + ' move', confidence:'high', weight:2,
      detail: sameWay.length + ' of ' + peers.length + ' peers moved the same way, median ' + (peerMed > 0 ? '+' : '\u2212') + Math.abs(peerMed).toFixed(1) + '%.',
      note:'Not company-specific.' };
  }
  if (sig.length) {
    const s = sig[0];
    return { kind:'filing', label: s.type === 'insider' ? 'Insider activity' : 'Regulatory filing', confidence:'low', weight:1,
      detail: s.type === 'insider'
        ? s.who + ' (' + s.role + ') ' + (s.act === 'buy' ? 'bought' : 'sold') + ' ' + s.shares + ' shares'
        : 'Form ' + s.form + ' \u00b7 ' + s.item,
      note:'Timing lines up; causation unproven.' };
  }
  return { kind:'none', label:'No attributable cause', confidence:'', weight:0,
    detail:'No company news, filing or sector move explains today\u2019s ' + (move > 0 ? '+' : '\u2212') + mag.toFixed(1) + '%.',
    note:'Most likely flow or positioning.' };
}

// ------------------------------------------------------------------ positions
// A watchlist is curiosity; a position is exposure. Everything downstream
// (alerts, ranking, the daily close) reads from these numbers.
function position(pos, priceStr, movePct, currency) {
  if (!pos || !pos.shares) return null;
  const price = num(priceStr), shares = num(pos.shares), cost = num(pos.cost);
  if (price == null || !shares) return null;
  const value = price * shares;
  const move = pctNum(movePct) || 0;
  const prevPrice = price / (1 + move / 100);
  const dayPL = (price - prevPrice) * shares;
  const totalPL = cost == null ? null : (price - cost) * shares;
  const plPct = (cost == null || !cost) ? null : (price / cost - 1) * 100;
  return {
    shares, cost, price, value,
    valueLabel: money(value, currency),
    dayPL, dayLabel: signed(dayPL, currency), dayUp: dayPL >= 0,
    totalPL, totalLabel: totalPL == null ? null : signed(totalPL, currency), totalUp: totalPL != null && totalPL >= 0,
    plPct, plPctLabel: plPct == null ? null : (plPct >= 0 ? '+' : '\u2212') + Math.abs(plPct).toFixed(1) + '%'
  };
}

function portfolio(positions, priceOf, moveOf, currency) {
  const rows = Object.keys(positions || {}).map(t => {
    const p = position(positions[t], priceOf(t), moveOf(t), currency);
    return p ? Object.assign({ ticker:t }, p) : null;
  }).filter(Boolean);
  const value = rows.reduce((a,r) => a + r.value, 0);
  const dayPL = rows.reduce((a,r) => a + r.dayPL, 0);
  const totalPL = rows.reduce((a,r) => a + (r.totalPL || 0), 0);
  rows.forEach(r => { r.weight = value ? r.value / value * 100 : 0; r.weightLabel = r.weight.toFixed(0) + '%'; });
  rows.sort((a,b) => b.value - a.value);
  return {
    rows, value, dayPL, totalPL, empty: !rows.length,
    valueLabel: money(value, currency),
    dayLabel: signed(dayPL, currency), dayUp: dayPL >= 0,
    totalLabel: signed(totalPL, currency), totalUp: totalPL >= 0,
    dayPctLabel: value ? ((dayPL / (value - dayPL)) * 100 >= 0 ? '+' : '\u2212') + Math.abs((dayPL / (value - dayPL)) * 100).toFixed(2) + '%' : ''
  };
}

// ------------------------------------------------------------- holdings table
// A broker-style positions table: one row per position, each in its listing's own
// currency (no conversion), so totals are kept per currency. quoteOf(t) returns
// { price, move, name, currency } with price/move as the app displays them.
const fmt = (v, d) => v.toLocaleString('en-US', { minimumFractionDigits:d, maximumFractionDigits:d });
const NONE = '—';
const sgn = v => v > 0 ? '+' : v < 0 ? '−' : '';
const amt = (v, cur) => v == null ? NONE : (v < 0 ? '−' : '') + fmt(Math.abs(v), 2) + ' ' + cur;
const signedAmt = (v, cur) => v == null ? NONE : sgn(v) + fmt(Math.abs(v), 2) + ' ' + cur;
const pctL = v => v == null ? NONE : sgn(v) + Math.abs(v).toFixed(2) + '%';
const priceL = v => v == null ? NONE : fmt(v, v < 10 ? 4 : 2);
const qtyL = v => v.toLocaleString('en-US', { maximumFractionDigits:4 });

function holdings(positions, quoteOf) {
  const rows = [];
  Object.keys(positions || {}).forEach(t => {
    const p = positions[t] || {}, shares = num(p.shares), avg = num(p.cost);
    if (!shares || shares <= 0) return;
    const q = quoteOf(t) || {}, cur = q.currency || 'USD';
    const price = num(q.price), move = pctNum(q.move);
    const value = price == null ? null : price * shares;
    const cost = avg == null ? null : avg * shares;
    const pl = value != null && cost != null ? value - cost : null;
    const plPct = pl != null && cost ? pl / cost * 100 : null;
    const dayPL = value != null && move != null ? value - value / (1 + move / 100) : null;
    rows.push({ ticker:t, name:q.name || '', currency:cur, shares, avg, price, move, value, cost, pl, plPct, dayPL });
  });
  const groups = {};
  rows.forEach(r => {
    const g = groups[r.currency] || (groups[r.currency] = { currency:r.currency, value:0, cost:0, pl:0, dayPL:0, n:0 });
    if (r.value != null) g.value += r.value;
    if (r.pl != null) { g.pl += r.pl; g.cost += r.cost; }
    if (r.dayPL != null) g.dayPL += r.dayPL;
    g.n++;
  });
  rows.sort((a, b) => (b.value || 0) - (a.value || 0) || a.ticker.localeCompare(b.ticker));
  rows.forEach(r => {
    const g = groups[r.currency], weight = r.value != null && g.value ? r.value / g.value * 100 : null;
    Object.assign(r, {
      weight,
      qtyLabel: qtyL(r.shares),
      avgLabel: priceL(r.avg),
      priceLabel: r.price == null ? NONE : priceL(r.price) + ' ' + r.currency,
      valueLabel: amt(r.value, r.currency),
      costLabel: amt(r.cost, r.currency),
      plLabel: signedAmt(r.pl, r.currency),
      plPctLabel: pctL(r.plPct),
      moveLabel: pctL(r.move),
      dayLabel: signedAmt(r.dayPL, r.currency),
      weightLabel: weight == null ? NONE : weight.toFixed(2) + '%',
      plDown: r.pl != null && r.pl < 0, moveDown: r.move != null && r.move < 0
    });
  });
  const totals = Object.keys(groups).sort().map(k => {
    const g = groups[k], plPct = g.cost ? g.pl / g.cost * 100 : null;
    return { currency:k, count:g.n,
      valueLabel: amt(g.value, k), costLabel: g.cost ? amt(g.cost, k) : NONE,
      plLabel: g.cost ? signedAmt(g.pl, k) : NONE, plPctLabel: pctL(plPct), plDown: g.pl < 0,
      dayLabel: signedAmt(g.dayPL, k), dayDown: g.dayPL < 0,
      dayPctLabel: pctL(g.value - g.dayPL ? g.dayPL / (g.value - g.dayPL) * 100 : null) };
  });
  return { rows, totals, empty: !rows.length };
}

// --------------------------------------------------------- portfolio history
// Value of today's holdings over a chart range: for each moment, shares x that ticker's
// close (carried forward between its bars), summed. Quantities are taken as held for the
// whole range (no trade history), so this is "what these positions were worth then".
// P/L is against the cost of the positions that have an average price.
// chartOf(t) -> [{ ts, close }] for the range; undefined while loading, null if unavailable
// (that ticker is then left out and `partial` is set).
function portfolioSeries(positions, chartOf, currencyOf, currency) {
  const held = Object.keys(positions || {}).filter(t => num((positions[t] || {}).shares) > 0 && (currencyOf(t) || 'USD') === currency);
  const lines = held.map(t => ({ t, shares: num(positions[t].shares), avg: num(positions[t].cost), pts: chartOf(t) }));
  const ready = lines.filter(l => Array.isArray(l.pts) && l.pts.length);
  const loading = lines.some(l => l.pts === undefined);
  if (!ready.length || loading) return { points: [], loading, currency, cost: 0 };
  const stamps = [];
  ready.forEach(l => l.pts.forEach(p => stamps.push(p.ts)));
  const times = Array.from(new Set(stamps)).sort((a, b) => a - b);
  const cost = ready.reduce((a, l) => a + (l.avg == null ? 0 : l.avg * l.shares), 0);
  const idx = ready.map(() => 0);
  const points = times.map(ts => {
    let value = 0, basisValue = 0;
    ready.forEach((l, i) => {
      while (idx[i] + 1 < l.pts.length && l.pts[idx[i] + 1].ts <= ts) idx[i]++;
      const v = l.pts[idx[i]].close * l.shares;
      value += v;
      if (l.avg != null) basisValue += v;
    });
    const pl = cost ? basisValue - cost : null;
    return { ts, value, pl, plPct: cost ? pl / cost * 100 : null };
  });
  return { points, loading: false, currency, cost, partial: ready.length < lines.length };
}
const portfolioLabels = (p, cur) => p ? {
  valueLabel: amt(p.value, cur), plLabel: signedAmt(p.pl, cur), plPctLabel: pctL(p.plPct), plDown: p.pl != null && p.pl < 0
} : null;

// --------------------------------------------------------------- contradiction
// Every app shows analysts, insiders and price in separate panels and lets you
// miss the conflict between them. Making disagreement a first-class object is
// the whole point of this function.
function conflicts(input) {
  const i = input || {}, out = [];
  const move = pctNum(i.movePct);
  const am = /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/.exec(String(i.analystDetail || ''));
  const buys = am ? +am[1] : null, holds = am ? +am[2] : null, sells = am ? +am[3] : null;
  const tot = am ? (buys + holds + sells) : 0;
  const sig = i.signals || [];
  const insider = sig.filter(s => s.type === 'insider');
  const sold = insider.filter(s => s.act === 'sell');
  const bought = insider.filter(s => s.act === 'buy');

  if (tot && buys / tot >= 0.6 && sold.length >= 2) {
    out.push({ tone:'warn', title:'Analysts bullish, insiders selling',
      detail: buys + ' of ' + tot + ' analysts say buy, but ' + sold.length + ' officers sold in the last 30 days \u2014 including ' + sold[0].who + ' (' + sold[0].role + ').' });
  }
  if (tot && sells / tot >= 0.3 && bought.length) {
    out.push({ tone:'note', title:'Analysts cautious, insiders buying',
      detail: sells + ' of ' + tot + ' analysts say sell, yet ' + bought[0].who + ' (' + bought[0].role + ') bought ' + bought[0].shares + ' shares.' });
  }
  if (move != null && tot && buys / tot >= 0.6 && move <= -2) {
    out.push({ tone:'warn', title:'Consensus buy, price falling',
      detail:'Down ' + Math.abs(move).toFixed(1) + '% today against a ' + Math.round(buys / tot * 100) + '% buy consensus.' });
  }
  if (i.rsi != null && move != null) {
    if (i.rsi >= 70 && move > 0) out.push({ tone:'note', title:'Extended', detail:'RSI ' + i.rsi.toFixed(0) + ' on a rising day \u2014 stretched versus its own recent range.' });
    if (i.rsi <= 30 && move < 0) out.push({ tone:'note', title:'Washed out', detail:'RSI ' + i.rsi.toFixed(0) + ' on a falling day \u2014 oversold versus its own recent range.' });
  }
  return out;
}

// ------------------------------------------------------------------- crowding
// When the same handful of names sits in everyone's book, that is information.
// Consensus positioning is a risk nobody surfaces to retail investors.
function crowding(ticker, crowd, labels) {
  const l = labels || {};
  const pct = (crowd || {})[ticker];
  // Under 10% there is no crowd to speak of — a near-empty bar reads as data
  // where there is none, so the panel stays closed.
  if (pct == null || pct < 10) return null;
  const tone = pct >= 75 ? 'alarm' : pct >= 60 ? 'warn' : pct <= 20 ? 'edge' : 'normal';
  return {
    pct, pctLabel: pct + '%',
    tone,
    zone: tone === 'alarm' ? (l.zoneAlarm || '') : tone === 'warn' ? (l.zoneCrowded || '')
      : tone === 'edge' ? (l.zoneEdge || '') : (l.zoneNormal || ''),
    note: (tone === 'alarm' || tone === 'warn') ? (l.crowded || '') : tone === 'edge' ? (l.contrarian || '') : (l.normal || ''),
    fill: Math.max(2, Math.min(100, pct)),
    marks: [20, 60, 75]
  };
}

// Position-weighted crowding of the whole book: how much of your money sits in
// names everybody else already owns.
function bookCrowding(positions, crowd, priceOf) {
  const keys = Object.keys(positions || {});
  if (!keys.length) return null;
  let value = 0, weighted = 0, known = 0;
  keys.forEach(t => {
    const p = num(priceOf(t)), sh = num((positions[t] || {}).shares);
    if (p == null || !sh) return;
    const v = p * sh; value += v;
    const c = (crowd || {})[t];
    if (c != null) { weighted += c * v; known += v; }
  });
  if (!known) return null;
  const pct = weighted / known;
  return { pct, pctLabel: pct.toFixed(0) + '%', tone: pct >= 60 ? 'warn' : pct <= 25 ? 'edge' : 'normal', fill: Math.max(2, Math.min(100, pct)) };
}

// -------------------------------------------------------------- regret ledger
// Track what the user chose to ignore and what happened next. Makes the app's
// value measurable instead of asserted — and it compounds with use.
// A skip needs time before it can be judged: anything younger than this is
// carried as pending and kept out of the accuracy score.
const LEDGER_SETTLE_MS = 90 * 60 * 1000;

function ledger(entries, priceOf, labels) {
  const l = labels || {};
  const rows = (entries || []).map((e, idx) => {
    const now = num(priceOf(e.ticker));
    // Price at the moment of the skip, read off the same history the chart draws.
    const back = window.HIFChart && e.ts ? window.HIFChart.priceAt(e.ticker, (Date.now() - e.ts) / 1000, now) : null;
    const then = back == null ? num(e.price) : back;
    const movePct = (now == null || then == null || !then) ? null : (now / then - 1) * 100;
    // "Missed" = it ran without you. "Dodged" = skipping saved you the drop.
    // Direction of the skipped story decides which is which.
    const bullish = e.up !== false;
    const settled = !e.ts || (Date.now() - e.ts) >= LEDGER_SETTLE_MS;
    let verdict = 'flat', label = l.flat || 'No move';
    if (!settled) { verdict = 'pending'; label = l.pending || 'Too early to call'; }
    else if (movePct != null && Math.abs(movePct) >= 1.5) {
      const helpful = bullish ? movePct < 0 : movePct > 0;
      verdict = helpful ? 'dodged' : 'missed';
      label = helpful ? (l.dodged || 'Dodged') : (l.missed || 'Missed');
    }
    return {
      id: e.id || ('t' + (e.ts || 0) + '-' + idx),
      ticker: e.ticker, headline: e.headline, source: e.source || '',
      when: e.when || '', ts: e.ts,
      priceThen: then == null ? '—' : then.toFixed(2),
      priceNow: now == null ? '—' : now.toFixed(2),
      movePct,
      moveLabel: movePct == null ? '—' : (movePct >= 0 ? '+' : '\u2212') + Math.abs(movePct).toFixed(1) + '%',
      up: movePct != null && movePct >= 0,
      settled, direction: bullish ? 'up' : 'down',
      verdict, verdictLabel: label
    };
  }).sort((a,b) => (b.ts || 0) - (a.ts || 0));
  const judged = rows.filter(r => r.verdict === 'dodged' || r.verdict === 'missed');
  const right = judged.filter(r => r.verdict === 'dodged').length;
  return {
    rows, empty: !rows.length,
    judged: judged.length,
    pending: rows.filter(r => r.verdict === 'pending').length,
    accuracy: judged.length ? right / judged.length * 100 : null,
    accuracyLabel: judged.length ? Math.round(right / judged.length * 100) + '%' : '—',
    missed: rows.filter(r => r.verdict === 'missed').length,
    dodged: right
  };
}

window.HIFInsight = { attribute, position, portfolio, holdings, portfolioSeries, portfolioLabels, amt, signedAmt, pctL, conflicts, crowding, bookCrowding, ledger, money, signed, num };
})();
