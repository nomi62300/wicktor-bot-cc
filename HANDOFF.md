# wicktor-bot-cc — Session Handoff

**Purpose of this document**: a complete, self-contained summary of everything
done in the build session that produced this repo, written so a fresh session
with zero memory of the conversation can pick up exactly where it left off.
Written 2026-08-15.

---

## 1. What this project is

`wicktor-bot-cc` (`github.com/nomi62300/wicktor-bot-cc`) is a 24/7 automated
crypto perpetual-futures trading bot:

- Runs Wicktor's signal methodology (Williams Alligator + Fractals + Awesome
  Oscillator + RSI, Heikin Ashi Alligator with jaw-touch invalidation, a
  Trade Quality Score with Continuation/Exhaustion/Reversal sub-scores).
- Trades on **Bybit's Demo Trading environment** (`api-demo.bybit.com`) —
  synthetic funds, not real capital, explicitly a pre-production step.
- Runs as a single always-on Node.js process on Render (Express server +
  background scan/monitor loop on `setInterval`, not a cron job), serving a
  live dashboard at `/performance`.
- Replaces an earlier GitHub Actions-based bot (`wicktor-bybit-bot`) whose
  source was directly reviewed and found to have several serious, confirmed
  bugs — most importantly, it never actually implemented Williams Alligator
  (only a Jaw line existed; no Teeth/Lips/AO), so it was silently trading a
  different, simpler system under the same name.

The full original project brief (with all "lessons from the previous bot"
findings) lives at `wicktor_bot_cc_brief.md` in this repo. A "Phase 4"
brief update (`wicktor_bot_cc_brief.md`, same file, updated later) added
real Phase 3 live-trading results and four follow-up requirements — see
section 5 below.

**Repo state**: everything described here is committed and pushed to
`main`. `CHANGELOG.md` has a full, linked commit history — read it for the
definitive chronological record; this document is the narrative/context
version.

---

## 2. Architecture

```
wicktor-bot-cc/
  package.json, .env.example, CHANGELOG.md, HANDOFF.md (this file),
  wicktor_bot_cc_brief.md (the full original + Phase 4 brief), render.yaml
  src/
    config.js              # ALL tunables from process.env, no hardcoded values
    server.js               # Express app + starts the trading loop; also serves
                              # the self-hosted lightweight-charts vendor file
    engine/
      indicators.js         # ported verbatim from wicktor-scanner (re-sync noted)
      scoring.js              # ported, with Phase 4 (9b) asymmetry-bug fixes and
                                # (9c) AC-agreement scoring added on top — see §4/§5
      index.js                 # loader shim: sets global.Indicators before
                                  # requiring scoring.js (both files were written as
                                  # browser IIFEs sharing an implicit global; no such
                                  # global exists in Node CommonJS)
    market/
      bybitClient.js         # bybit-api SDK, demoTrading:true
      candles.js               # kline fetch, ALWAYS trims Bybit's still-forming
                                  # current candle (confirmed-closed candles only)
      universe.js               # instruments-info category=linear check (NOT
                                  # string-prefix heuristics) + turnover floor +
                                  # top-N cap (SCAN_UNIVERSE_SIZE, default 60)
      instrumentInfo.js         # per-symbol tick size / qty step / min order qty
      riskLimit.js               # maintenance-margin-rate lookup (for liquidation estimate)
    trading/
      signalScanner.js        # Scoring.evaluate + Continuation-dominance filter +
                                 # MFI Squat/Fake entry-TF filter (9c) -> band/entryTf
      positionSizing.js        # riskAmount/stopDistance, no notional cap, logs every input
      stopLoss.js                # fractal/jaw + ATR floor, directional assertion (throws)
      takeProfits.js              # TP1/1.5R/TP2/2R/TP3 3-way split, qty-representability check
      exitReasons.js               # exit-reason enum + stage state machine
      marginControl.js              # sets leverage; ESTIMATES liquidation price (see §4)
      orderExecution.js              # entry (slippage-bounded IOC limit order) + SL +
                                       # 3xTP; re-verifies real exchange state after every step
      positionMonitor.js              # 30-60s loop: detects fills via real execution data,
                                        # breakeven/trailing SL moves; NO jaw-invalidation
                                        # (removed, Phase 4 9a — see §5)
      positionStore.js                 # in-memory tracked-position map (per Render process)
      cycle.js                          # orchestrates scan+monitor loops, startup
                                          # reconciliation, per-entry try/catch
      journalIntegration.js             # bridges positionMonitor fill callbacks -> tradeJournal
    persistence/
      db.js                # node:sqlite (NOT better-sqlite3 — see §4), schema below
      tradeJournal.js        # trade CRUD + chart-snapshot persistence (9d)
      bankroll.js              # internal virtual bankroll, independent of Bybit's demo equity
    dashboard/
      routes.js                # /performance, /api/stats, /api/positions/live,
                                 # POST /api/positions/:symbol/close (admin-token gated),
                                 # /api/trades, /api/trades.csv, /api/trades/:id/chart
      stats.js                   # win rate, expectancy R, drawdown, per-band/TF/exit/symbol,
                                   # split TP1/TP2/TP3/SL/breakeven hit-rate cards
      public/performance.html      # mobile-responsive dashboard + lightweight-charts UI
    utils/logger.js            # structured JSON console logging
  scripts/backtest/            # offline backtesting pipeline — see §6, NOT part of the
                                 # live bot's runtime
```

### Database schema (`src/persistence/db.js`)
- `trades` — one row per full position lifecycle (open → partial fills →
  close). All fields from brief section 8: symbol, side, band, entry_tf,
  entry_price, stop_distance, total_qty, risk_amount_usdt,
  account_balance_before/after, tp1/tp2/tp3 filled+price+qty+filled_at,
  final_exit_reason, exit_price, realized_pnl_usdt, r_multiple, closed_at,
  status.
- `balance_history` — append-only bankroll ledger.
- `trade_charts` — one row per trade (9d): candles_json/jaw_json/
  teeth_json/lips_json (last ~50 bars, captured at entry, never
  recalculated later) + markers_json (entry/TP-fill/exit events,
  appended live) + sl/tp1/tp2/tp3 price levels.

---

## 3. What's currently working (verified, not just written)

Everything below was live-tested against real Bybit Demo Trading data
during this session, not just unit-tested:

- Universe filter correctly excludes commodities/stocks (XAUUSDT, CLUSDT)
  using Bybit's `symbolType` field — `contractType`/`quoteCoin` alone are
  NOT sufficient (both report `LinearPerpetual`/`USDT` same as real crypto).
- Signal scanning pipeline: Continuation-dominance filter + MFI Squat/Fake
  filter both visibly engage on real scans.
- Full order lifecycle: entry (slippage-bounded limit order) → real-fill-
  price-based SL/TP computation → 3-way TP placement → TP1 fill →
  breakeven move → TP2 fill → trailing move → TP3/final close, all
  confirmed via real Bybit execution data, not assumed.
- Exit-reason state machine: STOP_LOSS_HIT / BREAKEVEN_STOP /
  TRAILING_STOP_HIT / TAKE_PROFIT_FINAL / MANUAL_CLOSE all correctly
  derived from real execution `orderId` matches or Bybit's `stopOrderType`
  field — never inferred from PnL sign.
- Dashboard: stats banner (with split TP1/TP2/TP3/SL/Breakeven hit-rate
  cards), live open-positions panel with manual close (admin-token
  gated), Recent Trades table with per-trade chart visualization
  (candlesticks + Jaw/Teeth/Lips + SL/TP price lines + entry/fill/exit
  markers, via self-hosted `lightweight-charts`), mobile-responsive.
- Deployed and running on Render (free tier — see §4 for the important
  caveats about this).

---

## 4. Real bugs found and fixed during this session (the hard-won lessons)

These were all found through **live production use**, not code review —
this is the most valuable part of this session's work and should not be
re-broken by future changes.

1. **Stop-loss computed from stale decision price, not real fill price.**
   A market order filled ~11% away from the decision-time candle close
   (TUTUSDT) — the computed SL landed on the wrong side of the real entry,
   Bybit rejected it, and the old code just logged the rejection and moved
   on, leaving a position open with **zero protection**. Fixed: `computeStopLoss`
   is now a callback invoked with the actual post-fill price; a hard safety
   net (`closePositionAtMarket`) closes the position immediately if valid
   protection still can't be established.

2. **TP-leg placement failure silently discarded the whole position from
   tracking.** If entry + SL succeeded but a TP leg failed (rate limit,
   rejected price), the old code returned early without registering the
   position — it stayed open and SL-protected on the exchange but invisible
   to `positionStore`, which silently broke the max-3-concurrent-positions
   limit (an untracked position doesn't count against it). Fixed: added a
   `positionStillOpen` flag distinct from `ok` — callers gate tracking on
   `positionStillOpen`, not full success.

3. **Rate-limit bursting.** Firing several full entry sequences back-to-back
   in one scan tick burst past Bybit's API rate limit, causing spurious
   rejections unrelated to the trades themselves. Fixed: retry-with-backoff
   on rate-limited calls (retCode 10006) + a 500ms pacing gap between
   candidates in the same scan tick.

4. **No slippage bound on entries.** Plain Market orders accept unlimited
   slippage. Fixed: entries are now IOC **Limit** orders bounded by
   `MAX_ENTRY_SLIPPAGE_PCT` (default 0.5%) — if price has moved beyond
   tolerance, the order simply doesn't fill, rather than accepting an
   arbitrary gap.

5. **No liquidation-price safety check at all.** Flat-risk sizing from
   stop-distance alone silently breaks if leverage means liquidation
   happens before the stop can fire. **Important environment discovery**:
   Bybit's Demo Trading **rejects margin-mode switching entirely**
   (`retCode 10032 "Demo trading are not supported"`) — this account is
   permanently cross-margin, with no deterministic per-position `liqPrice`
   exposed. Fixed (`marginControl.js`): sets leverage explicitly (this
   part works fine on demo), and computes an ESTIMATED liquidation price
   using the standard isolated-margin formula + Bybit's real maintenance-
   margin-rate data (`getRiskLimit`), requiring the stop to sit at least
   `MIN_LIQUIDATION_BUFFER_MULT` (default 1.5x) further from entry than
   that estimate. This is a documented approximation, not Bybit's
   authoritative cross-margin number (which isn't obtainable in this
   environment).

6. **Reconciliation blindly adopted ANY open position as the bot's own.**
   This Demo account turned out to carry substantial unrelated trading
   activity from **another running system** (the old `wicktor-bybit-bot`,
   confirmed still live on Render — user has since stopped it). Fixed:
   `reconcileOpenPositions` only adopts positions with an identifiable
   3-leg reduce-only TP structure matching this bot's own order pattern;
   anything else is logged and left strictly untouched.

7. **New entries could stack onto a pre-existing (foreign or own) position.**
   The entry-scan loop only checked its own internal tracking, not Bybit's
   real live position state, before entering a symbol. Fixed:
   `hasAnyLivePosition(symbol)` checks the real exchange state first.

8. **A restart orphans the tradeId link.** `positionStore` is in-memory
   only; a position opened just before a restart gets re-adopted by
   reconciliation with no `tradeId`, so its eventual close was silently
   un-journaled. Fixed: `tradeJournal.findMostRecentOpenTrade(symbol)`
   re-links a reconciled position back to its original DB row.

9. **Render free tier has no persistent Disk.** `DB_PATH` originally
   pointed at `/var/data/...` assuming a mounted Disk — crashed with
   `EACCES` on free tier. Fixed: `DB_PATH` now points inside the app's own
   writable directory. **This means the trade journal/bankroll/dashboard
   stats reset on every redeploy** — an accepted, documented tradeoff of
   staying on free tier (user's explicit choice). `render.yaml` documents
   both modes (free-tier-as-configured vs the paid always-on + Disk mode,
   commented out, ready to switch to).

10. **`better-sqlite3`'s native bindings don't build against Node 26**
    (what Homebrew installed). Switched to Node's built-in `node:sqlite`
    module — zero native compilation, works identically for this project's
    needs.

11. **A live incident during this session**: ~5 days elapsed between build
    sessions with the bot running unattended on Render. Found 15 open
    positions, 12 completely unprotected (no SL, no TP), with large losses
    (TUTUSDT -$183, BMTUSDT -$199, MUBARAKUSDT -$124) — orphaned from the
    debugging period before all the above fixes were live. All 12 closed
    with user approval; the bot's own 3 properly-tracked positions were
    left running. **Root cause was NOT a new bug** — these were leftovers
    from the shared-account incident (#6/#7) during active debugging,
    never cleaned up.

12. **Standing operational rule going forward**: never run `src/server.js`
    locally while the Render deployment is also live — doing so once
    created two simultaneous trading loops on the same real account,
    causing an unintended early position close. Local testing against the
    live account should be read-only inspection only, or use a throwaway
    isolated test position that gets manually closed.

---

## 5. Phase 4 changes (brief section 4 + section 9)

Triggered by real Phase 3 results the user supplied
(`wicktor_trades-Phase-3.csv`, independently verified against the brief's
claims): **377 closed trades over 4.5 days, 34.2% win rate, -0.336R
expectancy**, JAW_INVALIDATION the largest exit category (163/377, 43.2%,
mean -0.906R — essentially as bad as a genuine stop-loss), and a real,
reproducible Buy/Sell asymmetry (Sell 37.1% win rate vs Buy 31.4%, exact
match to the brief). This is genuine strategy performance data confirmed
to be from the FIXED code (deploy timestamp for the last major fix commit
matches the ~4.5-day window) — not an artifact of execution bugs.

**All four items were implemented and verified:**

- **Section 4 — universe cap**: top N by turnover, default 60
  (`SCAN_UNIVERSE_SIZE`), matching the old bot's precedent.
- **9a — dropped jaw-invalidation entirely**: removed
  `checkJawInvalidation()` and its whole code path from
  `positionMonitor.js`, removed `JAW_INVALIDATION` from the exit-reason
  enum. Positions now only close via native SL, TP1/TP2/TP3, breakeven,
  trailing. Verified via grep: zero remaining references.
- **9b — fixed three real Buy/Sell asymmetry bugs** in `scoring.js`,
  found via a full manual audit of every bias-dependent comparison:
  1. `buildExhaustion`'s 5M RSI check wasn't gated by bias at all.
  2. `buildExhaustion`'s 1H RSI extreme check only had an overbought
     branch — bearish trades had no oversold mirror.
  3. `tradeQualityScore`'s "healthy RSI zone" was a fixed bullish-centric
     band `(40,75)` applied to both directions — mirrored to `(25,60)`
     for bearish bias. This was the most consequential fix (feeds every
     trade's quality score).
  Verified via a regression test: mirrored synthetic bull/bear inputs
  now produce identical scores (they didn't before).
- **9c — two new entry filters**: MFI Squat/Fake skip filter (checked on
  the **entry TF** — 5M or 15M — not 1H, unlike the existing MFI Green
  bonus), and Accelerator-Oscillator agreement required for full AO
  scoring credit in `buildContinuation`. Verified live: both visibly
  engage on real scans.
- **9d — trade-chart visualization**: `trade_charts` table, snapshot
  captured at entry (real computed Jaw/Teeth/Lips, never recalculated),
  markers appended on every fill, `GET /api/trades/:id/chart` (persisted
  snapshot + freshly-fetched live "what happened after" candles),
  rendered via self-hosted `lightweight-charts` in a dashboard modal.
  Verified end-to-end including visual browser confirmation.

---

## 6. Offline backtesting pipeline (in progress, one known bug)

**Why this exists**: Phase 3's core lesson was that the only way to
validate a strategy change has been "deploy it and wait days." User asked
about several researched repos (see §7); the backtesting pipeline uses
`vectorbt` as the original inspiration but ended up NOT using it directly
(see below).

**Critical design decision, followed throughout**: never reimplement
`indicators.js`/`scoring.js` (or any of the live decision logic) in
Python. A second implementation is a classic backtesting trap — subtle
drift between what's tested and what runs live produces misleading
results, and this project's engine has already had real, hard-to-spot
bugs (the §5 RSI asymmetry findings) that a second port could easily
reintroduce or fail to replicate. Instead: **replay the real Node.js
engine over historical data**, and use Python only for the execution/risk
simulation layer.

**Location**: `scripts/backtest/` (separate from the live bot's runtime
— `backtest-data/` and `backtest-results/` are gitignored, regenerated
per-run).

### Components, in pipeline order

1. **`fetchHistory.js`** (Node) — pages through Bybit kline history via
   the same `bybitClient.js` used live (confirmed: available well over a
   year back via `start`/`end` pagination, 200 candles/request). Hardened
   with retry-with-backoff on network-level throws (a transient DNS blip
   crashed the first 45-symbol attempt entirely — network errors are a
   different failure mode than a valid non-zero `retCode` response, and
   weren't originally caught at all) and per-symbol try/catch so one
   symbol failing doesn't abort the whole batch. Usage:
   `node scripts/backtest/fetchHistory.js SYMBOL1,SYMBOL2 DAYS`

2. **`generateSignals.js`** (Node) — walks forward bar-by-bar through
   cached history, calling the REAL `signalScanner.evaluateSymbol()` (the
   exact function `cycle.js` calls live) at each closed candle, and the
   REAL `stopLoss.computeStopLoss()` for stop-distance/SL price. Outputs
   `backtest-data/signals.csv`. Usage:
   `node scripts/backtest/generateSignals.js SYMBOL1,SYMBOL2`

3. **`simulate.py`** (Python, **pure stdlib, zero dependencies** — decided
   against pandas/vectorbt for the core simulation loop, since vectorbt's
   `Portfolio.from_signals` stop-loss/TP primitives don't cleanly express
   this bot's exact partial-exit + breakeven + trailing sequence; hand-
   rolling it directly mirrors `positionMonitor.js`'s real state machine
   instead). Loads the signals CSV + cached m5 candles, simulates:
   flat-risk sizing from stop distance, max 3 concurrent / 1-per-symbol
   position limits (real interval-based tracking — retires positions
   whose exit time has passed before checking each new candidate), 3-way
   TP split, breakeven-move after TP1, trailing-to-TP1 after TP2.
   **Documented simplification**: when a single candle's range contains
   both an active TP and the active SL, assumes SL executes first
   (conservative). Usage:
   `python3 scripts/backtest/simulate.py --bankroll 10000 --risk-pct 0.0015 --max-positions 3`

   **Two real bugs found and fixed during verification** (not just written
   and trusted):
   - Immediate stop-loss trades zeroed `remaining_qty` *before* the exit
     leg was recorded, so those losses never counted (all showed
     `netPnl: 0.0` exactly — the tell).
   - Position-limit tracking (`open_symbols`/`open_count`) was declared
     but never actually updated in the first draft — replaced with real
     interval-based open-position tracking.

   **Verified correct** (after fixes): every trade's R-multiple matches
   its exact expected value by exit-reason semantics — `STOP_LOSS_HIT` =
   -1.0R exactly, `TAKE_PROFIT_FINAL` = +1.5R (weighted average across
   1R/1.5R/2R legs), `BREAKEVEN_STOP` = +0.333R, `TRAILING_STOP_HIT` =
   +1.167R — against a real 5-day BTCUSDT+ETHUSDT test dataset.

4. **`generateJawInvalidation.js`** (Node) — precomputes the OLD (pre-9a,
   removed from the live bot) `alligatorInvalidated` flag via the real
   `Indicators.analyzeTimeframe()`, purely to attempt reproducing Phase 3
   exactly (Phase 3 ran WITH jaw-invalidation). Wired into `simulate.py`
   behind `--jaw-invalidation`.

### ⚠️ Known unresolved bug — read before trusting any backtest result

Ran the full pipeline against the real Phase 3 universe (45 symbols) and
date range (2026-08-10 to 2026-08-14), with `--jaw-invalidation` to
attempt the planned trust-building sanity check (does the backtest
reproduce the real 34.2% win rate / -0.336R expectancy).

**Result**: trade count matched closely (373 simulated vs 377 real —
good sign for the entry/signal-selection logic). But the overall result
was **inverted**: the simulation showed positive expectancy (+0.29R) vs
real Phase 3's negative (-0.336R). Specifically, simulated
`JAW_INVALIDATION` exits averaged **positive** PnL, while real Phase 3
data shows them averaging **-0.906R**. This is a sign inversion, not a
magnitude gap — a real bug, not a modeling approximation.

**Leading theory, NOT yet confirmed**: the old `alligatorInvalidated`/
touch-state logic in `indicators.js` may be stateful across continuous
history (e.g. tracking "touched but not yet reclaimed" over many bars).
`generateJawInvalidation.js` recomputes it fresh on a sliding 150-bar
window at every step rather than a continuously-running calculation —
this could produce systematically wrong invalidation timing. **This
needs real debugging into `indicators.js`'s internals** (specifically
whatever computes `alligatorInvalidated`/touch-state) to confirm and fix.

**What IS trustworthy**: everything except the jaw-invalidation piece.
`fetchHistory.js`, `generateSignals.js`, and `simulate.py`'s core
SL/TP/breakeven/trailing simulation are independently verified correct
(see the R-multiple exact-match check above, which doesn't involve jaw
logic at all). A backtest run WITHOUT `--jaw-invalidation` (i.e.
simulating post-Phase-4 behavior, since jaw-invalidation is now removed
from the live bot anyway) is likely fine to trust — it's only the
Phase-3-reproduction path (`--jaw-invalidation` flag) that has the bug.

**Suggested next step**: read `indicators.js`'s Alligator touch/
invalidation logic carefully, understand exactly what state (if any) it
carries across calls, and either (a) fix `generateJawInvalidation.js` to
correctly replicate that state across its walk-forward loop, or (b) if
the live bot's `analyzeTimeframe()` truly is stateless per-call (state
only via what's present in the candle window itself), look elsewhere —
possibly the exit price/timing logic in `simulate.py`'s jaw-invalidation
branch, or a bug in how `is_invalidated_at()` looks up the flag for a
given query time.

---

## 7. Related repo research (informational, no code changes)

User asked about 8 repos for general trading-bot relevance:
`awesome-ai-in-finance`, `FinRL`/`FinRL-Trading`/`FinRL_Crypto`,
`hummingbot`, the string "VectoBot" (turned out to be an unrelated Go
Telegram-bot repo — user actually meant `vectorbt`), `ccxt`, `OctoBot`.

**Verdict given**: none were a direct drop-in fit for this bot (different
paradigm — RL frameworks; or full competing platforms — hummingbot/
OctoBot; or just a link list). `ccxt` is relevant only if multi-exchange
support becomes a real goal. `vectorbt` was the one genuinely useful
find, leading to the backtesting pipeline in §6 (though ultimately used
only as inspiration — the actual simulation is hand-rolled, see §6.3).

**Also produced**: a generic "Brief: General-Purpose Profitable Crypto
Trading Bot" handoff document (given to the user as chat text, not saved
to this repo) distilling the §4 lessons into a strategy-agnostic
engineering checklist, for a separate/different bot project the user is
building in another chat. Worth regenerating from §4 above if needed
again — the content maps directly.

---

## 8. Operational notes / standing instructions

- **`CHANGELOG.md` must be updated in the same commit as any substantive
  change**, per the user's explicit standing instruction (saved to
  Claude's persistent memory). Format: newest-first, dated sections,
  bullet per commit with a linked short hash and a one-paragraph
  "why + what" summary in the established voice — see the file for
  examples.
- **`.env` is git-ignored and never committed.** It's frequently absent
  at the start of a fresh session (deliberately deleted after testing, or
  simply not carried over) — ask the user to re-add
  `BYBIT_DEMO_API_KEY`/`BYBIT_DEMO_API_SECRET` (real Demo Trading
  credentials, not mainnet) before any live-testing work. Public/market-
  data endpoints (klines, tickers, instruments-info) work fine with
  placeholder credentials; anything touching orders/positions/account
  needs the real ones.
- **Never run `src/server.js` locally while Render is also live** (§4,
  item 12) — real risk of duplicate trading loops on the same account.
- **Render deployment does not auto-redeploy on git push** (confirmed:
  this was the root cause of running stale code for days at one point).
  Always explicitly remind the user to trigger a redeploy after pushing
  a fix intended to go live.
- **This account's demo trade journal resets on every Render redeploy**
  (free tier, no persistent Disk — §4 item 9). This is known and
  accepted, not a bug to fix unless the user decides to move to the paid
  tier.
- Repo remote: `https://github.com/nomi62300/wicktor-bot-cc.git`, pushed
  via `gh` CLI auth (not embedded PATs — separate standing instruction
  in memory, applies repo-wide to this user).

---

## 9. Immediate next steps (pick one)

1. **Debug the jaw-invalidation replication bug** (§6, the known issue) —
   needed before the backtesting pipeline can be trusted for Phase-3-
   equivalent (pre-9a) comparisons. Not required for post-Phase-4
   parameter sweeps, which don't involve jaw-invalidation at all.
2. **Run backtests without `--jaw-invalidation`** to start getting
   (probably trustworthy) forward-looking signal on Phase 4's changes
   against historical data, while the jaw-invalidation bug is separately
   investigated.
3. **Monitor the live Phase 4 deployment** on Render (assuming it's been
   redeployed with all the §5 changes) and gather a new real trade sample
   to compare against Phase 3.
4. Nothing currently blocking — all code is committed, pushed, and the
   working tree is clean of test artifacts (`.env`, `backtest-data/`,
   `backtest-results/` all cleaned up after each test run this session).
