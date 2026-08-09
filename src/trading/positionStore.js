// In-memory tracked-position store, keyed by symbol (brief section 4: max
// 1 open position per symbol). This is the source of truth positionMonitor
// uses to know which TP/SL orderIds belong to which leg, and what stage
// (initial/breakeven/trailing) a position is in — the internal state
// machine that exit reasons are derived from (brief 5c), never PnL sign.
//
// M5 will wrap this with SQLite-backed persistence (so tracked positions
// survive a restart); the interface here is deliberately small so that
// swap doesn't touch positionMonitor.js's logic.
const { STAGE } = require('./exitReasons');

const positions = new Map(); // symbol -> record

function addPosition(record) {
  positions.set(record.symbol, {
    ...record,
    stage: STAGE.INITIAL,
    lastCheckedTime: record.openedAt,
  });
}

function getPosition(symbol) {
  return positions.get(symbol) || null;
}

function listPositions() {
  return Array.from(positions.values());
}

function updatePosition(symbol, patch) {
  const existing = positions.get(symbol);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  positions.set(symbol, updated);
  return updated;
}

function removePosition(symbol) {
  positions.delete(symbol);
}

function openPositionCount() {
  return positions.size;
}

module.exports = { addPosition, getPosition, listPositions, updatePosition, removePosition, openPositionCount };
