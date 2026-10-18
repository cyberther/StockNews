// Market data providers for the ingestion jobs, behind one interface:
//
//   { name, license, configured, supports(capability),
//     quotes(symbols) -> Quote[], recommendation(symbol) -> Rec | null }
//
// Quote: { symbol, price, change, change_pct, prev_close, currency, market_time, source, license, name? }
// Rec:   { symbol, status: 'ok', buy, hold, sell, period, source, license }
//
// Every provider states the licence its data comes under (supabase/market-data.sql):
//   dev_only            development and personal use (yahoo-finance2)
//   commercial_display  may be shown in the product
//   redistribution      may be shown and passed on
// With commercialMode on (config/flags.json), dev_only providers are not used at all.
export const LICENSES = ['dev_only', 'commercial_display', 'redistribution'];

export class NotConfigured extends Error {
  constructor(name) { super(`${name} is not configured (no licence or key yet)`); this.name = 'NotConfigured'; }
}

export function providersFor(capability, { providers, commercialMode = false }) {
  return providers.filter(p => p.configured && p.supports(capability) && !(commercialMode && p.license === 'dev_only'));
}
