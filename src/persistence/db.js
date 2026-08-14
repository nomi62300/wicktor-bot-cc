// SQLite via Node's built-in node:sqlite (see M1 commit note — swapped in
// for better-sqlite3, whose native bindings don't build against this
// Node version). DB_PATH must point inside a Render persistent Disk in
// production, or trade history is wiped on every deploy/restart (brief
// section 6 — a real persistent server still needs a mounted Disk, not
// just "a long-running process", for the filesystem itself to survive).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const dir = path.dirname(config.dbPath);
if (dir && dir !== '.' && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    band TEXT NOT NULL,
    entry_tf TEXT NOT NULL,
    entry_price REAL NOT NULL,
    stop_distance REAL NOT NULL,
    total_qty REAL NOT NULL,
    risk_amount_usdt REAL NOT NULL,
    account_balance_before REAL NOT NULL,
    opened_at INTEGER NOT NULL,

    tp1_filled INTEGER NOT NULL DEFAULT 0,
    tp1_price REAL,
    tp1_qty REAL,
    tp1_filled_at INTEGER,

    tp2_filled INTEGER NOT NULL DEFAULT 0,
    tp2_price REAL,
    tp2_qty REAL,
    tp2_filled_at INTEGER,

    tp3_filled INTEGER NOT NULL DEFAULT 0,
    tp3_price REAL,
    tp3_qty REAL,
    tp3_filled_at INTEGER,

    final_exit_reason TEXT,
    exit_price REAL,
    realized_pnl_usdt REAL,
    r_multiple REAL,
    account_balance_after REAL,
    closed_at INTEGER,

    status TEXT NOT NULL DEFAULT 'open'
  );

  CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
  CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at);

  CREATE TABLE IF NOT EXISTS balance_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    balance REAL NOT NULL,
    note TEXT
  );

  -- Phase 4 (brief 7a/9d): per-trade chart data. candles/jaw/teeth/lips
  -- are the bot's own live-computed values at entry decision time, not
  -- recalculated after the fact. markers_json accumulates entry/TP-fill/
  -- exit events as they happen (see tradeJournal.appendChartMarker).
  CREATE TABLE IF NOT EXISTS trade_charts (
    trade_id INTEGER PRIMARY KEY REFERENCES trades(id),
    entry_tf TEXT NOT NULL,
    candles_json TEXT NOT NULL,
    jaw_json TEXT NOT NULL,
    teeth_json TEXT NOT NULL,
    lips_json TEXT NOT NULL,
    markers_json TEXT NOT NULL DEFAULT '[]',
    sl_price REAL,
    tp1_price REAL,
    tp2_price REAL,
    tp3_price REAL
  );
`);

module.exports = db;
