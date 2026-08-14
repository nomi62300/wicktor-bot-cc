# wicktor-bot-cc — Project Brief for Claude Code

New repo, new project, replacing the earlier `wicktor-bot` (GitHub Actions-based)
design. This bot is intended to eventually trade real capital — correctness and
honest verification matter more here than in any other part of this project.
Read the "Lessons from the previous bot" section before writing any execution
code — every item there is a confirmed, evidence-based bug from real trade logs,
not a hypothetical concern.

---

## 1. What this is

A 24/7 automated trading bot that:
- Pulls market data and runs the same indicator/scoring engine as the
  `wicktor-scanner` project (Alligator/Fractals/AO/RSI, Heikin Ashi Alligator
  with jaw-touch invalidation, Trade Quality Score with Continuation/
  Exhaustion/Reversal breakdown).
- Places real orders on **Bybit's Demo Trading environment** (`api-demo.bybit.com`,
  separate API key generated from the Demo Trading account view — not the
  regular mainnet API). Still demo, not live capital, for now — this is
  explicitly a pre-production step before the owner trusts it with real funds.
- Runs continuously as a **persistent Render web service** (not a scheduled
  cron job — see section 6), serving a live performance dashboard at
  `your-project.onrender.com/performance`.

## 2. Signal source and the corrected alignment logic (CRITICAL — read first)

Copy `indicators.js`, `scoring.js`, and the Bybit-fetching parts of `api.js`
from the `wicktor-scanner` repo (`github.com/nomi62300/wicktor-scanner`),
same "manual copy with a re-sync comment" pattern as the original bot design.
**But apply the corrected alignment/bias logic directly in this copy**,
whether or not the scanner repo itself has been updated yet by the time this
is built:

### Corrected bias/band logic (do not use majority-vote bias — confirmed wrong)

1. **1H alone sets the bias.** Not a vote across three TFs. 1H's Alligator
   direction (bullish `lips>teeth>jaw`, bearish `lips<teeth<jaw`, or sleeping)
   IS the bias.
2. **1H sleeping → no trade.** Bias = 0, band = AVOID, regardless of 15M/5M.
3. **15M is a hard gate, not an independent vote.** 15M "confirms" 1H (same
   direction) or "does not confirm" (opposite OR sleeping — treated
   identically). If 15M does not confirm → AVOID, regardless of what 5M shows.
4. **Only once 15M confirms does 5M decide EXCELLENT vs WATCH.** 5M confirms
   → EXCELLENT. 5M does not confirm (opposite or sleeping) → WATCH.

Truth table:

| 1H | 15M vs 1H | 5M vs 1H | Band ceiling |
|---|---|---|---|
| Sleeping | — | — | AVOID |
| Directional | Confirms | Confirms | EXCELLENT |
| Directional | Confirms | Does not confirm | WATCH |
| Directional | Does not confirm | *(anything)* | AVOID |

This band ceiling caps the existing numeric Trade Quality Score's threshold-
based band downward (same pattern as the unlock-risk override) — the ceiling
can never push the band *up*, only cap it down.

### This table directly determines entry timeframe — no separate logic needed

**The WATCH case (15M confirms, 5M doesn't) IS the "5M is invalid, trade the
15M entry instead" rule.** Don't implement entry-TF selection as a separate
mechanism — it falls directly out of computing the band. EXCELLENT → enter on
5M. WATCH → enter on 15M. AVOID → no trade. This is a nice simplification:
one computation drives both the band shown and the entry timeframe used.

### Which bands to trade

Trade **EXCELLENT and WATCH**, same as originally established. **Continuation
must be the dominant of the three CONT/EXH/REV sub-scores** (strictly greater
than both Exhaustion and Reversal) — this was a deliberate refinement from
earlier discussion to ensure genuine trend-following, not a band reached
through mixed/conflicting factors.

## 3. Risk management (simplified — confirmed, no escalation)

- **Flat 0.15% risk per trade.** No martingale-style escalation after losses
  — an earlier design with escalating risk tiers (0.15%→0.35%→0.70%→1.5%
  after consecutive stop-losses) was deliberately dropped after discussion:
  at the kind of stop-loss rate real trading produces, hitting 4 consecutive
  losses is a regular occurrence (not a rare tail event), and escalating risk
  into a losing streak is a known, real risk-of-ruin pattern. Flat sizing is
  the safer, chosen design.
- Risk is defined by stop-loss distance, not by leverage — leverage affects
  margin usage only, never increases risk-per-trade (same principle as
  before).
- **Three take-profit levels: TP1 @ 1R, TP2 @ 1.5R, TP3 @ 2R.** Position
  split evenly across all three (33.3% each) — **confirmed**.
- **After TP1 (1R) fills: move stop-loss to breakeven** on the remaining
  position — **confirmed**.
- **After TP2 (1.5R) fills: trail the stop up to the TP1 price** (1R) on the
  final third, so the last runner is never risking back below a locked-in 1R
  profit — **confirmed**.
- **Stop-loss**: last opposing fractal / jaw line (whichever tighter), with
  an ATR-based floor so stops are never unrealistically tight — same design
  as before.
- **Leverage: 5x** (carried over from the original bot spec — flag if this
  should change; not re-confirmed explicitly in this round, treated as
  unchanged default). Affects margin usage only, never risk-per-trade.

## 3a. Configuration — no hardcoded values

**Virtual bankroll**: read from `process.env.INTENDED_ACCOUNT_SIZE_USDT` at
startup, never hardcoded — same principle already established for the
scanner project (adjustable per-deployment without touching code). Setup:

1. Render Dashboard → the web service (e.g. `wicktor-bybit-bot-eu`) →
   Environment → Add Environment Variable
2. Key: `INTENDED_ACCOUNT_SIZE_USDT`, Value: `100` (or whatever capital base
   should be risked against)
3. Save — takes effect on next deploy/restart, no code changes needed to
   adjust later.

Bybit demo API credentials (`BYBIT_DEMO_API_KEY` / `BYBIT_DEMO_API_SECRET`)
follow the same pattern — Render environment variables, never committed to
the repo.

## 3b. Dashboard access & risk controls (confirmed)

- **`/performance` is public, no authentication** — acceptable since it's
  demo data only. Revisit before this bot ever handles real capital.
- **No automatic drawdown circuit breaker** — per-trade risk limits (flat
  0.15%, max 3 concurrent positions) are the intended safety mechanism,
  kept deliberately simple rather than adding an auto-pause system on top.

## 4. Position management

- **Universe size: 60 symbols** (top 60 by 24h volume, PERP category), read
  from `process.env.SCAN_UNIVERSE_SIZE` (default `60` if unset) — same
  "configurable via Render environment variable, never hardcoded" pattern as
  the bankroll (section 3a). This was never explicitly specified in an
  earlier draft of this brief — worth being explicit now: the scanner UI's
  default of 30 exists purely to keep a human's card grid glanceable, which
  is irrelevant to a backend bot. A bot has no reason to scan fewer coins
  than necessary — a larger universe simply means more chances to find
  genuinely qualifying signals each cycle. 60 also matches established
  precedent from both the original bot spec and the old bot's actual working
  code (`getTop60Symbols`), so this isn't a new number, just one that needed
  to be carried forward explicitly into this brief.
- **Max 1 open position per symbol** (no stacking/pyramiding the same coin).
- **Max 3 concurrent positions total, across up to 3 different symbols.**
- PERP only (as before).
- Respects the scanner's max-age freshness cutoff — don't act on stale
  signals; the bot maintains its own discovery-timestamp tracking since it
  has no browser localStorage to read from.
- Entry only on a confirmed candle close of whichever TF the band ceiling
  selected (5M or 15M, per section 2) — never mid-candle.

## 5. Lessons from the previous bot — confirmed by reading the actual source code

The old bot's repo (`wicktor-bybit-bot`) was reviewed directly — `bot.js` and
`engine/{api,indicators,scoring}.js` in full. These are precise, code-confirmed
findings, not hypotheses reconstructed from trade logs.

### 5a. URGENT — credential exposure (already flagged separately, repeating for the record)

The old repo's `.env.example` file — which by its own comments says "copy to
`.env`, never commit `.env`" — contained real, live Bybit Demo API credentials
committed directly to the public repo, not placeholder text. Credentials have
presumably been rotated already. **For this build**: never put real-looking
values in any example/template file, even ones intended as documentation —
use obviously-fake placeholder strings (`your_key_here`) so a copy-paste
mistake can't leak anything real. `bot.js` itself correctly read credentials
from `process.env` — the leak was specifically the example file, not the
application code.

### 5b. The most important finding: the old engine never implemented Williams Alligator properly

`engine/indicators.js` only ever calculates the **Jaw** line (13-period SMMA).
**Teeth and Lips do not exist anywhere in the codebase.** This cascades into
the whole signal engine being fundamentally different from Wicktor's actual
methodology, not just buggy:
- Trend direction came from `_haDirection()` — literally just counting
  whether 2 of the last 3 Heikin Ashi candles share a color. Not lips>teeth>jaw
  ordering (can't be, those lines don't exist).
- The "1H trend alignment guard" only checked price against the 1H Jaw line,
  not proper 1H Alligator ordering — cannot be the corrected Priority 0 logic.
- **Awesome Oscillator does not exist anywhere in the file.** Continuation
  scoring never used it.
- Reversal scoring used Williams %R zone-crossing — an indicator that was
  never part of Wicktor's design — instead of RSI divergence.
- No jaw-touch-invalidation state machine (the HA-based touch/reclaim logic
  from Priority 0/section 2 of this brief) — no equivalent concept existed.

**Conclusion: this bot was never actually trading Wicktor's real methodology.**
It ran a different, simpler system sharing some vocabulary (Jaw, Continuation/
Exhaustion/Reversal band names) but substantially different underlying math.
**Do not attempt to patch this engine forward — replace it wholesale** with
the real `indicators.js`/`scoring.js` from `wicktor-scanner`, with the
Priority 0 alignment fix applied directly, exactly as section 2 already
specifies. This finding just confirms that instruction is load-bearing, not
optional.

### 5c. Exit reason is reconstructed from PnL sign after the fact, in TWO separate places — confirmed root cause of unreliable R-multiple data

In `executeExit()`, the function receives a real, correct `reason` parameter
describing *why* the exit is happening (e.g. jaw invalidation) — but for
journal logging, that real reason is discarded:
```js
let loggedReason = pnl > 0 ? 'BREAKEVEN_SL_HIT' : 'STOP_LOSS_HIT';
if (reason === 'TP2') loggedReason = 'TAKE_PROFIT_HIT';
```
A losing jaw-invalidation exit gets logged as `STOP_LOSS_HIT` even though no
stop-loss was touched. Separately, `syncClosedTradesFromBybit()` reconstructs
exit reason from Bybit's raw closed-PnL feed using a similar PnL-sign +
price-move-percentage guess, since Bybit's API doesn't expose a semantic
close-reason field. **This is the confirmed root cause of the wide,
inconsistent R-multiple distributions found across all three earlier trade
logs** — the labels were never derived from real execution state.

**Requirement for this build**: exit reason must be set from the bot's own
internal state machine at the exact moment a close is detected/executed
(TP1 fill → `PARTIAL_TP1`, TP2 fill → `PARTIAL_TP2`, TP3/final fill →
`TAKE_PROFIT_FINAL`, breakeven-stop triggered → `BREAKEVEN_STOP`,
jaw-invalidation-triggered close → `JAW_INVALIDATION`, genuine stop-loss
price hit → `STOP_LOSS_HIT`) — never inferred afterward from PnL sign or
price-move magnitude, from either the bot's own close handler or any
reconciliation pass against Bybit's raw API.

### 5d. The jaw-invalidation exit path can realize worse losses than the stop-loss itself

The native Bybit stop-loss (attached to the entry order) fires at a fixed,
pre-committed price via Bybit's own order engine. The jaw-invalidation exit,
by contrast, closes at whatever the **live price is when the bot's
monitoring loop next runs** — and that loop only ran every 3 minutes in the
old bot. If price gaps meaningfully between checks, the invalidation exit
realizes the loss at wherever price has moved to by the time it's detected,
not at any pre-committed level — potentially far worse than the stop-loss
would have been. This is a strong candidate for explaining the true outlier
losses found in earlier trade logs (a single -$38 loss on an intended
$0.15-$0.50 risk unit), better than anything visible in the CSVs alone.

**Requirement for this build**: separate the monitoring cadence for *open
positions* (should be as tight as reasonably possible — every 30-60 seconds,
not every 3 minutes, since a persistent Render service has no cron-interval
floor) from the cadence for *scanning for new entries* (can stay coarser,
tied to candle closes). The tighter the gap between "invalidation actually
occurs" and "bot detects and acts on it," the smaller this risk.

### 5e. Position sizing — real but narrower and more specific than earlier analysis suggested

```js
const riskAmountUSDT = ACCOUNT_SIZE_USDT * 0.0015;
const maxNotionalCapUSDT = ACCOUNT_SIZE_USDT * 0.12;  // fixed notional cap
const minSlPct = 0.006;                                // stop-distance floor
```
The core risk-based sizing formula is mathematically correct when uncapped
(`qty = riskAmount / stopDistance`, just reformulated through percentages).
But whenever the actual stop distance is tighter than roughly 1.25% of
price, the fixed notional cap silently reduces realized risk below the
intended amount — down to as little as half of target in the tightest
cases. Real, but a bounded inconsistency, not the wild variance earlier
analysis (working only from trade-log evidence) suspected — the true
worst-case outliers are much better explained by 5d.

**Requirement for this build**: derive position size directly and
consistently from `riskAmount / stopDistance` with no percentage-based
reformulation, and no notional cap that silently changes realized risk while
still being labeled as a fixed risk percentage. If a maximum-position-value
safety cap is wanted for other reasons (e.g. avoiding an oversized position
on a low-price, high-volatility coin), implement it as an explicit,
separately-logged decision to **skip or reduce** the trade with a clear
message — never one that silently ships a smaller realized risk under the
same "0.15%" label.

### 5f. What was genuinely good in the old bot — worth carrying forward as-is

- Bybit client correctly configured for Demo Trading (`demoTrading: true` in
  the SDK config) — this specific concern from earlier discussion is resolved.
- API credentials correctly read from `process.env` in application code (the
  leak in 5a was specifically the example file, not `bot.js` itself).
- Explicit directional SL/TP safety assertions before every order submission
  (`if (slPrice >= entryPrice) throw ...` for Buy, mirrored for Sell) — exactly
  matches what was recommended after the earlier BSBUSDT rejection incident.
  Keep this pattern.
- `roundQty()` rounds down, never up — correct.
- Each scan-cycle phase (sync, monitor positions, scan for entries) wrapped
  in its own try/catch so one failing phase doesn't kill the whole cycle.
- An `isCycleRunning` guard prevents overlapping cycles from a slow run.
- Startup reconciliation against Bybit's actual live position state
  (`syncLivePositions()`) before the first scan cycle begins — don't start
  scanning blind after a restart.
- Non-crypto contract filtering by symbol prefix (`XAU`, `CL`, `OIL`, etc.)
  and a 24h turnover floor (`$15,000,000`) were already added — confirms
  those specific earlier fixes did land correctly. The prefix-matching
  approach is still fragile (string heuristic, not true instrument-category
  verification) — worth the more robust `instruments-info` category check
  in this build, but the intent was correctly implemented.

### 5g. Undefined-variable crash silently skips remaining queued signals for the whole cycle

Confirmed via live Render logs from the old bot: `scanForEntries error:
{"error":"riskAmount is not defined"}`. Root cause, found in `enterPosition()`:
the variable actually declared is `riskAmountUSDT` (`const riskAmountUSDT =
ACCOUNT_SIZE_USDT * 0.0015;`), but a later log call references `riskAmount`
— a name that was never declared in scope:
```js
risk: `$${riskAmount.toFixed(4)}`,   // ReferenceError — should be riskAmountUSDT
```

**The impact is worse than a broken log line.** This throw happens *after*
the order has already been placed and the position already added to
tracking — so the trade itself goes through fine. But because there's no
try/catch around the individual `enterPosition()` call inside
`scanForEntries()`'s loop (only the outer cycle-level catch exists), **the
entire loop aborts at that point** — every other qualified signal still
queued in that cycle silently never gets entered, not delayed to next cycle,
just skipped with no error logged for them specifically. In practice this
capped the old bot at roughly one new entry per scan cycle regardless of how
many genuinely qualified signals were found.

**Requirement for this build**: two separate fixes, not one —
1. Obviously, no undefined-variable references (this specific class of bug
   should be caught by running with a linter or `--strict` mode during
   development, not discovered via production logs).
2. **Structurally more important**: wrap each individual entry-attempt
   inside the qualified-signals loop in its own try/catch, so one bad entry
   (from this bug, an exchange rejection, or anything else) can never
   silently swallow the rest of that cycle's queued signals. The outer
   per-cycle catch (section 5f) is not a substitute for this — it only
   prevents the whole *process* from crashing, it doesn't prevent one bad
   iteration from aborting the rest of the same loop.

---

## 6. Hosting — Render persistent web service (architecture change from the earlier GitHub Actions bot)

The live `/performance` dashboard requirement means this **cannot** be a
stateless scheduled cron job (GitHub Actions, as the earlier bot used) —
there's no persistent process to serve a webpage from between runs. This
needs:

- A real always-on **Render Web Service** (Node/Express or similar), not a
  Background Worker or free-tier sleeping service.
- **Honest cost note, consistent with earlier research in this project**:
  Render's genuinely free tier is for services that sleep after 15 minutes
  of inactivity — fine for occasional dashboard checks, wrong for a bot that
  needs to be continuously scanning and managing open positions. A real
  always-on service starts around $7/month. The free-tier-plus-external-
  keepalive-pinger workaround (a free cron service like cron-job.org hitting
  a health endpoint every ~10 min) can keep a free service from sleeping,
  but isn't something to trust for anything beyond further testing — budget
  for the real always-on tier before this bot manages anything beyond demo
  funds.
- Internal architecture: one Node process running both (a) an HTTP server
  for the `/performance` route and any API endpoints the dashboard needs,
  and (b) a background scan/trade loop on an interval timer (not a separate
  cron — this is one continuously-running process, which is exactly what a
  persistent web service enables that the old cron-based design couldn't).
- State/trade history persistence: given this is a real persistent server
  (not ephemeral like GitHub Actions runs were), a simple embedded database
  (SQLite) or even a well-structured JSON file on a persistent disk is fine
  — no need for the "commit state.json back to git" workaround the old
  cron-based bot needed.

## 7. Performance dashboard (`/performance` route)

Reference: the owner's screenshot of the old bot's dashboard (Capital Base/
Stats banner, Total Trades/Win Rate/Win-Loss-Net PnL, Quality Band Breakdown
table, Timeframe Breakdown table, Exit Distribution table, CSV export
button) — good structure, keep it, but add the following, since raw win rate
alone is misleading (the old bot's own data shows why: 38.4% win rate was
still net-positive because average win size beat average loss size — that
relationship deserves its own visible metric, not just inferred from two
separate dollar totals):

- **Expectancy (average R-multiple per trade)** and **avg-win/avg-loss
  dollar ratio** — surfaced directly, not something the viewer has to
  compute by hand from the win$/loss$ totals.
- **Max consecutive losses** and **max drawdown %** — track and display.
- **Per-TP hit-rate breakdown** (how often TP1 vs TP2 vs TP3 is actually
  reached) — the natural replacement for the old "RRMS tier breakdown" idea
  now that risk is flat, and directly useful for judging whether the
  1R/1.5R/2R target spacing is well-calibrated.
- **Per-symbol breakdown** — win rate and net PnL by symbol, to catch one
  volatile or illiquid coin dragging results.
- Keep the CSV export — same "download the full trade journal" pattern as
  before, still valuable for offline analysis.

### 7a. Per-trade chart visualization (not a literal screenshot)

Neither Bybit nor TradingView offers a clean on-demand screenshot API for
this — the better approach is to store what's needed to render the chart
ourselves and draw it client-side in the dashboard using **`lightweight-charts`**
(TradingView's own free, open-source charting library — npm package
`lightweight-charts`), rendered when a user clicks into a specific trade's
detail row.

For each trade, persist:
- The relevant candle window: ~30-50 bars before entry (showing the setup
  forming) through the close, **plus a handful of bars after the final exit**
  — this is deliberately included so a jaw-invalidation exit's chart shows
  what price actually did afterward, turning every such trade into real,
  reviewable evidence for whether the invalidation call was correct, rather
  than something that has to be separately reconstructed later. Directly
  useful for revisiting the "should jaw-invalidation be kept as-is, made
  less sensitive, or dropped" question with actual data once enough trades
  have accumulated (deferred per current decision — see section 2/5).
- The bot's own actual computed Jaw/Teeth/Lips values at the time, captured
  live at computation time — not recalculated after the fact — so the
  rendered chart shows exactly what the bot saw when it made the decision.
- Markers for entry price/time, SL price, TP1/TP2/TP3 fill prices and
  times, and the final exit price/time/reason.

Store this as a JSON blob associated with the trade's id (a field in the
SQLite record, or a companion table) — this is genuinely more useful than a
static image would be: interactive, zoomable, and shows the bot's actual
internal reasoning rather than a generic price chart.

## 8. Trade journal fields

At minimum, capture everything the old CSV had (timestamp, symbol, side,
quality band, timeframe, entry price, exit price, exit reason, realized
PnL, R-multiple) — **and fix the exit-reason labeling issue from the old
bot**: distinguish genuine initial-stop-loss hits from breakeven-stop hits
and trailing-stop hits as clearly separate exit reasons (the old bot's first
log conflated these, which was part of what made its R-multiple data
uninterpretable). Also add: which TP level(s) filled before final close (for
partial-exit trades), and the account balance immediately before and after
each trade (supports the max-drawdown calculation in section 7).

## 9. Phase 4 changes — post-Phase-3 findings (bot is live, redeploy is now safe)

Phase 3 completed: 377 closed trades over 4.5 days. Execution mechanics
(position sizing, exit-reason labeling, band/TF correspondence) all
confirmed flawless and stable throughout. The trading result itself was
decisively negative — win rate 34.2% vs. a 52.2% breakeven requirement,
non-overlapping 95% confidence intervals, expectancy -0.336R, stable across
three chronological thirds of the test window (not a bad-luck stretch).
JAW_INVALIDATION was the largest single exit category (43.2%) with a mean R
(-0.91) nearly identical to genuine STOP_LOSS_HIT (-0.94) — both bands
(EXCELLENT and WATCH) were negative and roughly proportionally so, and this
pattern held stable across the whole window, which points at entry quality
being weak more than any single exit mechanism.

Given this, four changes for the next phase:

### 9a. Drop jaw-invalidation entirely

Remove the jaw-touch invalidation exit path completely. Positions now only
close via: hard stop-loss, TP1/TP2/TP3 fills, the breakeven-stop move after
TP1, and the trailing-stop move to TP1 price after TP2. No early exit on
Alligator line disorder/jaw-touch.

**Note for whoever implements this**: this removes a whole exit code path
(`alligatorTouchState`-driven closes), not just a config flag — audit for
any other logic that assumed invalidation could fire (position tracking
states, exit-reason enums, dashboard breakdowns referencing
`JAW_INVALIDATION`) so nothing is left half-wired to a removed feature.

### 9b. Audit Buy vs. Sell for a hidden asymmetry

Sell trades meaningfully outperformed Buy trades in both Phase 1 (28.6% vs
18.8% win rate) and Phase 3 (37.1% vs 31.4%) — a persistent gap across two
independent samples. Given this codebase's history includes two other
direction-related bugs (a backwards stop-loss price on a Buy order caught by
a Bybit API rejection, and a PnL-sign-guessed exit reason), this asymmetry
deserves real scrutiny rather than being attributed to "the market's been
bearish." Explicitly verify the Buy-side and Sell-side entry/scoring logic
are true mirror images of each other in `scoring.js` — check every
direction-dependent comparison (`>` vs `<`, `above` vs `below`) has its
correct mirrored counterpart, not just that both sides produce *a* result.

### 9c. Add two cheap entry-quality filters (from the TradingView research, sections 4a/4b of the original handoff — never implemented)

- **Squat/Fake/Green MFI classification**: 
  ```
  mfiDiff = rateOfChange((high-low)/volume, 1 bar)
  volumeDiff = rateOfChange(volume, 1 bar)
  Squat = mfiDiff < 0 AND volumeDiff > 0   -> reversal warning, treat as a reason to skip
  Fake  = mfiDiff > 0 AND volumeDiff < 0   -> weak/unconvincing move, treat as a reason to skip
  Green = mfiDiff > 0 AND volumeDiff > 0   -> genuine continuation confirmation
  ```
  Apply as a pre-entry filter on the chosen entry TF: skip candidates
  classified as Squat or Fake, same spirit as the existing
  Continuation-must-be-dominant requirement — this is an additional,
  independent gate, not a replacement for it.
- **Accelerator Oscillator (AC)**: `AC = AO - SMA(AO, 5)`. Cheap (AO already
  computed). Add as an additional Continuation-scoring input — require AC to
  agree with AO's direction for full Continuation credit, catching momentum
  fading earlier than AO's own zero-cross would.

### 9d. Implement the trade-chart visualization (originally speced as section 7a, deferred until after Phase 3 to avoid a mid-experiment redeploy)

Now safe to deploy. Implement exactly as speced in section 7a: candle window
before entry through a few bars past exit, the bot's own live-computed
Jaw/Teeth/Lips values, and entry/SL/TP1-3/exit markers, stored per trade and
rendered client-side via `lightweight-charts` on the `/performance`
dashboard. Getting this live now means Phase 4's data comes with visual
evidence built in from the start, rather than reasoning from R-multiples
alone the way Phases 1-3 had to.
