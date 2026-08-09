// All tunables read from process.env at startup — never hardcoded, so
// deployments can be adjusted (bankroll, risk, cadence) without a code
// change (brief section 3a).
require('dotenv').config();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function envFloat(name, fallback) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : parseFloat(v);
}

function envInt(name, fallback) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : parseInt(v, 10);
}

const config = {
  bybit: {
    apiKey: requireEnv('BYBIT_DEMO_API_KEY'),
    apiSecret: requireEnv('BYBIT_DEMO_API_SECRET'),
    demoTrading: true,
  },
  accountSizeUsdt: envFloat('INTENDED_ACCOUNT_SIZE_USDT', 100),
  port: envInt('PORT', 3000),
  dbPath: process.env.DB_PATH || './data/wicktor.db',
  riskPct: envFloat('RISK_PCT', 0.0015),
  leverage: envInt('LEVERAGE', 5),
  maxPositions: envInt('MAX_POSITIONS', 3),
  stopAtrFloorMult: envFloat('STOP_ATR_FLOOR_MULT', 1.0),
  // undefined (unset) = no cap, by design — see .env.example comment.
  maxNotionalPctOfBankroll: process.env.MAX_NOTIONAL_PCT_OF_BANKROLL
    ? parseFloat(process.env.MAX_NOTIONAL_PCT_OF_BANKROLL)
    : undefined,
  minTurnover24hUsdt: envFloat('MIN_TURNOVER_24H_USDT', 15_000_000),
  positionMonitorIntervalMs: envInt('POSITION_MONITOR_INTERVAL_MS', 30_000),
  entryScanIntervalMs: envInt('ENTRY_SCAN_INTERVAL_MS', 60_000),
};

module.exports = config;
