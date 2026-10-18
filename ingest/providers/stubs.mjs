// Licensed providers, prepared but not connected: each needs a contract and a key first.
//   EODHD        covers the Bucharest exchange; commercial use needs a custom plan
//   Twelve Data  commercial plans for display
//   BVB          a direct data licence from the Bucharest Stock Exchange (redistribution)
// The licence given is the one the plan would be bought under; check it against the contract.
import { NotConfigured } from './index.mjs';

function stub(name, license) {
  const refuse = async () => { throw new NotConfigured(name); };
  return { name, license, configured: false, supports: cap => cap === 'quotes', quotes: refuse, recommendation: refuse };
}

export const eodhd = stub('eodhd', 'commercial_display');
export const twelvedata = stub('twelvedata', 'commercial_display');
export const bvb = stub('bvb', 'redistribution');
