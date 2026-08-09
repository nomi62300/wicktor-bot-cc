# wicktor-bot-cc

24/7 automated trading bot running Wicktor's Alligator/Fractals/AO/RSI signal
engine against Bybit's Demo Trading environment, as a persistent Render web
service with a live `/performance` dashboard.

## Architecture

One Node process runs both an Express HTTP server (`/performance` dashboard
+ API) and a background trading loop on two independent `setInterval`
cadences — not a cron job:

- **Entry scan** (`ENTRY_SCAN_INTERVAL_MS`, default 60s): scans the tradeable
  universe, evaluates the signal engine, and places new entries.
- **Position monitor** (`POSITION_MONITOR_INTERVAL_MS`, default 30s): checks
  open positions for TP/SL fills and jaw-invalidation, moves stops to
  breakeven/trailing, and journals every exit.

See `src/engine/` for the ported indicator/scoring engine (from
`wicktor-scanner`), `src/trading/` for order execution and position
lifecycle management, and `src/persistence/` for the SQLite trade journal
and internal virtual bankroll.

## Local development

```bash
npm install
cp .env.example .env   # then fill in real Bybit Demo API credentials
npm start
```

Dashboard: `http://localhost:3000/performance`

## Deploying to Render

Two supported modes — pick one. `render.yaml` is currently configured for
mode 2 (free tier).

### Mode 1 — Paid always-on + persistent Disk (what the brief specifies)

The free tier sleeps after 15 minutes of inactivity, which breaks both the
continuous scan/monitor loop and the live dashboard. A real always-on
instance starts around $7/month. A **persistent Disk must be attached**
for the SQLite database — Render's default filesystem is wiped on every
deploy/restart, so `DB_PATH` needs to point inside a mounted Disk (e.g.
`/var/data/wicktor.db`) or trade history is lost every time the service
redeploys.

1. Render Dashboard → New → Web Service → connect this repo.
2. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
3. Plan: choose a paid **always-on** tier (not Free).
4. Settings → Disks → Add Disk → name `wicktor-data`, mount path
   `/var/data`, size 1GB.
5. Environment → set `DB_PATH=/var/data/wicktor.db`, plus the credentials
   and tunables below.
6. Deploy. Health check path is `/health`.

Or via Blueprint: edit `render.yaml` to switch `plan: free` → `plan:
starter`, uncomment the `disk:` block, and change `DB_PATH` back to
`/var/data/wicktor.db` — then Render Dashboard → New → Blueprint → select
this repo.

### Mode 2 — Free tier + external keepalive pinger (current setup)

No cost, but two real tradeoffs to accept:

- **No persistent Disk is available on the free plan.** `DB_PATH` is set
  to `/opt/render/project/src/data/wicktor.db` — inside the app's own
  writable directory rather than a Disk mount — which avoids an `EACCES`
  crash on startup (trying to `mkdir` a Disk path that doesn't exist when
  no Disk is attached). But this path is **wiped on every redeploy and on
  Render's periodic free-tier instance recycling** — not just manual
  restarts. Trade journal, bankroll balance, and dashboard stats will
  periodically reset to zero, silently, with no error in the logs.
- **Free tier sleeps after 15 minutes idle.** A keepalive pinger (e.g.
  [cron-job.org](https://cron-job.org) hitting `/health` every ~10 min)
  works around this for the scan/monitor loop to keep running, but the
  brief is explicit that this combination is fine for further testing,
  not something to trust once real trade-history continuity matters.

Setup:

1. Render Dashboard → New → Web Service → connect this repo.
2. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
3. Plan: **Free**.
4. Environment → Add Environment Variables (see `.env.example` for the
   full list): `BYBIT_DEMO_API_KEY`, `BYBIT_DEMO_API_SECRET`,
   `INTENDED_ACCOUNT_SIZE_USDT`, `DB_PATH=/opt/render/project/src/data/wicktor.db`,
   and the rest of the tunables (risk/leverage/cadence) — all have
   sensible defaults in `src/config.js` if omitted, except the two Bybit
   credentials which are required.
5. Deploy. Health check path is `/health`.
6. Set up an external pinger (cron-job.org or similar) hitting
   `https://<your-service>.onrender.com/health` every ~10 minutes.

### Bybit Demo API credentials

Generate from Bybit's **Demo Trading account view** specifically (API
Management while viewing Demo Trading), not the regular mainnet API page.
**Important**: this account must not be shared with any other actively-
trading bot/process — live-tested during development that a second system
trading the same account causes real order/position collisions (see the
M4 commit history for what that looked like and how the bot defends
against it).

## Verification before trusting a deployed run

Per the project brief, before treating any live run as validated: pull the
bot's own trade journal (`/api/trades.csv`) for a time window and diff it
against Bybit's actual Demo Trading Order History / Position History for
the same window — they must match exactly. This is the same check that
caught the previous bot's most severe bug (synthetic trade resolution) and
should be step one of testing any live run, not an afterthought.
