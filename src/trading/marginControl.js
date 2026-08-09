// Leverage + liquidation-distance safety check.
//
// IMPORTANT, confirmed live (2026-08-09): Bybit's Demo Trading environment
// rejects margin-MODE switching entirely (switchIsolatedMargin returns
// retCode 10032 "Demo trading are not supported") — this account is
// permanently in CROSS margin, where liquidation depends on total account
// equity shared across every open position, not a fixed per-position
// level, and Bybit doesn't expose a simple deterministic liqPrice to
// check against (position.liqPrice comes back empty in cross mode).
//
// Leverage itself CAN still be set (setLeverage works fine on demo), so
// this module: (1) ensures the configured leverage is applied, and (2)
// computes an ESTIMATED liquidation price using the standard isolated-
// margin formula as a conservative proxy — NOT Bybit's authoritative
// cross-margin number (which isn't obtainable here), but still a
// meaningful, real check against "is this stop-loss actually inside a
// leverage-implied liquidation danger zone", which nothing in this
// codebase checked before this fix.
const bybit = require('../market/bybitClient');
const { getMaintenanceMarginRate } = require('../market/riskLimit');
const logger = require('../utils/logger');

const ALREADY_SET_PATTERN = /not modified|same leverage|same margin/i;

async function ensureLeverage(symbol, leverage) {
  const res = await bybit.setLeverage({
    category: 'linear', symbol, buyLeverage: leverage.toString(), sellLeverage: leverage.toString(),
  });
  if (res.retCode === 0 || ALREADY_SET_PATTERN.test(res.retMsg || '')) {
    return { ok: true };
  }
  logger.error('marginControl', 'failed to set leverage', { symbol, leverage, retCode: res.retCode, retMsg: res.retMsg });
  return { ok: false, retCode: res.retCode, retMsg: res.retMsg };
}

/**
 * Estimated liquidation price using the standard isolated-margin formula:
 *   Buy:  entryPrice * (1 - 1/leverage + maintenanceMarginRate)
 *   Sell: entryPrice * (1 + 1/leverage - maintenanceMarginRate)
 * This is a conservative PROXY, not Bybit's real cross-margin number —
 * real cross-margin liquidation could be better (other positions have
 * healthy equity to draw on) or worse (other positions are also
 * drawing down) than this estimate. It still catches the core danger:
 * a stop-loss placed outside where leverage would liquidate the
 * position first regardless of margin mode.
 */
function estimateLiquidationPrice({ side, entryPrice, leverage, maintenanceMarginRate }) {
  return side === 'Buy'
    ? entryPrice * (1 - 1 / leverage + maintenanceMarginRate)
    : entryPrice * (1 + 1 / leverage - maintenanceMarginRate);
}

/**
 * Checks that the stop-loss has adequate room before the leverage-implied
 * liquidation price could ever be reached. Returns { safe, liqPrice,
 * bufferRatio, reason }. bufferRatio = (distance to est. liquidation) /
 * (distance to stop-loss); must be >= minBufferMult to be safe.
 */
async function checkLiquidationBuffer({ symbol, side, entryPrice, slPrice, leverage, minBufferMult }) {
  let mmr;
  try {
    mmr = await getMaintenanceMarginRate(symbol);
  } catch (err) {
    logger.warn('marginControl', 'could not fetch maintenance margin rate, failing closed', { symbol, error: err.message });
    return { safe: false, liqPrice: null, bufferRatio: null, reason: 'mmr_unavailable' };
  }

  const liqPrice = estimateLiquidationPrice({ side, entryPrice, leverage, maintenanceMarginRate: mmr });
  const slDistance = Math.abs(entryPrice - slPrice);
  const liqDistance = Math.abs(entryPrice - liqPrice);

  const orderCorrect = side === 'Buy' ? (liqPrice < slPrice) : (liqPrice > slPrice);
  if (!orderCorrect) {
    return { safe: false, liqPrice, bufferRatio: 0, reason: 'liquidation_inside_stop' };
  }

  const bufferRatio = slDistance > 0 ? liqDistance / slDistance : Infinity;
  return { safe: bufferRatio >= minBufferMult, liqPrice, bufferRatio, reason: bufferRatio >= minBufferMult ? null : 'buffer_too_thin' };
}

module.exports = { ensureLeverage, checkLiquidationBuffer, estimateLiquidationPrice };
