// Tight-cadence (30-60s) monitoring of open positions — separated from the
// coarser entry-scan cadence (brief 5d). The old bot's jaw-invalidation
// exit closed at whatever price existed when its 3-minute loop next ran,
// not a pre-committed price like the native SL — the leading theory for
// its true outlier losses. Running this loop tightly is the fix.
//
// Exit reason is ALWAYS derived from real execution data — matching a
// fill's orderId against our own tracked TP legs, or Bybit's execution-
// level `stopOrderType: 'StopLoss'` field for native SL fires — never
// inferred from PnL sign (brief 5c).
const bybit = require('../market/bybitClient');
const { Indicators } = require('../engine');
const { getKlines } = require('../market/candles');
const { roundPriceToTick } = require('../market/instrumentInfo');
const store = require('./positionStore');
const { EXIT_REASONS, STAGE, slExitReasonForStage } = require('./exitReasons');
const logger = require('../utils/logger');

async function fetchNewExecutions(symbol, sinceMs) {
  const res = await bybit.getExecutionList({ category: 'linear', symbol, limit: 50 });
  if (res.retCode !== 0) {
    logger.warn('positionMonitor', 'getExecutionList failed', { symbol, retCode: res.retCode, retMsg: res.retMsg });
    return [];
  }
  return res.result.list
    .filter(e => Number(e.execTime) > sinceMs)
    .sort((a, b) => Number(a.execTime) - Number(b.execTime));
}

function findFilledLeg(record, execution) {
  return record.tpOrders.find(tp => tp.orderId === execution.orderId && !tp.filled);
}

function isNativeSlFill(record, execution) {
  return execution.stopOrderType === 'StopLoss' || execution.orderId === record.slOrderId;
}

async function cancelRemainingOrders(symbol) {
  const res = await bybit.cancelAllOrders({ category: 'linear', symbol });
  if (res.retCode !== 0) {
    logger.warn('positionMonitor', 'cancelAllOrders failed after close', { symbol, retCode: res.retCode, retMsg: res.retMsg });
  }
}

/**
 * Checks whether the Alligator jaw-touch invalidation is currently active
 * against this position's bias, using fresh candles on the entry TF.
 */
async function checkJawInvalidation(record) {
  const candles = await getKlines(record.symbol, record.entryTf, 150);
  if (!candles) return false;
  const snapshot = Indicators.analyzeTimeframe(candles);
  if (!snapshot) return false;
  // record.side 'Buy' expects bullish (alignment 1); 'Sell' expects bearish (-1).
  // alligatorInvalidated is the explicit jaw-touch flag regardless of what
  // alignment got reset to.
  return snapshot.alligatorInvalidated === true;
}

/**
 * Processes one open position: detects fills via real execution data,
 * moves the SL on TP1/TP2 fills, runs the jaw-invalidation check, and
 * reports every exit event via callbacks (M5's tradeJournal subscribes
 * here; for now a default no-op logger is used).
 *
 * callbacks: { onPartialFill(record, leg, execution, reason),
 *              onFinalExit(record, reason, execution) }
 */
async function monitorOne(record, callbacks) {
  const executions = await fetchNewExecutions(record.symbol, record.lastCheckedTime);
  let latestTime = record.lastCheckedTime;
  let closed = false;

  for (const exec of executions) {
    latestTime = Math.max(latestTime, Number(exec.execTime));

    // Opening fills (the entry itself) are always on record.side; every
    // closing fill (TP/SL/jaw) is always the opposite side, since they're
    // all reduce-only. A small gap between the entry's real exec timestamp
    // and this record's lastCheckedTime (e.g. right after a reconciliation
    // re-link) can otherwise surface the entry fill itself as a spurious
    // "unrecognized execution" on the very first monitor tick.
    if (exec.side === record.side) continue;

    const leg = findFilledLeg(record, exec);
    if (leg) {
      leg.filled = true;
      leg.execution = exec;
      record.remainingQty = Math.max(0, record.remainingQty - parseFloat(exec.execQty));

      if (leg.level === 'TP1') {
        const bePrice = roundPriceToTick(record.entryPrice, record.instrumentInfo.tickSize, record.side === 'Buy' ? 'up' : 'down');
        const res = await bybit.setTradingStop({ category: 'linear', symbol: record.symbol, stopLoss: bePrice.toString(), positionIdx: 0 });
        if (res.retCode !== 0) {
          logger.error('positionMonitor', 'breakeven SL move failed', { symbol: record.symbol, retCode: res.retCode, retMsg: res.retMsg });
        }
        record.stage = STAGE.BREAKEVEN;
        record.slPrice = bePrice;
        logger.info('positionMonitor', 'TP1 filled, SL moved to breakeven', { symbol: record.symbol, bePrice });
        await callbacks.onPartialFill(record, leg, exec, EXIT_REASONS.PARTIAL_TP1);
      } else if (leg.level === 'TP2') {
        const tp1Price = record.tpOrders.find(t => t.level === 'TP1').price;
        const res = await bybit.setTradingStop({ category: 'linear', symbol: record.symbol, stopLoss: tp1Price.toString(), positionIdx: 0 });
        if (res.retCode !== 0) {
          logger.error('positionMonitor', 'trailing SL move failed', { symbol: record.symbol, retCode: res.retCode, retMsg: res.retMsg });
        }
        record.stage = STAGE.TRAILING;
        record.slPrice = tp1Price;
        logger.info('positionMonitor', 'TP2 filled, SL trailed to TP1 price', { symbol: record.symbol, tp1Price });
        await callbacks.onPartialFill(record, leg, exec, EXIT_REASONS.PARTIAL_TP2);
      } else if (leg.level === 'TP3') {
        logger.info('positionMonitor', 'TP3 (final) filled', { symbol: record.symbol });
        await callbacks.onFinalExit(record, EXIT_REASONS.TAKE_PROFIT_FINAL, exec);
        closed = true;
      }
      continue;
    }

    if (isNativeSlFill(record, exec)) {
      const reason = slExitReasonForStage(record.stage);
      logger.info('positionMonitor', 'native SL fired', { symbol: record.symbol, stage: record.stage, reason });
      await callbacks.onFinalExit(record, reason, exec);
      closed = true;
      continue;
    }

    logger.warn('positionMonitor', 'unrecognized execution for tracked position', {
      symbol: record.symbol, orderId: exec.orderId, stopOrderType: exec.stopOrderType,
    });
  }

  record.lastCheckedTime = latestTime;

  if (closed || record.remainingQty <= 0) {
    await cancelRemainingOrders(record.symbol);
    store.removePosition(record.symbol);
    return;
  }

  // Jaw-invalidation check — only reached if the position is still open.
  const invalidated = await checkJawInvalidation(record);
  if (invalidated) {
    const closeSide = record.side === 'Buy' ? 'Sell' : 'Buy';
    logger.info('positionMonitor', 'jaw invalidation triggered, closing at market', { symbol: record.symbol, remainingQty: record.remainingQty });
    const closeRes = await bybit.submitOrder({
      category: 'linear',
      symbol: record.symbol,
      side: closeSide,
      orderType: 'Market',
      qty: record.remainingQty.toString(),
      timeInForce: 'IOC',
      reduceOnly: true,
    });
    if (closeRes.retCode !== 0) {
      logger.error('positionMonitor', 'jaw invalidation close order rejected', { symbol: record.symbol, retCode: closeRes.retCode, retMsg: closeRes.retMsg });
      store.updatePosition(record.symbol, record);
      return;
    }
    // Re-query real execution to confirm actual close price rather than
    // assuming the submit response reflects reality (same bug #1 principle).
    const confirmExecs = await fetchNewExecutions(record.symbol, record.lastCheckedTime);
    const closeExec = confirmExecs.find(e => e.orderId === closeRes.result.orderId) || null;
    await callbacks.onFinalExit(record, EXIT_REASONS.JAW_INVALIDATION, closeExec);
    await cancelRemainingOrders(record.symbol);
    store.removePosition(record.symbol);
    return;
  }

  store.updatePosition(record.symbol, record);
}

const defaultCallbacks = {
  onPartialFill: async (record, leg, exec, reason) => {
    logger.info('positionMonitor', 'partial fill (default handler)', { symbol: record.symbol, level: leg.level, reason });
  },
  onFinalExit: async (record, reason, exec) => {
    logger.info('positionMonitor', 'position closed (default handler)', { symbol: record.symbol, reason });
  },
};

async function monitorAllPositions(callbacks = defaultCallbacks) {
  const open = store.listPositions();
  for (const record of open) {
    try {
      await monitorOne(record, callbacks);
    } catch (err) {
      logger.error('positionMonitor', 'monitorOne threw, skipping this position for this tick', {
        symbol: record.symbol, error: err.message,
      });
    }
  }
}

module.exports = { monitorAllPositions, monitorOne, checkJawInvalidation };
