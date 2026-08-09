// Kline fetching against Bybit Demo Trading, adapted from wicktor-scanner's
// api.js bybitKlines() for the bybit-api SDK's getKline() response shape.
const bybit = require('./bybitClient');
const logger = require('../utils/logger');

const INTERVAL_MAP = { h1: '60', m15: '15', m5: '5' };
const INTERVAL_MS = { h1: 3_600_000, m15: 900_000, m5: 300_000 };

/**
 * Returns the last `limit` CONFIRMED-CLOSED candles, oldest->newest, as
 * {t,o,h,l,c,v}, or null on failure. Bybit's kline endpoint includes the
 * still-forming current candle as its most recent entry — trimmed here so
 * every caller (signal scanning, stop-loss/jaw checks, entries) always
 * works off confirmed closes, never a mid-candle snapshot (brief section 4:
 * "Entry only on a confirmed candle close ... never mid-candle").
 */
async function getKlines(symbol, tf, limit = 150) {
  const interval = INTERVAL_MAP[tf];
  try {
    // Fetch one extra so trimming an unclosed candle still leaves `limit`.
    const res = await bybit.getKline({ category: 'linear', symbol, interval, limit: limit + 1 });
    if (res.retCode !== 0) {
      logger.warn('candles', 'getKline non-zero retCode', { symbol, tf, retCode: res.retCode, retMsg: res.retMsg });
      return null;
    }
    // Bybit returns newest-first: [start,open,high,low,close,volume,turnover]
    let candles = res.result.list
      .map(r => ({
        t: Number(r[0]), o: Number(r[1]), h: Number(r[2]),
        l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
      }))
      .reverse();

    const intervalMs = INTERVAL_MS[tf];
    while (candles.length > 0 && candles[candles.length - 1].t + intervalMs > Date.now()) {
      candles = candles.slice(0, -1);
    }
    return candles.slice(-limit);
  } catch (err) {
    logger.warn('candles', 'getKline threw', { symbol, tf, error: err.message });
    return null;
  }
}

/**
 * Fetches the {h1, m15, m5} candle set for one symbol, as required by
 * Scoring.evaluate().
 */
async function fetchCandleSet(symbol) {
  const [h1, m15, m5] = await Promise.all([
    getKlines(symbol, 'h1'),
    getKlines(symbol, 'm15'),
    getKlines(symbol, 'm5'),
  ]);
  return { h1, m15, m5 };
}

module.exports = { getKlines, fetchCandleSet };
