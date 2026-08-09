// Places entry + native SL + 3 partial TP orders, then re-queries Bybit for
// the actual resulting order/position state — never assumes success from
// the submit response alone. This is the direct fix for the old bot's most
// severe confirmed bug (brief section 5, item 1 / bug #1): trades were
// resolved synthetically from single price snapshots instead of real
// exchange state, producing logically impossible results (93%+ of
// consecutive trades logged within 100ms of each other). Every call here
// ends by asking Bybit "what actually happened", not by trusting what we
// intended to happen.
const bybit = require('../market/bybitClient');
const { computeTakeProfitLevels, allLegsNonZero } = require('./takeProfits');
const logger = require('../utils/logger');

/**
 * side: 'Buy' | 'Sell'. Returns { ok, position, orders, errors }.
 * Throws only on a hard precondition failure (e.g. qty <= 0) — exchange-side
 * rejections are captured in `errors` and `ok: false`, not thrown, so the
 * caller's per-entry try/catch (brief 5g) isn't the only thing standing
 * between one bad order and the rest of a scan cycle.
 */
async function executeEntry({ symbol, side, qty, entryPrice, slPrice, stopDistance, instrumentInfo }) {
  if (!(qty > 0)) throw new Error(`executeEntry: invalid qty ${qty} for ${symbol}`);

  const errors = [];
  const closeSide = side === 'Buy' ? 'Sell' : 'Buy';

  // Check the 3-way TP split is actually representable at this qty BEFORE
  // touching the exchange — a leg silently rounding to 0 would otherwise
  // ship a 1- or 2-leg TP structure under the "3-way split" label.
  const tpLevelsPreCheck = computeTakeProfitLevels({ side, entryPrice, stopDistance, totalQty: qty, instrumentInfo });
  if (!allLegsNonZero(tpLevelsPreCheck)) {
    logger.warn('orderExecution', 'skip: qty too small to split into 3 non-zero TP legs at this instrument\'s qtyStep', {
      symbol, qty, qtyStep: instrumentInfo.qtyStep, tpLevels: tpLevelsPreCheck,
    });
    return { ok: false, position: null, orders: [], errors: [{ stage: 'preflight', message: 'tp_split_not_representable' }] };
  }

  logger.info('orderExecution', 'submitting entry order', { symbol, side, qty, entryPrice, slPrice });
  const entryRes = await bybit.submitOrder({
    category: 'linear',
    symbol,
    side,
    orderType: 'Market',
    qty: qty.toString(),
    timeInForce: 'IOC',
  });
  if (entryRes.retCode !== 0) {
    logger.error('orderExecution', 'entry order rejected', { symbol, retCode: entryRes.retCode, retMsg: entryRes.retMsg });
    return { ok: false, position: null, orders: [], errors: [{ stage: 'entry', ...entryRes }] };
  }

  // Attach native stop-loss to the resulting position — fires at a fixed,
  // pre-committed price via Bybit's own order engine (brief 5d: this is
  // the property the jaw-invalidation exit path does NOT have).
  const slRes = await bybit.setTradingStop({
    category: 'linear',
    symbol,
    stopLoss: slPrice.toString(),
    positionIdx: 0,
  });
  if (slRes.retCode !== 0) {
    logger.error('orderExecution', 'stop-loss attach failed — position is OPEN and UNPROTECTED', {
      symbol, retCode: slRes.retCode, retMsg: slRes.retMsg,
    });
    errors.push({ stage: 'stopLoss', ...slRes });
  }

  // Three separate reduce-only limit orders for the partial TP split —
  // Bybit's single-field takeProfit is full-position only, not usable for
  // TP1/TP2/TP3. Legs already confirmed non-zero by the preflight check.
  const tpResults = [];
  for (const tp of tpLevelsPreCheck) {
    const res = await bybit.submitOrder({
      category: 'linear',
      symbol,
      side: closeSide,
      orderType: 'Limit',
      qty: tp.qty.toString(),
      price: tp.price.toString(),
      timeInForce: 'GTC',
      reduceOnly: true,
    });
    if (res.retCode !== 0) {
      logger.error('orderExecution', 'TP leg rejected', { symbol, level: tp.level, retCode: res.retCode, retMsg: res.retMsg });
      errors.push({ stage: tp.level, ...res });
    } else {
      tpResults.push({ ...tp, orderId: res.result.orderId });
    }
  }

  // Re-query real state rather than trusting the submit responses — the
  // whole point of this module.
  const [positionRes, ordersRes] = await Promise.all([
    bybit.getPositionInfo({ category: 'linear', symbol }),
    bybit.getActiveOrders({ category: 'linear', symbol }),
  ]);

  const position = positionRes.retCode === 0 ? positionRes.result.list.find(p => parseFloat(p.size) > 0) : null;
  const orders = ordersRes.retCode === 0 ? ordersRes.result.list : [];

  logger.info('orderExecution', 'post-order verified state', {
    symbol,
    positionSize: position ? position.size : 0,
    positionAvgPrice: position ? position.avgPrice : null,
    openOrderCount: orders.length,
  });

  if (!position || parseFloat(position.size) === 0) {
    logger.error('orderExecution', 'no position found after entry — entry may not have filled', { symbol });
    errors.push({ stage: 'verify', message: 'position not found after entry' });
  }

  return { ok: errors.length === 0, position, orders, tpLevels: tpResults, errors };
}

module.exports = { executeEntry };
