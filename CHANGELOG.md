# Changelog

All notable changes to this project are logged here, newest first.
Each entry links the commit that made the change.

## 2026-08-15 — Offline backtesting pipeline (in progress)

Prompted by Phase 3's core lesson: the only way to validate a strategy
change has been "deploy it and wait days." Building a separate offline
pipeline that replays the REAL live signal engine over historical data
rather than reimplementing it — avoids the classic backtesting trap of
signal-logic drift between what's tested and what actually runs live.

- **[`955dda3`](../../commit/955dda3)** `simulate.py` — pure-stdlib
  execution/risk simulation (no vectorbt/pandas; its stop-loss/TP
  primitives don't fit our exact partial-exit + breakeven + trailing
  sequence, so this hand-rolls the same state machine
  `positionMonitor.js` uses live). Found and fixed two real bugs during
  verification: stop-loss trades weren't counting their loss at all
  (netPnl exactly 0.0 was the tell), and position-limit tracking was
  declared but never updated. Verified every trade's R-multiple matches
  its exact expected value by exit-reason semantics.
- **[`4b83794`](../../commit/4b83794)** `fetchHistory.js` (paginated
  Bybit kline cache, verified exact candle counts) and `generateSignals.js`
  (replays the real `signalScanner.evaluateSymbol()` bar-by-bar over
  cached history, outputs a decisions CSV; later extended to include
  stop-loss data via the real `computeStopLoss()`).

## 2026-08-14 — Phase 4 (brief section 4 + section 9)

Prompted by real Phase 3 results (377 closed trades over 4.5 days, verified
against the owner's trade log): 34.2% win rate, -0.336R expectancy,
JAW_INVALIDATION the largest exit category performing no better than a
genuine stop-loss, and a real Buy/Sell asymmetry (Sell 37.1% vs Buy 31.4%
win rate).

- **[`0852f33`](../../commit/0852f33)** Per-trade chart visualization (brief
  9d): persists candles + live-computed Jaw/Teeth/Lips + entry/TP/exit
  markers per trade, `GET /api/trades/:id/chart`, rendered via
  `lightweight-charts` in a new "Recent Trades" dashboard panel.
- **[`89696af`](../../commit/89696af)** MFI Squat/Fake entry-TF skip filter
  + Accelerator Oscillator agreement requirement for full Continuation
  credit (brief 9c).
- **[`6881d40`](../../commit/6881d40)** Fixed three Buy/Sell RSI-threshold
  asymmetry bugs in `scoring.js` found via full audit (brief 9b) — verified
  symmetric via a mirrored-input regression test.
- **[`1b2aac7`](../../commit/1b2aac7)** Removed the jaw-invalidation exit
  path entirely (brief 9a) — Phase 3 data showed it wasn't earning its
  keep over the native stop-loss.
- **[`651c8ca`](../../commit/651c8ca)** Capped scan universe to top N by
  turnover, default 60 (brief section 4).

Also: found and closed 12 unprotected orphaned positions left over from
the earlier debugging session, and discovered the account had been
running the *original pre-fix* code the whole time (no redeploy had
happened since the very first deploy) — resolved by confirming the deploy
timestamp and prompting a fresh redeploy.

## 2026-08-09 — Post-launch hardening (same-day production findings)

- **[`4ecbe59`](../../commit/4ecbe59)** Entries are now slippage-bounded
  IOC limit orders, not Market orders; added an estimated liquidation-
  buffer safety check (discovered Bybit Demo Trading doesn't support
  isolated margin at all).
- **[`75c3cb7`](../../commit/75c3cb7)** Fixed: a failed TP leg was leaving
  live, SL-protected positions completely untracked, silently breaking the
  max-3-concurrent-positions limit. Added rate-limit retry + pacing.
- **[`af34dc5`](../../commit/af34dc5)** Split the combined TP1/TP2/TP3 hit
  rate into 5 separate dashboard cards (TP1/TP2/TP3/SL/Breakeven), each
  showing count + rate.
- **[`80f3d3a`](../../commit/80f3d3a)** Added a live open-positions panel
  with manual close (admin-token guarded), made the dashboard mobile-
  responsive.
- **[`b029825`](../../commit/b029825)** Critical fix: stop-loss/take-profit
  were computed from the pre-trade decision price instead of the real
  fill price — a market order filling ~11% away from decision price
  (TUTUSDT) left a position open with zero protection.
- **[`f41f666`](../../commit/f41f666)** Fixed a Render free-tier `EACCES`
  crash (DB_PATH assumed a persistent Disk that isn't available without
  the paid tier); documented both deployment modes and their tradeoffs.

## 2026-08-09 — Initial build (M1–M6)

- **[`bc3b60c`](../../commit/bc3b60c)** M6: server wiring, Render deploy
  config, restart-continuity fixes (re-linking reconciled positions back
  to their journal rows).
- **[`6f5b985`](../../commit/6f5b985)** M5: SQLite trade journal + bankroll
  tracking, `/performance` dashboard with expectancy/drawdown/hit-rate
  breakdowns.
- **[`848d9f7`](../../commit/848d9f7)** M4: position monitor, exit-reason
  state machine, cycle orchestration — found and fixed two live issues
  (reconciliation blindly adopting foreign positions; entries stacking
  onto pre-existing positions on a shared demo account).
- **[`a06636d`](../../commit/a06636d)** M3: position sizing, stop-loss,
  take-profits, order execution — live-tested end-to-end on Bybit Demo
  Trading.
- **[`d736d28`](../../commit/d736d28)** M2: signal scanning pipeline
  (dry-run); fixed the universe filter after discovering `contractType`/
  `quoteCoin` alone don't distinguish crypto from commodities on Bybit.
- **[`f1f562e`](../../commit/f1f562e)** M1: scaffold, config, ported
  engine (`indicators.js`/`scoring.js` from `wicktor-scanner`), Bybit
  client, universe filter.
- **[`8c08a0d`](../../commit/8c08a0d)** Initial commit: repo scaffold.
