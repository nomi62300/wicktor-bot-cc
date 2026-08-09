// Places entry + native SL + 3 partial TP orders, then re-queries Bybit for
// the actual resulting order/position state — never assumes success from
// the submit response alone. This is the direct fix for the old bot's most
// severe confirmed bug (brief section 5, item 1 / bug #1): trades were
// resolved synthetically from single price snapshots instead of real
// exchange state, producing logically impossible results (93%+ of
// consecutive trades logged within 100ms of each other). Every call here
// ends by asking Bybit "what actually happened", not by trusting what we
// intended to happen.
//
// SL/TP prices are computed from the REAL fill price, not the pre-trade
// decision price — confirmed live (TUTUSDT, 2026-08-09) that a market
// order can fill far enough from the decision-time candle close (~11% gap
// on a volatile/thin symbol) that a stop-loss computed from the old price
// lands on the wrong side of the real entry, gets rejected by Bybit's own
// base_price validation, and — because the old code just logged the
// rejection and moved on — left a real position open with ZERO
// protection. `computeStopLoss` is now a callback invoked with the actual
// post-fill entry price, and a hard safety net closes the position
// immediately at market if a valid protective stop still can't be
// attached, rather than ever leaving a filled position unprotected.
const bybit = require('../market/bybitClient');
const { computeTakeProfitLevels, allLegsNonZero } = require('./takeProfits');
const logger = require('../utils/logger');

const RATE_LIMIT_RETCODE = 10006;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Retries once on Bybit's rate-limit response (retCode 10006) after a
 * short backoff — confirmed live (2026-08-09) that firing several full
 * entry sequences back-to-back in one scan tick (each ~7 API calls) can
 * burst past Bybit's rate limit, causing spurious TP-leg/entry rejections
 * that have nothing to do with the trade itself. A single retry is enough
 * to smooth over that self-inflicted burst without masking a genuine,
 * repeated rate-limit problem (which will still surface as a real error
 * after the retry).
 */
async function withRateLimitRetry(fn, label) {
  const res = await fn();
  if (res.retCode === RATE_LIMIT_RETCODE) {
    logger.warn('orderExecution', 'rate limited, retrying once after backoff', { label });
    await sleep(600);
    return fn();
  }
  return res;
}

async function closePositionAtMarket(symbol, side, qty, reason) {
  const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
  logger.error('orderExecution', 'SAFETY NET: closing position immediately at market — could not establish valid protection', {
    symbol, side, qty, reason,
  });
  const res = await bybit.submitOrder({
    category: 'linear', symbol, side: closeSide, orderType: 'Market',
    qty: qty.toString(), timeInForce: 'IOC', reduceOnly: true,
  });
  if (res.retCode !== 0) {
    logger.error('orderExecution', 'SAFETY NET CLOSE FAILED — position may still be open and unprotected, needs manual intervention', {
      symbol, retCode: res.retCode, retMsg: res.retMsg,
    });
  }
  return res;
}

/**
 * side: 'Buy' | 'Sell'. `computeStopLoss(actualEntryPrice)` is called AFTER
 * the entry fills, with the real average fill price — never the pre-trade
 * decision price — and must return { slPrice, stopDistance, source }
 * (matches trading/stopLoss.js's computeStopLoss, partially applied by the
 * caller). `provisionalStopDistance` is only used for the pre-trade TP-
 * split qty-representability preflight (a qty-only check, unaffected by
 * price), not for any actual order price.
 *
 * Returns { ok, position, orders, errors, entryPrice, slPrice, stopDistance,
 * intendedEntryPrice, slippagePct }. Throws only on a hard precondition
 * failure (e.g. qty <= 0) — exchange-side rejections are captured in
 * `errors` and `ok: false`.
 */
async function executeEntry({ symbol, side, qty, intendedEntryPrice, provisionalStopDistance, computeStopLoss, instrumentInfo }) {
  if (!(qty > 0)) throw new Error(`executeEntry: invalid qty ${qty} for ${symbol}`);

  const errors = [];
  const closeSide = side === 'Buy' ? 'Sell' : 'Buy';

  // Qty-only preflight (doesn't depend on price) — a leg silently rounding
  // to 0 would otherwise ship a 1- or 2-leg TP structure under the "3-way
  // split" label. Uses the provisional pre-trade estimate; the real TP
  // prices are computed after the fill, below.
  const preflightLevels = computeTakeProfitLevels({
    side, entryPrice: intendedEntryPrice, stopDistance: provisionalStopDistance, totalQty: qty, instrumentInfo,
  });
  if (!allLegsNonZero(preflightLevels)) {
    logger.warn('orderExecution', 'skip: qty too small to split into 3 non-zero TP legs at this instrument\'s qtyStep', {
      symbol, qty, qtyStep: instrumentInfo.qtyStep,
    });
    return { ok: false, positionStillOpen: false, position: null, orders: [], errors: [{ stage: 'preflight', message: 'tp_split_not_representable' }] };
  }

  logger.info('orderExecution', 'submitting entry order', { symbol, side, qty, intendedEntryPrice });
  const entryRes = await withRateLimitRetry(() => bybit.submitOrder({
    category: 'linear', symbol, side, orderType: 'Market', qty: qty.toString(), timeInForce: 'IOC',
  }), `${symbol} entry`);
  if (entryRes.retCode !== 0) {
    logger.error('orderExecution', 'entry order rejected', { symbol, retCode: entryRes.retCode, retMsg: entryRes.retMsg });
    return { ok: false, positionStillOpen: false, position: null, orders: [], errors: [{ stage: 'entry', ...entryRes }] };
  }

  // Real fill price — everything downstream (SL, TP, journaling) is
  // computed from this, never the pre-trade decision price.
  const positionRes = await bybit.getPositionInfo({ category: 'linear', symbol });
  const position = positionRes.retCode === 0 ? positionRes.result.list.find(p => parseFloat(p.size) > 0) : null;
  if (!position) {
    logger.error('orderExecution', 'no position found immediately after entry submit — entry may not have filled', { symbol });
    return { ok: false, positionStillOpen: false, position: null, orders: [], errors: [{ stage: 'verify', message: 'position not found after entry' }] };
  }

  const actualEntryPrice = parseFloat(position.avgPrice);
  const actualQty = parseFloat(position.size);
  const slippagePct = intendedEntryPrice ? (actualEntryPrice - intendedEntryPrice) / intendedEntryPrice : null;
  if (slippagePct != null && Math.abs(slippagePct) > 0.01) {
    logger.warn('orderExecution', 'large slippage between decision price and actual fill', {
      symbol, intendedEntryPrice, actualEntryPrice, slippagePct,
    });
  }

  let sl;
  try {
    sl = computeStopLoss(actualEntryPrice);
  } catch (err) {
    await closePositionAtMarket(symbol, side, actualQty, `computeStopLoss threw: ${err.message}`);
    return { ok: false, positionStillOpen: false, position, orders: [], errors: [{ stage: 'stopLoss', message: err.message }], entryPrice: actualEntryPrice };
  }

  // qty was sized against provisionalStopDistance BEFORE the real fill was
  // known (unavoidable — qty must be decided before submitting). If the
  // real stop distance ends up meaningfully wider/narrower than that
  // estimate, the REALIZED dollar risk on this trade deviates from the
  // intended flat risk %, even though qty itself was computed correctly
  // from the (stale) estimate at the time. Log this explicitly rather
  // than let it pass silently under the flat-risk label (same principle
  // as brief 5e/bug #2 — always surface a risk deviation, never hide it).
  if (provisionalStopDistance) {
    const intendedRiskUsdt = actualQty * provisionalStopDistance;
    const realizedRiskUsdt = actualQty * sl.stopDistance;
    const riskDeviationPct = intendedRiskUsdt > 0 ? (realizedRiskUsdt - intendedRiskUsdt) / intendedRiskUsdt : null;
    if (riskDeviationPct != null && Math.abs(riskDeviationPct) > 0.25) {
      logger.warn('orderExecution', 'realized risk deviates significantly from intended risk (stop distance widened/narrowed after real fill price)', {
        symbol, provisionalStopDistance, realizedStopDistance: sl.stopDistance, intendedRiskUsdt, realizedRiskUsdt, riskDeviationPct,
      });
    }
  }

  const slRes = await withRateLimitRetry(() => bybit.setTradingStop({
    category: 'linear', symbol, stopLoss: sl.slPrice.toString(), positionIdx: 0,
  }), `${symbol} SL attach`);
  if (slRes.retCode !== 0) {
    // Never leave a filled position unprotected — close it immediately
    // rather than log-and-continue (the exact gap that caused this fix).
    await closePositionAtMarket(symbol, side, actualQty, `SL attach rejected even with real fill price: ${slRes.retMsg}`);
    return {
      ok: false, positionStillOpen: false, position, orders: [],
      errors: [{ stage: 'stopLoss', ...slRes }],
      entryPrice: actualEntryPrice, slPrice: sl.slPrice, stopDistance: sl.stopDistance,
    };
  }

  // Three separate reduce-only limit orders for the partial TP split —
  // Bybit's single-field takeProfit is full-position only. Computed from
  // the REAL entry price and the SL actually attached, using the REAL
  // filled qty.
  //
  // A TP leg failing here (rejected price, rate limit, etc.) does NOT mean
  // the position is unprotected — the SL above already succeeded — so this
  // is deliberately NOT another safety-net-close case. But it must still
  // be surfaced clearly and the position must still end up tracked with
  // whatever legs DID succeed (see positionStillOpen below): confirmed
  // live (2026-08-09) that discarding a position whose TP legs partially
  // failed left it open on the exchange but invisible to positionStore,
  // which silently broke the max-concurrent-positions limit (an untracked
  // position doesn't count against it) and left it unmonitored/
  // unjournaled indefinitely.
  const tpLevels = computeTakeProfitLevels({
    side, entryPrice: actualEntryPrice, stopDistance: sl.stopDistance, totalQty: actualQty, instrumentInfo,
  });
  const tpResults = [];
  for (const tp of tpLevels) {
    if (tp.qty <= 0) continue; // already preflighted at the qty level; a 0 here would only happen from actualQty differing from intended qty
    const res = await withRateLimitRetry(() => bybit.submitOrder({
      category: 'linear', symbol, side: closeSide, orderType: 'Limit',
      qty: tp.qty.toString(), price: tp.price.toString(), timeInForce: 'GTC', reduceOnly: true,
    }), `${symbol} ${tp.level}`);
    if (res.retCode !== 0) {
      logger.error('orderExecution', 'TP leg rejected — position remains open and SL-protected, but this leg is missing', {
        symbol, level: tp.level, retCode: res.retCode, retMsg: res.retMsg,
      });
      errors.push({ stage: tp.level, ...res });
    } else {
      tpResults.push({ ...tp, orderId: res.result.orderId });
    }
  }

  // Final re-query of real state rather than trusting the submit responses.
  const [finalPositionRes, ordersRes] = await Promise.all([
    bybit.getPositionInfo({ category: 'linear', symbol }),
    bybit.getActiveOrders({ category: 'linear', symbol }),
  ]);
  const finalPosition = finalPositionRes.retCode === 0 ? finalPositionRes.result.list.find(p => parseFloat(p.size) > 0) : null;
  const orders = ordersRes.retCode === 0 ? ordersRes.result.list : [];

  logger.info('orderExecution', 'post-order verified state', {
    symbol, entryPrice: actualEntryPrice, slPrice: sl.slPrice,
    positionSize: finalPosition ? finalPosition.size : 0,
    openOrderCount: orders.length,
  });

  const stillOpen = !!finalPosition && parseFloat(finalPosition.size) > 0;
  if (!stillOpen) {
    logger.error('orderExecution', 'no position found after full order sequence — entry may have been closed already', { symbol });
    errors.push({ stage: 'verify', message: 'position not found after full sequence' });
  }

  return {
    // ok = fully clean (SL + all 3 TP legs placed). positionStillOpen =
    // there IS a real, SL-protected position that must be tracked even if
    // ok is false (e.g. one TP leg failed) — callers should gate
    // registration/journaling on positionStillOpen, not ok.
    ok: errors.length === 0,
    positionStillOpen: stillOpen,
    position: finalPosition,
    orders,
    tpLevels: tpResults,
    errors,
    entryPrice: actualEntryPrice,
    slPrice: sl.slPrice,
    stopDistance: sl.stopDistance,
    intendedEntryPrice,
    slippagePct,
  };
}

module.exports = { executeEntry, closePositionAtMarket };
