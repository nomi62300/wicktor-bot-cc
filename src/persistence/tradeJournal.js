// Trade journal: one row per full position lifecycle (open -> partial
// fills -> final close), updated incrementally as real fills are detected
// by positionMonitor. Every field brief section 8 requires is captured,
// plus which TP level(s) filled before final close and the account
// balance immediately before/after (for the max-drawdown calc in
// section 7). Exit reason is only ever written from positionMonitor's
// exitReasons state machine — never computed here from PnL sign.
const db = require('./db');
const bankroll = require('./bankroll');
const logger = require('../utils/logger');

/**
 * Opens a new trade record when an entry is executed. Returns the row id.
 */
function openTrade({ symbol, side, band, entryTf, entryPrice, stopDistance, totalQty, riskAmountUsdt, accountBalanceBefore, openedAt }) {
  const res = db.prepare(`
    INSERT INTO trades (symbol, side, band, entry_tf, entry_price, stop_distance, total_qty, risk_amount_usdt, account_balance_before, opened_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(symbol, side, band, entryTf, entryPrice, stopDistance, totalQty, riskAmountUsdt, accountBalanceBefore, openedAt);
  return res.lastInsertRowid;
}

function findOpenTradeId(symbol, openedAt) {
  const row = db.prepare(`SELECT id FROM trades WHERE symbol = ? AND status = 'open' AND opened_at = ? ORDER BY id DESC LIMIT 1`).get(symbol, openedAt);
  return row ? row.id : null;
}

/**
 * Used by startup reconciliation to re-link a position that predates this
 * process run back to its original journal row (positionStore is
 * in-memory only, so a restart otherwise orphans the tradeId — the exact
 * gap that surfaced live-testing a server restart: a position opened just
 * before a restart got re-adopted with no tradeId, so its eventual close
 * would never have been journaled). Most-recent open row for the symbol
 * is assumed to be the match, since brief section 4 caps at 1 open
 * position per symbol.
 */
function findMostRecentOpenTrade(symbol) {
  const row = db.prepare(`SELECT * FROM trades WHERE symbol = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(symbol);
  return row || null;
}

/**
 * Records a partial TP fill (TP1 or TP2 — TP3/final goes through
 * closeTrade instead, since it also finalizes the row).
 */
function recordPartialFill(tradeId, level, price, qty, filledAt) {
  const col = level.toLowerCase(); // 'tp1' | 'tp2'
  db.prepare(`UPDATE trades SET ${col}_filled = 1, ${col}_price = ?, ${col}_qty = ?, ${col}_filled_at = ? WHERE id = ?`)
    .run(price, qty, filledAt, tradeId);
  logger.info('tradeJournal', 'partial fill recorded', { tradeId, level, price, qty });
}

/**
 * Finalizes a trade: computes realized PnL and R-multiple from the actual
 * fill data captured across the position's lifecycle, applies the PnL to
 * the internal bankroll, and marks the row closed.
 *
 * legs: array of { level, price, qty } for every leg that filled,
 * INCLUDING the final one (TP3, or whatever qty remained when SL/jaw/etc.
 * closed it) — the caller (positionMonitor's callback wiring) is
 * responsible for passing the real fill data, never inferring it.
 */
function closeTrade(tradeId, { side, entryPrice, stopDistance, totalQty, finalExitReason, legs, closedAt }) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  if (!trade) {
    logger.error('tradeJournal', 'closeTrade: trade id not found', { tradeId });
    return null;
  }

  // Record TP3/final leg fields if this leg was TP3.
  const finalLeg = legs[legs.length - 1];
  if (finalLeg && finalLeg.level === 'TP3') {
    db.prepare('UPDATE trades SET tp3_filled = 1, tp3_price = ?, tp3_qty = ?, tp3_filled_at = ? WHERE id = ?')
      .run(finalLeg.price, finalLeg.qty, closedAt, tradeId);
  }

  const sign = side === 'Buy' ? 1 : -1;
  const totalFilledQty = legs.reduce((sum, l) => sum + l.qty, 0);
  const weightedExitPrice = totalFilledQty > 0
    ? legs.reduce((sum, l) => sum + l.price * l.qty, 0) / totalFilledQty
    : entryPrice;
  const realizedPnlUsdt = legs.reduce((sum, l) => sum + sign * (l.price - entryPrice) * l.qty, 0);
  const riskAmountUsdt = trade.risk_amount_usdt;
  const rMultiple = riskAmountUsdt > 0 ? realizedPnlUsdt / riskAmountUsdt : null;

  const accountBalanceAfter = bankroll.applyRealizedPnl(realizedPnlUsdt, `trade #${tradeId} ${trade.symbol} ${finalExitReason}`);

  db.prepare(`
    UPDATE trades SET
      final_exit_reason = ?, exit_price = ?, realized_pnl_usdt = ?, r_multiple = ?,
      account_balance_after = ?, closed_at = ?, status = 'closed'
    WHERE id = ?
  `).run(finalExitReason, weightedExitPrice, realizedPnlUsdt, rMultiple, accountBalanceAfter, closedAt, tradeId);

  logger.info('tradeJournal', 'trade closed', { tradeId, symbol: trade.symbol, finalExitReason, realizedPnlUsdt, rMultiple });
  return { tradeId, realizedPnlUsdt, rMultiple, accountBalanceAfter };
}

function getAllTrades() {
  return db.prepare('SELECT * FROM trades ORDER BY opened_at DESC').all();
}

function getClosedTrades() {
  return db.prepare(`SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC`).all();
}

/**
 * Persists the chart snapshot at entry time (brief 7a/9d) — candles and
 * Jaw/Teeth/Lips as the bot actually computed them for the entry decision,
 * never recalculated later. Seeds markers_json with the entry marker.
 */
function saveChartSnapshot(tradeId, { entryTf, candles, jaw, teeth, lips, entryPrice, entryTime, slPrice, tp1Price, tp2Price, tp3Price }) {
  const markers = [{ type: 'entry', time: entryTime, price: entryPrice }];
  db.prepare(`
    INSERT INTO trade_charts (trade_id, entry_tf, candles_json, jaw_json, teeth_json, lips_json, markers_json, sl_price, tp1_price, tp2_price, tp3_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trade_id) DO NOTHING
  `).run(
    tradeId, entryTf, JSON.stringify(candles), JSON.stringify(jaw), JSON.stringify(teeth), JSON.stringify(lips),
    JSON.stringify(markers), slPrice, tp1Price ?? null, tp2Price ?? null, tp3Price ?? null,
  );
}

/**
 * Appends one marker (TP fill, final exit) to a trade's chart record.
 * No-op if no chart snapshot exists for this trade (e.g. a reconciled
 * position with no linked tradeId — same fail-safe pattern as journaling
 * itself, never fabricates data for a trade it doesn't have real data on).
 */
function appendChartMarker(tradeId, marker) {
  const row = db.prepare('SELECT markers_json FROM trade_charts WHERE trade_id = ?').get(tradeId);
  if (!row) return;
  const markers = JSON.parse(row.markers_json);
  markers.push(marker);
  db.prepare('UPDATE trade_charts SET markers_json = ? WHERE trade_id = ?').run(JSON.stringify(markers), tradeId);
}

function getChartData(tradeId) {
  const row = db.prepare('SELECT * FROM trade_charts WHERE trade_id = ?').get(tradeId);
  if (!row) return null;
  return {
    tradeId: row.trade_id,
    entryTf: row.entry_tf,
    candles: JSON.parse(row.candles_json),
    jaw: JSON.parse(row.jaw_json),
    teeth: JSON.parse(row.teeth_json),
    lips: JSON.parse(row.lips_json),
    markers: JSON.parse(row.markers_json),
    slPrice: row.sl_price,
    tp1Price: row.tp1_price,
    tp2Price: row.tp2_price,
    tp3Price: row.tp3_price,
  };
}

module.exports = {
  openTrade, findOpenTradeId, findMostRecentOpenTrade, recordPartialFill, closeTrade, getAllTrades, getClosedTrades,
  saveChartSnapshot, appendChartMarker, getChartData,
};
