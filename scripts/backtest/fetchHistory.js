// Historical data cache for the offline backtesting pipeline (see
// prancy-wibbling-feather.md, "Backtesting pipeline addendum"). Pages
// through Bybit's kline history via the SAME bybitClient used live —
// confirmed live that history is available well over a year back via
// start/end pagination, 200 candles per request.
//
// Usage: node scripts/backtest/fetchHistory.js SYMBOL1,SYMBOL2 DAYS
// e.g.:  node scripts/backtest/fetchHistory.js BTCUSDT,ETHUSDT 30
//
// Writes backtest-data/<symbol>/<tf>.json — array of {t,o,h,l,c,v},
// oldest -> newest, deduped across pagination pages.
const fs = require('fs');
const path = require('path');
const bybit = require('../../src/market/bybitClient');
const logger = require('../../src/utils/logger');

const INTERVAL_MAP = { h1: '60', m15: '15', m5: '5' };
const OUT_DIR = path.join(__dirname, '..', '..', 'backtest-data');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Pages backward from `endMs` to `startMs`, 200 candles per request, with
 * a small delay between requests to stay well under Bybit's rate limit.
 */
async function fetchRange(symbol, tf, startMs, endMs) {
  const interval = INTERVAL_MAP[tf];
  const all = [];
  let cursor = endMs;

  while (cursor > startMs) {
    const res = await bybit.getKline({ category: 'linear', symbol, interval, end: cursor, limit: 200 });
    if (res.retCode !== 0) {
      logger.warn('fetchHistory', 'getKline failed', { symbol, tf, retCode: res.retCode, retMsg: res.retMsg });
      break;
    }
    const page = res.result.list.map(r => ({
      t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
    }));
    if (page.length === 0) break;
    all.push(...page);
    const oldestInPage = Math.min(...page.map(c => c.t));
    if (oldestInPage >= cursor) break; // no progress, avoid infinite loop
    cursor = oldestInPage;
    await sleep(150);
  }

  const byTime = new Map(all.map(c => [c.t, c]));
  return Array.from(byTime.values())
    .filter(c => c.t >= startMs && c.t <= endMs)
    .sort((a, b) => a.t - b.t);
}

async function fetchSymbol(symbol, days) {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 3600 * 1000;
  const dir = path.join(OUT_DIR, symbol);
  fs.mkdirSync(dir, { recursive: true });

  for (const tf of ['h1', 'm15', 'm5']) {
    logger.info('fetchHistory', 'fetching', { symbol, tf, days });
    const candles = await fetchRange(symbol, tf, startMs, endMs);
    fs.writeFileSync(path.join(dir, `${tf}.json`), JSON.stringify(candles));
    logger.info('fetchHistory', 'saved', { symbol, tf, count: candles.length });
  }
}

async function main() {
  const [symbolsArg, daysArg] = process.argv.slice(2);
  if (!symbolsArg || !daysArg) {
    console.error('Usage: node scripts/backtest/fetchHistory.js SYMBOL1,SYMBOL2 DAYS');
    process.exit(1);
  }
  const symbols = symbolsArg.split(',').map(s => s.trim());
  const days = parseInt(daysArg, 10);

  for (const symbol of symbols) {
    await fetchSymbol(symbol, days);
  }
  logger.info('fetchHistory', 'done', { symbols, days });
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { fetchRange, fetchSymbol };
