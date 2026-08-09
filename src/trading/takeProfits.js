// TP1 @ 1R, TP2 @ 1.5R, TP3 @ 2R, position split evenly (33.3% each) —
// confirmed design (brief section 3). Rounding remainder goes to the last
// leg so the three legs always sum to exactly the total qty.
const { roundQtyDown, roundPriceToTick } = require('../market/instrumentInfo');

function computeTakeProfitLevels({ side, entryPrice, stopDistance, totalQty, instrumentInfo }) {
  const sign = side === 'Buy' ? 1 : -1;
  const priceRoundDir = side === 'Buy' ? 'down' : 'up';

  const rawPrices = [1, 1.5, 2].map(r => entryPrice + sign * r * stopDistance);
  const prices = rawPrices.map(p => roundPriceToTick(p, instrumentInfo.tickSize, priceRoundDir));

  const qty1 = roundQtyDown(totalQty / 3, instrumentInfo.qtyStep);
  const qty2 = roundQtyDown(totalQty / 3, instrumentInfo.qtyStep);
  const qty3 = roundQtyDown(totalQty - qty1 - qty2, instrumentInfo.qtyStep);

  return [
    { level: 'TP1', rMultiple: 1, price: prices[0], qty: qty1 },
    { level: 'TP2', rMultiple: 1.5, price: prices[1], qty: qty2 },
    { level: 'TP3', rMultiple: 2, price: prices[2], qty: qty3 },
  ];
}

/**
 * A leg that rounds down to 0 isn't "a slightly smaller TP1" — it's a
 * silently-missing take-profit order, which breaks the confirmed 33/33/34
 * 3-way split design. Explicit skip over silent degraded behavior (same
 * principle as brief 5e's notional-cap fix): if the total qty can't
 * support 3 non-zero legs, the caller must skip the trade rather than
 * submit a 1- or 2-leg structure under the "3-way TP" label.
 */
function allLegsNonZero(levels) {
  return levels.every(l => l.qty > 0);
}

module.exports = { computeTakeProfitLevels, allLegsNonZero };
