// Which symbols a run asks about: everything on anyone's watchlist (Following), every
// portfolio position, and the largest Bucharest listings (the BVB tab), once each. Listings
// nobody follows (the US and EU universe) stay out while universeScan is off.
import '../templates/shared/hif-markets.js';

const M = globalThis.HIFMarkets;
const SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const JUST_CLOSED_MS = 30 * 60000;

export function buildUniverse({ watchlist = [], holdings = [], bvbTop = [], flags = {} }) {
  const list = [];
  if (flags.following !== false) list.push(...watchlist);
  if (flags.portfolio !== false) list.push(...holdings);
  if (flags.bvb !== false) list.push(...bvbTop);
  return [...new Set(list.map(s => String(s || '').toUpperCase()).filter(s => SYMBOL.test(s) && M.marketOf(s)))].sort();
}

// intraday: symbols whose market trades now, or closed within the last 30 minutes (the run
// after the close picks up the closing prices). eod: all of them.
export function symbolsToFetch(universe, job, now = new Date()) {
  if (job === 'eod') return universe.slice();
  return universe.filter(s => tradingOrJustClosed(M.marketOf(s), now));
}
export function tradingOrJustClosed(market, now = new Date()) {
  if (M.isOpen(market, now)) return true;
  const c = M.lastClose(market, now);
  return !!c && now.getTime() - c.getTime() <= JUST_CLOSED_MS;
}

export const marketOf = s => M.marketOf(s);
