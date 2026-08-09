// Per-symbol precision/limits (tick size, qty step, min order qty),
// cached in-process since these change rarely.
const bybit = require('./bybitClient');

const cache = new Map();

async function getInstrumentInfo(symbol) {
  if (cache.has(symbol)) return cache.get(symbol);
  const res = await bybit.getInstrumentsInfo({ category: 'linear', symbol });
  if (res.retCode !== 0 || !res.result.list.length) {
    throw new Error(`instrumentInfo: no data for ${symbol} (retCode=${res.retCode})`);
  }
  const inst = res.result.list[0];
  const info = {
    symbol,
    tickSize: parseFloat(inst.priceFilter.tickSize),
    qtyStep: parseFloat(inst.lotSizeFilter.qtyStep),
    minOrderQty: parseFloat(inst.lotSizeFilter.minOrderQty),
    minNotionalValue: parseFloat(inst.lotSizeFilter.minNotionalValue || 0),
  };
  cache.set(symbol, info);
  return info;
}

// Rounds DOWN to the instrument's qty step — never up (brief 5f: keep this
// pattern from the old bot, it was correct there).
function roundQtyDown(qty, qtyStep) {
  const steps = Math.floor(qty / qtyStep);
  const decimals = (qtyStep.toString().split('.')[1] || '').length;
  return parseFloat((steps * qtyStep).toFixed(decimals));
}

function roundPriceToTick(price, tickSize, direction) {
  const steps = direction === 'up' ? Math.ceil(price / tickSize) : Math.floor(price / tickSize);
  const decimals = (tickSize.toString().split('.')[1] || '').length;
  return parseFloat((steps * tickSize).toFixed(decimals));
}

module.exports = { getInstrumentInfo, roundQtyDown, roundPriceToTick };
