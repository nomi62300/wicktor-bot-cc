// Position sizing: derived DIRECTLY and consistently from
// riskAmount / stopDistance, with no percentage-based reformulation and
// no notional cap that silently changes realized risk while still being
// labeled as flat 0.15% risk (brief 5e — the old bot's `maxNotionalCapUSDT`
// silently halved realized risk on tight-stop trades under the same label).
//
// If a maximum-notional safety cap is configured, it is an explicit,
// separately-logged decision to SKIP the trade — never a silent resize.
//
// Every input to the calculation is logged on every call (brief bug #2 —
// the old bot's wildly inconsistent stop-loss dollar losses were never
// fully root-caused because inputs weren't captured at trade time).
const { roundQtyDown } = require('../market/instrumentInfo');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * bankrollUsdt: current internal virtual bankroll (NOT Bybit's demo equity).
 * stopDistance: |entryPrice - slPrice|, in USDT per unit of base coin.
 * instrumentInfo: { qtyStep, minOrderQty, minNotionalValue }.
 * Returns { qty, riskAmountUsdt, notionalValueUsdt, skip, skipReason } —
 * qty is 0 and skip is true if sizing can't produce a valid order.
 */
function computePositionSize({ symbol, side, bankrollUsdt, entryPrice, stopDistance, instrumentInfo }) {
  const riskAmountUsdt = bankrollUsdt * config.riskPct;
  const rawQty = riskAmountUsdt / stopDistance;
  const qty = roundQtyDown(rawQty, instrumentInfo.qtyStep);
  const notionalValueUsdt = qty * entryPrice;
  const marginRequiredUsdt = notionalValueUsdt / config.leverage;

  const inputs = {
    symbol, side, bankrollUsdt, riskPct: config.riskPct, riskAmountUsdt,
    entryPrice, stopDistance, rawQty, qty, notionalValueUsdt, marginRequiredUsdt,
    leverage: config.leverage,
  };
  logger.info('positionSizing', 'sizing computed', inputs);

  if (qty < instrumentInfo.minOrderQty) {
    logger.warn('positionSizing', 'skip: rounded qty below exchange minOrderQty', {
      symbol, qty, minOrderQty: instrumentInfo.minOrderQty,
    });
    return { ...inputs, qty: 0, skip: true, skipReason: 'below_min_order_qty' };
  }

  if (instrumentInfo.minNotionalValue && notionalValueUsdt < instrumentInfo.minNotionalValue) {
    logger.warn('positionSizing', 'skip: notional below exchange minNotionalValue', {
      symbol, notionalValueUsdt, minNotionalValue: instrumentInfo.minNotionalValue,
    });
    return { ...inputs, qty: 0, skip: true, skipReason: 'below_min_notional' };
  }

  if (config.maxNotionalPctOfBankroll != null) {
    const cap = bankrollUsdt * config.maxNotionalPctOfBankroll;
    if (notionalValueUsdt > cap) {
      logger.warn('positionSizing', 'skip: notional exceeds configured safety cap — trade skipped, NOT resized', {
        symbol, notionalValueUsdt, cap, maxNotionalPctOfBankroll: config.maxNotionalPctOfBankroll,
      });
      return { ...inputs, qty: 0, skip: true, skipReason: 'exceeds_notional_safety_cap' };
    }
  }

  return { ...inputs, skip: false, skipReason: null };
}

module.exports = { computePositionSize };
