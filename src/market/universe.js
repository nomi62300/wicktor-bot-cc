// Tradeable-symbol universe: verifies real instrument category via
// instruments-info rather than inferring "is crypto" from the ticker
// string (fixes the old bot's bug #4 — a CLUSDT commodity perpetual slipped
// through a symbol-prefix heuristic and was only rejected by Bybit's own
// ToS check, not by the bot's own filter).
const bybit = require('./bybitClient');
const config = require('../config');
const logger = require('../utils/logger');

// Extra belt-and-suspenders exclusion for leveraged tokens, kept from the
// scanner project's isTradeableUsdtPair() even though Bybit's linear-perp
// category shouldn't surface these — cheap and harmless if redundant.
const LEVERAGED_PATTERN = /(UP|DOWN|BULL|BEAR)USDT$/;

async function fetchLinearUsdtPerpetuals() {
  const res = await bybit.getInstrumentsInfo({ category: 'linear', limit: 1000 });
  if (res.retCode !== 0) {
    logger.warn('universe', 'getInstrumentsInfo failed', { retCode: res.retCode, retMsg: res.retMsg });
    return [];
  }
  return res.result.list.filter(inst =>
    inst.contractType === 'LinearPerpetual' &&
    inst.quoteCoin === 'USDT' &&
    inst.status === 'Trading' &&
    !LEVERAGED_PATTERN.test(inst.symbol)
  );
}

async function fetchTickerMap() {
  const res = await bybit.getTickers({ category: 'linear' });
  if (res.retCode !== 0) {
    logger.warn('universe', 'getTickers failed', { retCode: res.retCode, retMsg: res.retMsg });
    return new Map();
  }
  return new Map(res.result.list.map(t => [t.symbol, t]));
}

/**
 * Returns the tradeable universe: linear, USDT-margined perpetuals,
 * verified via instruments-info category (not string heuristics), with
 * 24h turnover >= config.minTurnover24hUsdt.
 * Returns [{ symbol, turnover24h, lastPrice }], sorted by turnover desc.
 */
async function getTradeableUniverse() {
  const [instruments, tickerMap] = await Promise.all([
    fetchLinearUsdtPerpetuals(),
    fetchTickerMap(),
  ]);

  const universe = [];
  for (const inst of instruments) {
    const ticker = tickerMap.get(inst.symbol);
    if (!ticker) continue;
    const turnover24h = parseFloat(ticker.turnover24h || 0);
    if (turnover24h < config.minTurnover24hUsdt) continue;
    universe.push({
      symbol: inst.symbol,
      turnover24h,
      lastPrice: parseFloat(ticker.lastPrice),
    });
  }

  universe.sort((a, b) => b.turnover24h - a.turnover24h);
  return universe;
}

module.exports = { getTradeableUniverse, fetchLinearUsdtPerpetuals, fetchTickerMap };
