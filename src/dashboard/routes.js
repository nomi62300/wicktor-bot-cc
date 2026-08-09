const express = require('express');
const path = require('path');
const { computeStats } = require('./stats');
const tradeJournal = require('../persistence/tradeJournal');
const positionStore = require('../trading/positionStore');
const positionMonitor = require('../trading/positionMonitor');
const journalIntegration = require('../trading/journalIntegration');
const bybit = require('../market/bybitClient');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Guards state-changing endpoints with ADMIN_TOKEN (see config.js). If
 * unset, the action is allowed but a warning is logged on every request —
 * fine for local dev, not for a public deploy that can close real
 * positions.
 */
function requireAdminToken(req, res, next) {
  if (!config.adminToken) {
    logger.warn('routes', 'admin action allowed with NO ADMIN_TOKEN configured — set ADMIN_TOKEN in production', { path: req.path });
    return next();
  }
  if (req.get('x-admin-token') !== config.adminToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

router.get('/performance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'performance.html'));
});

router.get('/api/stats', (req, res) => {
  res.json(computeStats());
});

/**
 * Concurrently-open bot-tracked positions with LIVE unrealized PnL,
 * queried fresh from Bybit on every request — not cached, not inferred
 * from entry price alone (mark price moves continuously).
 */
router.get('/api/positions/live', async (req, res) => {
  const tracked = positionStore.listPositions();
  if (tracked.length === 0) return res.json([]);

  const results = await Promise.all(tracked.map(async (record) => {
    try {
      const posRes = await bybit.getPositionInfo({ category: 'linear', symbol: record.symbol });
      const live = posRes.retCode === 0 ? posRes.result.list.find(p => parseFloat(p.size) > 0) : null;
      const markPrice = live ? parseFloat(live.markPrice) : null;
      const unrealizedPnlUsdt = live ? parseFloat(live.unrealisedPnl) : null;
      const riskAmountUsdt = record.stopDistance * record.totalQty;
      const unrealizedRMultiple = (unrealizedPnlUsdt != null && riskAmountUsdt > 0) ? unrealizedPnlUsdt / riskAmountUsdt : null;

      return {
        symbol: record.symbol,
        side: record.side,
        entryTf: record.entryTf,
        entryPrice: record.entryPrice,
        stage: record.stage,
        slPrice: record.slPrice,
        totalQty: record.totalQty,
        remainingQty: record.remainingQty,
        markPrice,
        unrealizedPnlUsdt,
        unrealizedRMultiple,
        tpLegs: record.tpOrders.map(t => ({ level: t.level, price: t.price, qty: t.qty, filled: t.filled })),
        openedAt: record.openedAt,
        tradeId: record.tradeId,
      };
    } catch (err) {
      logger.warn('routes', 'live position lookup failed for one symbol', { symbol: record.symbol, error: err.message });
      return { symbol: record.symbol, error: 'live_lookup_failed' };
    }
  }));

  res.json(results);
});

/**
 * Manually closes a bot-tracked open position: cancels its resting TP/SL
 * orders, closes at market, and finalizes the trade journal from the real
 * closing execution (exit reason MANUAL_CLOSE) — same verify-don't-trust
 * pattern as every other exit path, not a synthetic close.
 */
router.post('/api/positions/:symbol/close', requireAdminToken, async (req, res) => {
  const { symbol } = req.params;
  if (!positionStore.getPosition(symbol)) {
    return res.status(404).json({ ok: false, error: 'not_tracked_by_bot' });
  }
  try {
    const result = await positionMonitor.closePositionManually(symbol, journalIntegration);
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    logger.error('routes', 'manual close threw', { symbol, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/trades', (req, res) => {
  res.json(tradeJournal.getAllTrades());
});

const CSV_COLUMNS = [
  'id', 'symbol', 'side', 'band', 'entry_tf', 'entry_price', 'stop_distance', 'total_qty',
  'risk_amount_usdt', 'account_balance_before', 'opened_at',
  'tp1_filled', 'tp1_price', 'tp1_qty', 'tp2_filled', 'tp2_price', 'tp2_qty',
  'tp3_filled', 'tp3_price', 'tp3_qty',
  'final_exit_reason', 'exit_price', 'realized_pnl_usdt', 'r_multiple',
  'account_balance_after', 'closed_at', 'status',
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/api/trades.csv', (req, res) => {
  const trades = tradeJournal.getAllTrades();
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of trades) {
    lines.push(CSV_COLUMNS.map(c => csvEscape(t[c])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wicktor_trades.csv"');
  res.send(lines.join('\n'));
});

module.exports = router;
