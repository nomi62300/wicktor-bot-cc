// Maintenance margin rate lookup, used to estimate liquidation distance.
// Cached per symbol since risk tiers change rarely.
const bybit = require('./bybitClient');

const cache = new Map();

/**
 * Returns the maintenance margin rate (as a fraction, e.g. 0.01 = 1%) for
 * the lowest-risk tier of a symbol — the tier essentially every position
 * this bot opens will fall into, given its flat 0.15%-risk sizing keeps
 * notional values far below the tier thresholds (typically $100k+).
 */
async function getMaintenanceMarginRate(symbol) {
  if (cache.has(symbol)) return cache.get(symbol);
  const res = await bybit.getRiskLimit({ category: 'linear', symbol });
  if (res.retCode !== 0 || !res.result.list.length) {
    throw new Error(`riskLimit: no data for ${symbol} (retCode=${res.retCode})`);
  }
  const lowestTier = res.result.list.find(t => t.isLowestRisk === 1) || res.result.list[0];
  const mmr = parseFloat(lowestTier.maintenanceMargin);
  cache.set(symbol, mmr);
  return mmr;
}

module.exports = { getMaintenanceMarginRate };
