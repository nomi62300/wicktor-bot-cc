// Replays the REAL live signal engine (signalScanner.evaluateSymbol —
// the exact function cycle.js calls) over cached historical candles, bar
// by bar, and writes every tradeable decision to a CSV. This is the
// bridge between "real engine" and "fast Python backtest" — the signal
// math never leaves Node.js (see prancy-wibbling-feather.md's
// "Backtesting pipeline addendum" for why: reimplementing indicators.js/
// scoring.js in Python risks silent drift from what actually runs live).
//
// Usage: node scripts/backtest/generateSignals.js SYMBOL1,SYMBOL2
const fs = require('fs');
const path = require('path');
const { evaluateSymbol } = require('../../src/trading/signalScanner');
const { computeStopLoss } = require('../../src/trading/stopLoss');
const logger = require('../../src/utils/logger');

const OUT_DIR = path.join(__dirname, '..', '..', 'backtest-data');
const INTERVAL_MS = { h1: 3_600_000, m15: 900_000, m5: 300_000 };
const HISTORY_WINDOW = 150; // matches candles.js's default live fetch depth

function loadCandles(symbol, tf) {
  const file = path.join(OUT_DIR, symbol, `${tf}.json`);
  if (!fs.existsSync(file)) throw new Error(`No cached data for ${symbol}/${tf} — run fetchHistory.js first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Candles CONFIRMED CLOSED by `simTime` — mirrors candles.js's live
 * trimming of the still-forming candle, just applied to historical data
 * at a simulated point in time instead of Date.now().
 */
function closedBy(candles, simTime, intervalMs) {
  let hi = candles.length;
  while (hi > 0 && candles[hi - 1].t + intervalMs > simTime) hi--;
  return candles.slice(Math.max(0, hi - HISTORY_WINDOW), hi);
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = ['symbol', 'timestamp', 'band', 'entryTf', 'side', 'entryPrice', 'stopDistance', 'slPrice', 'score', 'alignCount'];

function generateForSymbol(symbol) {
  const h1All = loadCandles(symbol, 'h1');
  const m15All = loadCandles(symbol, 'm15');
  const m5All = loadCandles(symbol, 'm5');

  const rows = [];
  for (const m5Candle of m5All) {
    const simTime = m5Candle.t + INTERVAL_MS.m5; // this m5 candle's close time
    const h1 = closedBy(h1All, simTime, INTERVAL_MS.h1);
    const m15 = closedBy(m15All, simTime, INTERVAL_MS.m15);
    const m5 = closedBy(m5All, simTime, INTERVAL_MS.m5);
    if (h1.length < 30 || m15.length < 30 || m5.length < 30) continue; // not enough history yet

    let decision;
    try {
      decision = evaluateSymbol(symbol, { h1, m15, m5 });
    } catch (err) {
      logger.warn('generateSignals', 'evaluateSymbol threw, skipping this bar', { symbol, simTime, error: err.message });
      continue;
    }
    if (!decision || !decision.tradeable) continue;

    const entrySlice = decision.entryTf === 'm5' ? m5 : m15;
    const entryPrice = entrySlice[entrySlice.length - 1].c;
    const side = decision.evaluation.bias === 1 ? 'Buy' : 'Sell';

    // Real stop-loss computation (same function orderExecution.js calls
    // live) — same "don't reimplement, replay the real code" principle.
    let sl;
    try {
      sl = computeStopLoss(side, entrySlice, entryPrice);
    } catch (err) {
      continue; // direction-assertion failure — live code would skip this trade too
    }

    rows.push({
      symbol, timestamp: simTime, band: decision.band, entryTf: decision.entryTf, side, entryPrice,
      stopDistance: sl.stopDistance, slPrice: sl.slPrice,
      score: decision.evaluation.score, alignCount: decision.evaluation.alignCount,
    });
  }

  return rows;
}

function main() {
  const symbolsArg = process.argv[2];
  if (!symbolsArg) {
    console.error('Usage: node scripts/backtest/generateSignals.js SYMBOL1,SYMBOL2');
    process.exit(1);
  }
  const symbols = symbolsArg.split(',').map(s => s.trim());

  const allRows = [];
  for (const symbol of symbols) {
    logger.info('generateSignals', 'replaying', { symbol });
    const rows = generateForSymbol(symbol);
    logger.info('generateSignals', 'done', { symbol, tradeableSignals: rows.length });
    allRows.push(...rows);
  }

  allRows.sort((a, b) => a.timestamp - b.timestamp);
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of allRows) lines.push(CSV_COLUMNS.map(c => csvEscape(r[c])).join(','));

  const outFile = path.join(OUT_DIR, 'signals.csv');
  fs.writeFileSync(outFile, lines.join('\n'));
  logger.info('generateSignals', 'wrote signals CSV', { outFile, totalSignals: allRows.length });
}

if (require.main === module) {
  main();
}

module.exports = { generateForSymbol, closedBy };
