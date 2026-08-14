// Bridges positionMonitor's real-fill callbacks to persistence/tradeJournal.
// Every price/qty written to the journal comes from the actual execution
// record positionMonitor captured (orderId-matched or stopOrderType-
// identified), never recomputed or inferred here.
const tradeJournal = require('../persistence/tradeJournal');
const logger = require('../utils/logger');

async function onPartialFill(record, leg, exec, reason) {
  if (!record.tradeId) {
    logger.error('journalIntegration', 'partial fill with no tradeId on record, cannot journal', { symbol: record.symbol, level: leg.level });
    return;
  }
  tradeJournal.recordPartialFill(record.tradeId, leg.level, parseFloat(exec.execPrice), parseFloat(exec.execQty), Number(exec.execTime));
  tradeJournal.appendChartMarker(record.tradeId, { type: leg.level.toLowerCase(), time: Number(exec.execTime), price: parseFloat(exec.execPrice) });
}

async function onFinalExit(record, reason, exec) {
  if (!record.tradeId) {
    logger.error('journalIntegration', 'final exit with no tradeId on record, cannot journal', { symbol: record.symbol, reason });
    return;
  }

  const legs = record.tpOrders
    .filter(t => t.filled && t.level !== 'TP3')
    .map(t => ({ level: t.level, price: parseFloat(t.execution.execPrice), qty: parseFloat(t.execution.execQty) }));

  if (reason === 'TAKE_PROFIT_FINAL' && exec) {
    legs.push({ level: 'TP3', price: parseFloat(exec.execPrice), qty: parseFloat(exec.execQty) });
  } else {
    // SL / breakeven / trailing / manual close: `exec` is the closing
    // fill for whatever qty remained on the position.
    const price = exec ? parseFloat(exec.execPrice) : record.slPrice;
    const qty = exec ? parseFloat(exec.execQty) : record.remainingQty;
    legs.push({ level: 'FINAL', price, qty });
  }

  const closedAt = exec ? Number(exec.execTime) : Date.now();
  tradeJournal.closeTrade(record.tradeId, {
    side: record.side,
    entryPrice: record.entryPrice,
    stopDistance: record.stopDistance,
    totalQty: record.totalQty,
    finalExitReason: reason,
    legs,
    closedAt,
  });

  const finalLeg = legs[legs.length - 1];
  tradeJournal.appendChartMarker(record.tradeId, { type: 'exit', time: closedAt, price: finalLeg.price, reason });
}

module.exports = { onPartialFill, onFinalExit };
