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
//
// Two further protections added after the same slippage finding:
// (1) entries are now slippage-BOUNDED IOC limit orders (MAX_ENTRY_
// SLIPPAGE_PCT), not plain Market orders — a price that's already moved
// too far by the time the order reaches the exchange simply doesn't
// fill, rather than accepting arbitrary slippage. (2) leverage is set
// explicitly before every entry, and an ESTIMATED liquidation price
// (marginControl.js) is checked against the stop-loss (MIN_LIQUIDATION_
// BUFFER_MULT) — confirmed live that Bybit's Demo Trading environment
// rejects switching to isolated margin ("Demo trading are not
// supported"), so this account is permanently cross-margin, where
// Bybit doesn't expose a deterministic per-position liquidation price
// to check directly. The estimate uses the standard isolated-margin
// formula as a conservative proxy instead.
const bybit = require('../market/bybitClient');
const { computeTakeProfitLevels, allLegsNonZero } = require('./takeProfits');
const { roundPriceToTick } = require('../market/instrumentInfo');
const { ensureLeverage, checkLiquidationBuffer } = require('./marginControl');
const config = require('../config');
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

  // Explicit leverage, set BEFORE the entry. NOTE: Bybit's Demo Trading
  // rejects margin-MODE switching entirely (confirmed live, retCode
  // 10032 "Demo trading are not supported") — this account is
  // permanently cross-margin, so leverage can be set but true isolated
  // per-position liquidation isolation is not available in this
  // environment. See marginControl.js for the liquidation-buffer
  // estimate this limitation requires below.
  const marginRes = await ensureLeverage(symbol, config.leverage);
  if (!marginRes.ok) {
    return { ok: false, positionStillOpen: false, position: null, orders: [], errors: [{ stage: 'margin', ...marginRes }] };
  }

  // Entry is now a slippage-bounded IOC LIMIT order, not a plain Market
  // order — confirmed live (2026-08-09, TUTUSDT) that a Market order can
  // fill far enough from the decision price (~11% gap on a thin/volatile
  // symbol) to break the SL/sizing math built around that price. A price
  // that has already moved beyond MAX_ENTRY_SLIPPAGE_PCT by the time this
  // reaches the exchange now simply doesn't fill (or partially fills)
  // instead of accepting arbitrary slippage.
  const limitPrice = side === 'Buy'
    ? intendedEntryPrice * (1 + config.maxEntrySlippagePct)
    : intendedEntryPrice * (1 - config.maxEntrySlippagePct);
  const roundedLimitPrice = roundPriceToTick(limitPrice, instrumentInfo.tickSize, side === 'Buy' ? 'down' : 'up');

  logger.info('orderExecution', 'submitting entry order', { symbol, side, qty, intendedEntryPrice, limitPrice: roundedLimitPrice });
  const entryRes = await withRateLimitRetry(() => bybit.submitOrder({
    category: 'linear', symbol, side, orderType: 'Limit', price: roundedLimitPrice.toString(),
    qty: qty.toString(), timeInForce: 'IOC',
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
    // Not necessarily an error — an IOC limit order that couldn't fill
    // within the slippage tolerance cancels itself with nothing filled.
    // That's the tolerance working as intended, not a bug.
    logger.info('orderExecution', 'entry did not fill within slippage tolerance, skipping this candidate', { symbol, intendedEntryPrice, limitPrice: roundedLimitPrice });
    return { ok: false, positionStillOpen: false, position: null, orders: [], errors: [{ stage: 'entry', message: 'not_filled_within_slippage_tolerance' }] };
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

  // Verify the stop-loss actually has room before the leverage-implied
  // liquidation price could ever be reached (estimated — see
  // marginControl.js for why this can't be Bybit's authoritative number
  // on Demo Trading). If the buffer is too thin, this is a genuine danger
  // the exchange won't otherwise warn about ahead of time, so it's
  // treated the same as any other "can't establish valid protection"
  // case: close immediately.
  const liqCheck = await checkLiquidationBuffer({
    symbol, side, entryPrice: actualEntryPrice, slPrice: sl.slPrice,
    leverage: config.leverage, minBufferMult: config.minLiquidationBufferMult,
  });
  if (!liqCheck.safe) {
    await closePositionAtMarket(symbol, side, actualQty, `insufficient liquidation buffer: ${liqCheck.reason} (ratio=${liqCheck.bufferRatio}, estLiqPrice=${liqCheck.liqPrice})`);
    return {
      ok: false, positionStillOpen: false, position, orders: [],
      errors: [{ stage: 'liquidationBuffer', ...liqCheck }],
      entryPrice: actualEntryPrice, slPrice: sl.slPrice, stopDistance: sl.stopDistance,
    };
  }
  logger.info('orderExecution', 'liquidation buffer verified safe (estimated)', { symbol, estLiqPrice: liqCheck.liqPrice, bufferRatio: liqCheck.bufferRatio });

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
