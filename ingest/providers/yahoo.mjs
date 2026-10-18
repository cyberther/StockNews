// Yahoo Finance through yahoo-finance2 (github.com/gadicc/yahoo-finance2): quotes for every
// market the apps cover, many symbols per request, and analyst recommendation counts.
// Unofficial and unlicensed: dev_only. Never shown signed out or in paid features.
const CHUNK = 50;
const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
// A US share class is BRK.B in the apps and BRK-B at Yahoo.
const toYahoo = s => (/^[A-Z]{1,5}\.[A-C]$/.test(s) ? s.replace('.', '-') : s);
const fromYahoo = s => (/^[A-Z]{1,5}-[A-C]$/.test(s) ? s.replace('-', '.') : s);
// London prices stay in pence, as the exchange and the apps show them; Yahoo writes GBp or GBX.
const currency = c => (c === 'GBX' ? 'GBp' : c || null);

export function createYahoo({ client }) {
  const base = { source: 'yahoo', license: 'dev_only' };
  return {
    name: 'yahoo',
    license: 'dev_only',
    configured: !!client,
    supports: cap => cap === 'quotes' || cap === 'recommendation',
    async quotes(symbols) {
      const out = [];
      for (let i = 0; i < symbols.length; i += CHUNK) {
        const rows = await client.quote(symbols.slice(i, i + CHUNK).map(toYahoo), { return: 'array' });
        for (const r of rows || []) {
          const price = num(r.regularMarketPrice);
          if (price == null || !r.symbol) continue;
          const t = r.regularMarketTime instanceof Date ? r.regularMarketTime : r.regularMarketTime ? new Date(r.regularMarketTime) : null;
          out.push({ symbol: fromYahoo(String(r.symbol).toUpperCase()), price, change: num(r.regularMarketChange),
            change_pct: num(r.regularMarketChangePercent), prev_close: num(r.regularMarketPreviousClose),
            currency: currency(r.currency), market_time: t && !isNaN(t) ? t.toISOString() : null, ...base,
            // The company name, for public.ticker_names (not a column of market_quotes).
            name: String(r.longName || r.shortName || '').trim() || null });
        }
      }
      return out;
    },
    async recommendation(symbol) {
      const r = await client.quoteSummary(toYahoo(symbol), { modules: ['recommendationTrend'] });
      const t = r && r.recommendationTrend && r.recommendationTrend.trend && r.recommendationTrend.trend[0];
      if (!t) return null;
      const buy = (t.strongBuy || 0) + (t.buy || 0), hold = t.hold || 0, sell = (t.sell || 0) + (t.strongSell || 0);
      if (!buy && !hold && !sell) return null;
      return { symbol, status: 'ok', buy, hold, sell, period: t.period || null, ...base };
    }
  };
}

// The real client. fetch is passed in so every HTTP request can be counted.
export async function yahooClient(fetchImpl) {
  const { default: YahooFinance } = await import('yahoo-finance2');
  return new YahooFinance({ fetch: fetchImpl, suppressNotices: ['yahooSurvey'], validation: { logErrors: false } });
}
