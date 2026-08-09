const express = require('express');
const path = require('path');
const { computeStats } = require('./stats');
const tradeJournal = require('../persistence/tradeJournal');

const router = express.Router();

router.get('/performance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'performance.html'));
});

router.get('/api/stats', (req, res) => {
  res.json(computeStats());
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
