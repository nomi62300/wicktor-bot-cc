// Computes every metric from brief section 7: the original Capital Base/
// Stats banner set, plus expectancy, avg-win/avg-loss ratio, max
// consecutive losses, max drawdown %, per-TP hit-rate breakdown, and
// per-symbol breakdown — all surfaced directly rather than left for the
// viewer to compute by hand from raw win$/loss$ totals.
const tradeJournal = require('../persistence/tradeJournal');
const bankroll = require('../persistence/bankroll');
const config = require('../config');

function computeStats() {
  const trades = tradeJournal.getClosedTrades().slice().reverse(); // oldest -> newest for streak/drawdown math

  const totalTrades = trades.length;
  const wins = trades.filter(t => t.realized_pnl_usdt > 0);
  const losses = trades.filter(t => t.realized_pnl_usdt <= 0);
  const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;

  const totalPnl = trades.reduce((s, t) => s + t.realized_pnl_usdt, 0);
  const grossWin = wins.reduce((s, t) => s + t.realized_pnl_usdt, 0);
  const grossLoss = losses.reduce((s, t) => s + t.realized_pnl_usdt, 0); // negative

  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0; // negative
  const avgWinLossRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;

  const rMultiples = trades.filter(t => t.r_multiple != null).map(t => t.r_multiple);
  const expectancy = rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : null;

  // Max consecutive losses
  let maxConsecutiveLosses = 0, curStreak = 0;
  for (const t of trades) {
    if (t.realized_pnl_usdt <= 0) { curStreak++; maxConsecutiveLosses = Math.max(maxConsecutiveLosses, curStreak); }
    else curStreak = 0;
  }

  // Max drawdown % — walked over the actual account_balance_after series
  let peak = trades.length > 0 ? trades[0].account_balance_before : config.accountSizeUsdt;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    peak = Math.max(peak, t.account_balance_after);
    const dd = peak > 0 ? (peak - t.account_balance_after) / peak : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
  }

  // Quality band breakdown
  const bandBreakdown = groupBy(trades, t => t.band, group => summarize(group));

  // Timeframe breakdown
  const tfBreakdown = groupBy(trades, t => t.entry_tf, group => summarize(group));

  // Exit distribution
  const exitBreakdown = groupBy(trades, t => t.final_exit_reason, group => ({
    count: group.length,
    netPnl: round2(group.reduce((s, t) => s + t.realized_pnl_usdt, 0)),
  }));

  // Per-TP hit-rate breakdown, plus genuine-stop-loss and breakeven-stop
  // hit rates as their own distinct counts — kept separate per brief
  // section 8 (STOP_LOSS_HIT / BREAKEVEN_STOP / TRAILING_STOP_HIT are
  // deliberately different exit reasons, not conflated into one "stop
  // hit" bucket). Each exposes both the raw count and the rate, since a
  // bare percentage on a small trade count is easy to misread.
  const countAndRate = (count) => ({ count, rate: totalTrades > 0 ? round4(count / totalTrades) : 0 });
  const tpHitRate = {
    tp1: countAndRate(trades.filter(t => t.tp1_filled).length),
    tp2: countAndRate(trades.filter(t => t.tp2_filled).length),
    tp3: countAndRate(trades.filter(t => t.tp3_filled).length),
    slHit: countAndRate(trades.filter(t => t.final_exit_reason === 'STOP_LOSS_HIT').length),
    breakeven: countAndRate(trades.filter(t => t.final_exit_reason === 'BREAKEVEN_STOP').length),
  };

  // Per-symbol breakdown
  const symbolBreakdown = groupBy(trades, t => t.symbol, group => summarize(group));

  return {
    capitalBase: config.accountSizeUsdt,
    currentBalance: bankroll.getCurrentBalance(),
    totalTrades,
    winRate: round4(winRate),
    grossWin: round2(grossWin),
    grossLoss: round2(grossLoss),
    netPnl: round2(totalPnl),
    avgWin: round4(avgWin),
    avgLoss: round4(avgLoss),
    avgWinLossRatio: avgWinLossRatio != null ? round2(avgWinLossRatio) : null,
    expectancyR: expectancy != null ? round3(expectancy) : null,
    maxConsecutiveLosses,
    maxDrawdownPct: round4(maxDrawdownPct),
    bandBreakdown,
    tfBreakdown,
    exitBreakdown,
    tpHitRate,
    symbolBreakdown,
  };
}

function summarize(group) {
  const wins = group.filter(t => t.realized_pnl_usdt > 0);
  return {
    count: group.length,
    winRate: group.length > 0 ? round4(wins.length / group.length) : 0,
    netPnl: round2(group.reduce((s, t) => s + t.realized_pnl_usdt, 0)),
  };
}

function groupBy(rows, keyFn, summaryFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = {};
  for (const [key, group] of groups) out[key] = summaryFn(group);
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = { computeStats };
