// Internal virtual bankroll, tracked independently of Bybit's real demo
// account equity (brief section 6) — Demo accounts auto-initialize at
// 50,000 USDT with no clean way to set a custom starting balance via the
// API, and this account is also confirmed to carry unrelated foreign
// trading activity (see M4 commit notes), so Bybit's reported equity is
// not a usable substitute even as a sanity check. All position sizing
// uses this tracked balance, seeded from INTENDED_ACCOUNT_SIZE_USDT.
const db = require('./db');
const config = require('../config');
const logger = require('../utils/logger');

function getCurrentBalance() {
  const row = db.prepare('SELECT balance FROM balance_history ORDER BY id DESC LIMIT 1').get();
  if (row) return row.balance;
  // First run: seed from config, record it.
  recordBalance(config.accountSizeUsdt, 'initial seed from INTENDED_ACCOUNT_SIZE_USDT');
  return config.accountSizeUsdt;
}

function recordBalance(balance, note) {
  db.prepare('INSERT INTO balance_history (ts, balance, note) VALUES (?, ?, ?)').run(Date.now(), balance, note || null);
}

/**
 * Applies a completed trade's realized PnL to the running bankroll and
 * records the new balance. Returns the new balance.
 */
function applyRealizedPnl(pnlUsdt, note) {
  const before = getCurrentBalance();
  const after = before + pnlUsdt;
  recordBalance(after, note);
  logger.info('bankroll', 'balance updated', { before, pnlUsdt, after, note });
  return after;
}

function getBalanceHistory(limit = 500) {
  return db.prepare('SELECT ts, balance, note FROM balance_history ORDER BY id ASC LIMIT ?').all(limit);
}

module.exports = { getCurrentBalance, applyRealizedPnl, getBalanceHistory };
