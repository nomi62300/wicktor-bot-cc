// Orchestrates two independently-paced loops in one process (brief 6):
// a tight position-monitor loop and a coarser entry-scan loop. Each phase
// is wrapped in its own try/catch, AND each individual entry attempt
// inside the scan loop gets its own try/catch too (brief 5g — the old
// bot's outer per-cycle catch alone let one bad `enterPosition()` call
// silently abort every other queued signal in that cycle; the outer
// catch is not a substitute for a per-iteration one).
const bybit = require('../market/bybitClient');
const config = require('../config');
const { getTradeableUniverse } = require('../market/universe');
const { scanUniverse } = require('./signalScanner');
const { getKlines } = require('../market/candles');
const { computeStopLoss } = require('./stopLoss');
const { computePositionSize } = require('./positionSizing');
const { executeEntry } = require('./orderExecution');
const { getInstrumentInfo } = require('../market/instrumentInfo');
const { monitorAllPositions } = require('./positionMonitor');
const store = require('./positionStore');
const tradeJournal = require('../persistence/tradeJournal');
const bankroll = require('../persistence/bankroll');
const journalIntegration = require('./journalIntegration');
const logger = require('../utils/logger');

let scanRunning = false;
let monitorRunning = false;

function findSlOrder(orders) {
  return orders.find(o => o.reduceOnly && o.triggerPrice && o.triggerPrice !== '');
}

/**
 * Startup reconciliation against Bybit's actual live position state
 * (brief 5f) — don't start scanning blind after a restart. Best-effort:
 * a position that predates this process run has its TP/SL orderIds
 * reconstructed from currently-open orders (sorted by price), but its
 * original entry timeframe can't be recovered — defaults to 'm15' (the
 * more conservative of the two possible entry TFs) for jaw-invalidation
 * checks, logged explicitly so this assumption is visible.
 *
 * SAFETY: a Demo Trading account is not necessarily exclusive to this bot
 * — confirmed live that this account already carried substantial
 * unrelated position/order history from before this bot ever ran. Only
 * positions with an identifiable 3-leg reduce-only TP structure matching
 * this bot's own order-placement pattern are adopted for monitoring;
 * anything else is logged and left strictly untouched. The bot must never
 * move stops on, or jaw-invalidation-close, a position it didn't open —
 * "no open position tracking" is a strictly safer failure mode here than
 * "manage a foreign position based on a guess."
 */
async function reconcileOpenPositions() {
  const res = await bybit.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });
  if (res.retCode !== 0) {
    logger.error('cycle', 'startup reconciliation: getPositionInfo failed', { retCode: res.retCode, retMsg: res.retMsg });
    return;
  }
  const openPositions = res.result.list.filter(p => parseFloat(p.size) > 0);
  for (const p of openPositions) {
    if (store.getPosition(p.symbol)) continue;
    try {
      const ordersRes = await bybit.getActiveOrders({ category: 'linear', symbol: p.symbol });
      const orders = ordersRes.retCode === 0 ? ordersRes.result.list : [];
      const slOrder = findSlOrder(orders);
      const tpCandidates = orders
        .filter(o => o.reduceOnly && o.orderType === 'Limit')
        .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

      if (tpCandidates.length !== 3) {
        logger.warn('cycle', 'foreign open position found — no matching 3-leg TP structure, leaving untouched', {
          symbol: p.symbol, side: p.side, size: p.size, reduceOnlyLimitOrdersFound: tpCandidates.length,
        });
        continue;
      }

      const sorted = p.side === 'Buy' ? tpCandidates : tpCandidates.slice().reverse();
      const levels = ['TP1', 'TP2', 'TP3'];
      const tpOrders = sorted.map((o, i) => ({
        level: levels[i], orderId: o.orderId, qty: parseFloat(o.qty), price: parseFloat(o.price), filled: false,
      }));
      const instrumentInfo = await getInstrumentInfo(p.symbol);
      const size = parseFloat(p.size);

      store.addPosition({
        symbol: p.symbol,
        side: p.side,
        entryPrice: parseFloat(p.avgPrice),
        stopDistance: p.stopLoss ? Math.abs(parseFloat(p.avgPrice) - parseFloat(p.stopLoss)) : null,
        slPrice: p.stopLoss ? parseFloat(p.stopLoss) : null,
        slOrderId: slOrder ? slOrder.orderId : null,
        entryTf: 'm15', // unknown after restart — see doc comment above
        totalQty: size,
        remainingQty: size,
        tpOrders,
        instrumentInfo,
        bankrollBeforeTrade: config.accountSizeUsdt,
        openedAt: Date.now(),
      });
      logger.warn('cycle', 'reconciled pre-existing open position from live Bybit state', {
        symbol: p.symbol, side: p.side, size, note: 'entryTf assumed m15, original qty/openedAt unknown',
      });
    } catch (err) {
      logger.error('cycle', 'reconciliation failed for one position, skipping it', { symbol: p.symbol, error: err.message });
    }
  }
}

/**
 * Checks Bybit's ACTUAL live position state for a symbol — not just this
 * bot's own internal store. Confirmed live: this Demo Trading account
 * already carried pre-existing positions unrelated to this bot (see
 * reconcileOpenPositions' foreign-position handling). Without this check,
 * a new entry order merges into (stacks onto) whatever position already
 * exists on that symbol, and a subsequent setTradingStop call then applies
 * to the WHOLE merged position, not just this bot's share of it — silently
 * altering risk management on a position this bot doesn't own. This is a
 * stricter, exchange-truth version of the "max 1 position per symbol"
 * rule in brief section 4 (no stacking/pyramiding), extended to cover
 * foreign positions too, not just this bot's own.
 */
async function hasAnyLivePosition(symbol) {
  const res = await bybit.getPositionInfo({ category: 'linear', symbol });
  if (res.retCode !== 0) {
    logger.warn('cycle', 'live position check failed, treating as occupied (fail safe)', { symbol, retCode: res.retCode });
    return true;
  }
  return res.result.list.some(p => parseFloat(p.size) > 0);
}

async function attemptEntry(decision, bankrollUsdt) {
  const { symbol, entryTf, evaluation } = decision;

  if (await hasAnyLivePosition(symbol)) {
    logger.info('cycle', 'skip: symbol already has a live position on the exchange (ours or foreign)', { symbol });
    return;
  }

  const candles = await getKlines(symbol, entryTf);
  if (!candles || candles.length < 40) {
    logger.warn('cycle', 'insufficient candles for entry, skipping', { symbol, entryTf });
    return;
  }

  const entryPrice = candles[candles.length - 1].c; // confirmed closed candle only (candles.js trims unclosed)
  const side = evaluation.bias === 1 ? 'Buy' : 'Sell';
  const instrumentInfo = await getInstrumentInfo(symbol);
  const sl = computeStopLoss(side, candles, entryPrice);
  const sizing = computePositionSize({ symbol, side, bankrollUsdt, entryPrice, stopDistance: sl.stopDistance, instrumentInfo });

  if (sizing.skip) {
    logger.info('cycle', 'entry skipped by position sizing', { symbol, reason: sizing.skipReason });
    return;
  }

  const result = await executeEntry({
    symbol, side, qty: sizing.qty, entryPrice, slPrice: sl.slPrice, stopDistance: sl.stopDistance, instrumentInfo,
  });

  if (!result.ok) {
    logger.error('cycle', 'entry execution failed', { symbol, errors: result.errors });
    return;
  }

  const slOrder = findSlOrder(result.orders);
  const openedAt = Date.now();
  const tradeId = tradeJournal.openTrade({
    symbol, side, band: decision.band, entryTf, entryPrice,
    stopDistance: sl.stopDistance, totalQty: sizing.qty,
    riskAmountUsdt: sizing.riskAmountUsdt, accountBalanceBefore: bankrollUsdt, openedAt,
  });

  store.addPosition({
    symbol, side, entryPrice,
    stopDistance: sl.stopDistance,
    slPrice: sl.slPrice,
    slOrderId: slOrder ? slOrder.orderId : null,
    entryTf,
    totalQty: sizing.qty,
    remainingQty: sizing.qty,
    tpOrders: result.tpLevels.map(tp => ({ level: tp.level, orderId: tp.orderId, qty: tp.qty, price: tp.price, filled: false })),
    instrumentInfo,
    bankrollBeforeTrade: bankrollUsdt,
    openedAt,
    tradeId,
  });
  logger.info('cycle', 'entry registered for monitoring', { symbol, side, qty: sizing.qty, band: decision.band, tradeId });
}

/**
 * Entry-scan cycle: coarser cadence, tied to candle closes. `getBankroll`
 * is injected (M5's persistence/bankroll.js will supply the real running
 * balance; defaults to the configured starting bankroll for now).
 */
async function runEntryScanCycle(getBankroll = async () => bankroll.getCurrentBalance()) {
  if (scanRunning) {
    logger.warn('cycle', 'scan cycle already running, skipping this tick');
    return;
  }
  scanRunning = true;
  try {
    if (store.openPositionCount() >= config.maxPositions) {
      logger.info('cycle', 'max concurrent positions open, skipping scan', { open: store.openPositionCount() });
      return;
    }

    let universe;
    try {
      universe = await getTradeableUniverse();
    } catch (err) {
      logger.error('cycle', 'universe fetch failed, skipping this scan tick', { error: err.message });
      return;
    }

    let results;
    try {
      results = await scanUniverse(universe);
    } catch (err) {
      logger.error('cycle', 'signal scan failed, skipping this scan tick', { error: err.message });
      return;
    }

    const bankrollUsdt = await getBankroll();
    const candidates = results.filter(r => r.tradeable && !store.getPosition(r.symbol));

    for (const decision of candidates) {
      if (store.openPositionCount() >= config.maxPositions) {
        logger.info('cycle', 'max concurrent positions reached mid-scan, stopping further entries this tick');
        break;
      }
      try {
        await attemptEntry(decision, bankrollUsdt);
      } catch (err) {
        // One bad entry attempt (exchange rejection, sizing throw, etc.)
        // must never abort the remaining queued candidates (brief 5g).
        logger.error('cycle', 'entry attempt threw, skipping this symbol only', { symbol: decision.symbol, error: err.message });
      }
    }
  } finally {
    scanRunning = false;
  }
}

/**
 * Position-monitor cycle: tight cadence, independent of the scan cycle.
 */
async function runPositionMonitorCycle(callbacks) {
  if (monitorRunning) {
    logger.warn('cycle', 'monitor cycle already running, skipping this tick');
    return;
  }
  monitorRunning = true;
  try {
    await monitorAllPositions(callbacks);
  } catch (err) {
    logger.error('cycle', 'monitorAllPositions threw unexpectedly', { error: err.message });
  } finally {
    monitorRunning = false;
  }
}

/**
 * Wires both loops on their own `setInterval`s (not cron — one continuously
 * running process, brief section 6) and runs an initial tick of each
 * immediately after startup reconciliation.
 */
async function startTradingLoop({ getBankroll, monitorCallbacks = journalIntegration } = {}) {
  await reconcileOpenPositions();

  await runPositionMonitorCycle(monitorCallbacks);
  await runEntryScanCycle(getBankroll);

  const monitorTimer = setInterval(() => runPositionMonitorCycle(monitorCallbacks), config.positionMonitorIntervalMs);
  const scanTimer = setInterval(() => runEntryScanCycle(getBankroll), config.entryScanIntervalMs);

  return { monitorTimer, scanTimer };
}

module.exports = { startTradingLoop, runEntryScanCycle, runPositionMonitorCycle, reconcileOpenPositions };
