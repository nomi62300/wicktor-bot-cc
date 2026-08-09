// Turns raw Scoring.evaluate() output into a trade decision: final band,
// entry timeframe, and whether the signal qualifies at all.
//
// Band -> entry TF falls directly out of the ceiling computation already in
// Scoring.alignmentCeiling() (brief section 2): EXCELLENT -> enter on 5M,
// WATCH -> enter on 15M, AVOID -> no trade. No separate entry-TF mechanism.
const { Scoring } = require('../engine');
const { fetchCandleSet } = require('../market/candles');
const logger = require('../utils/logger');

const ENTRY_TF_BY_BAND = { excellent: 'm5', watch: 'm15' };

/**
 * Continuation must be strictly the dominant of the three CONT/EXH/REV
 * sub-scores (brief section 2, "Which bands to trade") — a deliberate
 * refinement to ensure genuine trend-following rather than a band reached
 * through mixed/conflicting factors. This is a trade-decision filter on
 * top of the ported scoring engine, not part of Scoring.evaluate() itself.
 */
function continuationIsDominant(evaluation) {
  const { continuation, exhaustion, reversal } = evaluation;
  return continuation.score > exhaustion.score && continuation.score > reversal.score;
}

/**
 * Evaluates one symbol's candle set and returns a decision object, or null
 * if there isn't enough data yet (brief: need at least 1H data).
 */
function evaluateSymbol(symbol, candlesByTf) {
  const evaluation = Scoring.evaluate(candlesByTf);
  if (!evaluation) return null;

  const scoreBand = evaluation.ceiling; // 'excellent' | 'watch' | 'avoid', already the band ceiling
  const dominant = continuationIsDominant(evaluation);
  const tradeable = scoreBand !== 'avoid' && dominant;

  return {
    symbol,
    band: scoreBand,
    tradeable,
    entryTf: tradeable ? ENTRY_TF_BY_BAND[scoreBand] : null,
    continuationDominant: dominant,
    evaluation,
  };
}

/**
 * Scans the given universe symbols, fetching candles and evaluating each.
 * Fails soft per-symbol (one bad fetch/evaluate never aborts the scan) —
 * same lesson as the old bot's per-entry try/catch requirement (brief 5g),
 * applied here at the scan stage too.
 */
async function scanUniverse(universe) {
  const results = [];
  for (const { symbol } of universe) {
    try {
      const candlesByTf = await fetchCandleSet(symbol);
      const decision = evaluateSymbol(symbol, candlesByTf);
      if (decision) results.push(decision);
    } catch (err) {
      logger.warn('signalScanner', 'symbol evaluation failed, skipping', { symbol, error: err.message });
    }
  }
  return results;
}

module.exports = { evaluateSymbol, scanUniverse, continuationIsDominant };
