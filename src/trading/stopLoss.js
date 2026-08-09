// Stop-loss placement: last opposing fractal / jaw line (whichever tighter),
// with an ATR-based floor so stops are never unrealistically tight.
//
// Directional safety: every computed SL is asserted against entry price
// before being returned (Long: SL below entry, always; Short: SL above
// entry, always) — a bad SL throws and the caller must skip the trade
// rather than submit a plausible-but-wrong price. This is the exact
// pattern that caught the old bot's real "StopLoss should be lower than
// base_price" rejection (brief bug #3) — kept and enforced earlier here,
// before the order is even built, not just relied on as an exchange-side
// catch.
const { Indicators } = require('../engine');
const config = require('../config');

class StopLossDirectionError extends Error {}

/**
 * side: 'Buy' | 'Sell'. candles: the entry-TF candle array (oldest->newest)
 * used to derive the signal. entryPrice: intended entry price.
 * Returns { slPrice, stopDistance, source }.
 */
function computeStopLoss(side, candles, entryPrice) {
  const lastIdx = candles.length - 1;
  const frac = Indicators.fractals(candles);
  const { jaw } = Indicators.alligator(candles);
  const jawV = jaw[lastIdx];
  const atrSeries = Indicators.atr(candles);
  const atrV = atrSeries[lastIdx];

  const candidates = [];

  if (side === 'Buy') {
    const downFracIdx = Indicators.lastFractal(frac.down, lastIdx - 2);
    if (downFracIdx != null) {
      const p = candles[downFracIdx].l;
      if (p < entryPrice) candidates.push({ price: p, source: 'fractal' });
    }
    if (jawV != null && jawV < entryPrice) candidates.push({ price: jawV, source: 'jaw' });
  } else {
    const upFracIdx = Indicators.lastFractal(frac.up, lastIdx - 2);
    if (upFracIdx != null) {
      const p = candles[upFracIdx].h;
      if (p > entryPrice) candidates.push({ price: p, source: 'fractal' });
    }
    if (jawV != null && jawV > entryPrice) candidates.push({ price: jawV, source: 'jaw' });
  }

  // "Whichever tighter" = smaller stop distance from entry.
  let chosen;
  if (candidates.length > 0) {
    chosen = candidates.reduce((best, c) =>
      Math.abs(c.price - entryPrice) < Math.abs(best.price - entryPrice) ? c : best
    );
  } else {
    // No valid fractal/jaw candidate on the correct side — fall back to
    // the ATR floor alone rather than guessing.
    chosen = null;
  }

  const bucketedAtr = Indicators.bucketedAtr(atrV, entryPrice) ?? atrV ?? entryPrice * 0.01;
  const floorDistance = config.stopAtrFloorMult * bucketedAtr;

  let slPrice, source;
  if (chosen && Math.abs(chosen.price - entryPrice) >= floorDistance) {
    slPrice = chosen.price;
    source = chosen.source;
  } else {
    slPrice = side === 'Buy' ? entryPrice - floorDistance : entryPrice + floorDistance;
    source = chosen ? `${chosen.source}+atr-floor` : 'atr-floor';
  }

  // Explicit directional assertion — fail loudly and skip the trade rather
  // than submit a plausible-but-wrong price (brief bug #3 fix).
  if (side === 'Buy' && !(slPrice < entryPrice)) {
    throw new StopLossDirectionError(`Buy SL ${slPrice} is not below entry ${entryPrice}`);
  }
  if (side === 'Sell' && !(slPrice > entryPrice)) {
    throw new StopLossDirectionError(`Sell SL ${slPrice} is not above entry ${entryPrice}`);
  }

  return { slPrice, stopDistance: Math.abs(entryPrice - slPrice), source };
}

module.exports = { computeStopLoss, StopLossDirectionError };
