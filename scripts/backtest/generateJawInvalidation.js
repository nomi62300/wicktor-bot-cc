// Precomputes the jaw-invalidation flag over historical candles, using
// the REAL Indicators.analyzeTimeframe() — same "replay the real engine,
// never reimplement indicator math" principle as generateSignals.js.
//
// This exists ONLY to reproduce Phase 3 exactly for the backtest engine's
// trust-building sanity check (comparing against the real logged 34.2%
// win rate / -0.336R expectancy) — jaw-invalidation itself was REMOVED
// from the live bot in brief 9a (Phase 4), since Phase 3's real data
// showed it performed no better than a genuine stop-loss. This script
// intentionally recreates the OLD (pre-9a) check for historical
// comparison purposes only.
//
// Usage: node scripts/backtest/generateJawInvalidation.js SYMBOL1,SYMBOL2
const fs = require('fs');
const path = require('path');
const { Indicators } = require('../../src/engine');
const logger = require('../../src/utils/logger');

const OUT_DIR = path.join(__dirname, '..', '..', 'backtest-data');
const HISTORY_WINDOW = 150;

function loadCandles(symbol, tf) {
  const file = path.join(OUT_DIR, symbol, `${tf}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function generateForSymbolTf(symbol, tf) {
  const candles = loadCandles(symbol, tf);
  const series = [];

  for (let i = 30; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - HISTORY_WINDOW + 1), i + 1);
    let invalidated = false;
    try {
      const snapshot = Indicators.analyzeTimeframe(window);
      invalidated = !!(snapshot && snapshot.alligatorInvalidated);
    } catch (err) {
      // Fail closed (not invalidated) rather than let one bad window
      // corrupt the whole series with a thrown error.
    }
    series.push({ t: candles[i].t, invalidated });
  }

  return series;
}

function main() {
  const symbolsArg = process.argv[2];
  if (!symbolsArg) {
    console.error('Usage: node scripts/backtest/generateJawInvalidation.js SYMBOL1,SYMBOL2');
    process.exit(1);
  }
  const symbols = symbolsArg.split(',').map(s => s.trim());

  for (const symbol of symbols) {
    for (const tf of ['m15', 'm5']) {
      logger.info('generateJawInvalidation', 'computing', { symbol, tf });
      const series = generateForSymbolTf(symbol, tf);
      fs.writeFileSync(path.join(OUT_DIR, symbol, `jawInvalidated_${tf}.json`), JSON.stringify(series));
    }
  }
  logger.info('generateJawInvalidation', 'done', { symbols: symbols.length });
}

if (require.main === module) {
  main();
}

module.exports = { generateForSymbolTf };
