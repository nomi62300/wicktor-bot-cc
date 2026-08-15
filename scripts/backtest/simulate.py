#!/usr/bin/env python3
"""
Execution/risk simulation layer for the backtesting pipeline (see
prancy-wibbling-feather.md's "Backtesting pipeline addendum"). Pure
stdlib, no external dependencies.

Loads signals.csv (produced by generateSignals.js, using the REAL live
signal engine — see that file for why the signal math is never
reimplemented here) and raw m5 candle data, then simulates the exact
position rules the live bot enforces:
  - max 3 concurrent positions, max 1 per symbol (global, chronological)
  - flat risk % sizing from stopDistance (positionSizing.js's formula)
  - 3-way TP split at 1R/1.5R/2R
  - breakeven-stop move after TP1, trailing-to-TP1 move after TP2
  - exit reasons matching positionMonitor.js's exact state machine

SIMPLIFICATION, documented not hidden: when a single candle's range
contains both an active TP level and the active SL level, this assumes
the SL executes first (the conservative assumption — avoids overstating
performance from an ambiguous same-candle ordering).

Usage: python3 scripts/backtest/simulate.py [--risk-pct 0.0015] [--bankroll 100]
"""
import argparse
import csv
import json
import os
import statistics
from collections import defaultdict

BACKTEST_DATA = os.path.join(os.path.dirname(__file__), '..', '..', 'backtest-data')
BACKTEST_RESULTS = os.path.join(os.path.dirname(__file__), '..', '..', 'backtest-results')


def load_signals():
    path = os.path.join(BACKTEST_DATA, 'signals.csv')
    with open(path) as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r['timestamp'] = int(r['timestamp'])
        r['entryPrice'] = float(r['entryPrice'])
        r['stopDistance'] = float(r['stopDistance'])
        r['slPrice'] = float(r['slPrice'])
    rows.sort(key=lambda r: r['timestamp'])
    return rows


def load_m5(symbol):
    path = os.path.join(BACKTEST_DATA, symbol, 'm5.json')
    with open(path) as f:
        return json.load(f)


def tp_levels(side, entry_price, stop_distance):
    sign = 1 if side == 'Buy' else -1
    return {
        'TP1': entry_price + sign * 1.0 * stop_distance,
        'TP2': entry_price + sign * 1.5 * stop_distance,
        'TP3': entry_price + sign * 2.0 * stop_distance,
    }


def hits(candle, level):
    """Whether this candle's range would have triggered a price level."""
    return candle['l'] <= level <= candle['h']


def simulate_position(signal, m5_candles, bankroll, risk_pct):
    side = signal['side']
    entry_price = signal['entryPrice']
    stop_distance = signal['stopDistance']
    sl_price = signal['slPrice']
    tps = tp_levels(side, entry_price, stop_distance)

    risk_amount = bankroll * risk_pct
    total_qty = risk_amount / stop_distance
    leg_qty = total_qty / 3

    # Candles strictly after entry timestamp, same symbol.
    future = [c for c in m5_candles if c['t'] > signal['timestamp']]

    stage = 'initial'
    remaining_qty = total_qty
    filled_legs = []  # (level, price, qty)
    exit_reason = None
    exit_price = None
    exit_time = None

    for candle in future:
        if stage == 'initial':
            sl_hit = hits(candle, sl_price)
            tp1_hit = hits(candle, tps['TP1'])
            if sl_hit:
                # Ambiguous same-candle order (both SL and TP1 in range) is
                # resolved conservatively: SL first. remaining_qty stays at
                # total_qty (no partial fills yet) — the post-loop block
                # below records it as the FINAL leg at sl_price.
                exit_reason, exit_price, exit_time = 'STOP_LOSS_HIT', sl_price, candle['t']
                break
            if tp1_hit:
                filled_legs.append(('TP1', tps['TP1'], leg_qty))
                remaining_qty -= leg_qty
                stage = 'breakeven'
                sl_price = entry_price  # moved to breakeven

        elif stage == 'breakeven':
            sl_hit = hits(candle, sl_price)
            tp2_hit = hits(candle, tps['TP2'])
            if sl_hit:
                exit_reason, exit_price, exit_time = 'BREAKEVEN_STOP', sl_price, candle['t']
                break
            if tp2_hit:
                filled_legs.append(('TP2', tps['TP2'], leg_qty))
                remaining_qty -= leg_qty
                stage = 'trailing'
                sl_price = tps['TP1']  # trailed to TP1 price

        elif stage == 'trailing':
            sl_hit = hits(candle, sl_price)
            tp3_hit = hits(candle, tps['TP3'])
            if sl_hit:
                exit_reason, exit_price, exit_time = 'TRAILING_STOP_HIT', sl_price, candle['t']
                break
            if tp3_hit:
                filled_legs.append(('TP3', tps['TP3'], remaining_qty))
                exit_reason, exit_price, exit_time = 'TAKE_PROFIT_FINAL', tps['TP3'], candle['t']
                remaining_qty = 0
                break

    if exit_reason is None:
        return None  # still open at end of backtest data — excluded from stats

    if exit_reason != 'TAKE_PROFIT_FINAL' and remaining_qty > 0:
        filled_legs.append(('FINAL', exit_price, remaining_qty))

    sign = 1 if side == 'Buy' else -1
    realized_pnl = sum(sign * (price - entry_price) * qty for _, price, qty in filled_legs)
    r_multiple = realized_pnl / risk_amount if risk_amount > 0 else None

    return {
        'symbol': signal['symbol'], 'side': side, 'band': signal['band'], 'entryTf': signal['entryTf'],
        'entryPrice': entry_price, 'entryTime': signal['timestamp'], 'exitTime': exit_time,
        'finalExitReason': exit_reason, 'realizedPnl': realized_pnl,
        'rMultiple': r_multiple, 'tp1Filled': any(l[0] == 'TP1' for l in filled_legs),
        'tp2Filled': any(l[0] == 'TP2' for l in filled_legs), 'tp3Filled': any(l[0] == 'TP3' for l in filled_legs),
        'accountBalanceBefore': bankroll,
    }


def run(risk_pct, starting_bankroll, max_positions=3):
    signals = load_signals()
    candle_cache = {}
    open_positions = []  # [{symbol, exitTime}] — real interval tracking
    bankroll = starting_bankroll
    trades = []

    # Chronological pass: a signal is only actionable if, AS OF this
    # signal's timestamp, that symbol has no still-open simulated position
    # and we're under the global concurrent-position cap — mirrors
    # cycle.js's runEntryScanCycle checking real exchange state before
    # every entry, not just a static per-signal snapshot.
    for sig in signals:
        now = sig['timestamp']
        # Retire any positions that have since closed as of `now`.
        open_positions = [p for p in open_positions if p['exitTime'] > now]

        symbol = sig['symbol']
        if any(p['symbol'] == symbol for p in open_positions) or len(open_positions) >= max_positions:
            continue
        if symbol not in candle_cache:
            candle_cache[symbol] = load_m5(symbol)

        result = simulate_position(sig, candle_cache[symbol], bankroll, risk_pct)
        if result is None:
            continue  # never resolved within available data — skip, not counted

        bankroll += result['realizedPnl']
        result['accountBalanceAfter'] = bankroll
        trades.append(result)
        open_positions.append({'symbol': symbol, 'exitTime': result['exitTime']})

    return trades, bankroll


def compute_stats(trades, starting_bankroll):
    if not trades:
        return {'totalTrades': 0}

    wins = [t for t in trades if t['realizedPnl'] > 0]
    losses = [t for t in trades if t['realizedPnl'] <= 0]
    r_multiples = [t['rMultiple'] for t in trades if t['rMultiple'] is not None]

    peak = starting_bankroll
    max_dd = 0.0
    consecutive_losses = 0
    max_consecutive_losses = 0
    for t in trades:
        peak = max(peak, t['accountBalanceAfter'])
        dd = (peak - t['accountBalanceAfter']) / peak if peak > 0 else 0
        max_dd = max(max_dd, dd)
        if t['realizedPnl'] <= 0:
            consecutive_losses += 1
            max_consecutive_losses = max(max_consecutive_losses, consecutive_losses)
        else:
            consecutive_losses = 0

    by_band = defaultdict(list)
    by_exit = defaultdict(list)
    for t in trades:
        by_band[t['band']].append(t)
        by_exit[t['finalExitReason']].append(t)

    def band_summary(rows):
        w = [r for r in rows if r['realizedPnl'] > 0]
        return {'count': len(rows), 'winRate': len(w) / len(rows) if rows else 0,
                'netPnl': sum(r['realizedPnl'] for r in rows)}

    return {
        'totalTrades': len(trades),
        'winRate': len(wins) / len(trades),
        'netPnl': sum(t['realizedPnl'] for t in trades),
        'expectancyR': statistics.mean(r_multiples) if r_multiples else None,
        'maxDrawdownPct': max_dd,
        'maxConsecutiveLosses': max_consecutive_losses,
        'finalBankroll': trades[-1]['accountBalanceAfter'],
        'bandBreakdown': {k: band_summary(v) for k, v in by_band.items()},
        'exitBreakdown': {k: {'count': len(v), 'netPnl': sum(r['realizedPnl'] for r in v)} for k, v in by_exit.items()},
        'tp1HitRate': sum(1 for t in trades if t['tp1Filled']) / len(trades),
        'tp2HitRate': sum(1 for t in trades if t['tp2Filled']) / len(trades),
        'tp3HitRate': sum(1 for t in trades if t['tp3Filled']) / len(trades),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--risk-pct', type=float, default=0.0015)
    parser.add_argument('--bankroll', type=float, default=100.0)
    parser.add_argument('--max-positions', type=int, default=3)
    args = parser.parse_args()

    trades, final_bankroll = run(args.risk_pct, args.bankroll, args.max_positions)
    stats = compute_stats(trades, args.bankroll)

    os.makedirs(BACKTEST_RESULTS, exist_ok=True)
    with open(os.path.join(BACKTEST_RESULTS, 'trades.json'), 'w') as f:
        json.dump(trades, f, indent=2)
    with open(os.path.join(BACKTEST_RESULTS, 'stats.json'), 'w') as f:
        json.dump(stats, f, indent=2)

    print(json.dumps(stats, indent=2))


if __name__ == '__main__':
    main()
