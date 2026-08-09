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

**Must be an always-on Web Service, not a free-tier sleeping service or a
Background Worker** — the free tier sleeps after 15 minutes of inactivity,
which breaks both the continuous scan/monitor loop and the live dashboard.
A real always-on instance starts around $7/month.

A **persistent Disk must be attached** for the SQLite database — Render's
default filesystem is wiped on every deploy/restart, so `DB_PATH` needs to
point inside a mounted Disk (e.g. `/var/data/wicktor.db`) or trade history
is lost every time the service redeploys.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub (already done for `wicktor-bot-cc`).
2. Render Dashboard → New → Blueprint → select this repo. `render.yaml`
   defines the service, disk, and env var keys automatically.
3. When prompted, fill in `BYBIT_DEMO_API_KEY` / `BYBIT_DEMO_API_SECRET`
   (marked `sync: false` in the blueprint — Render will prompt for these,
   they are never stored in the repo).

### Option B — Manual setup

1. Render Dashboard → New → Web Service → connect this repo.
2. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
3. Plan: choose a paid **always-on** tier (not Free).
4. Settings → Disks → Add Disk → name `wicktor-data`, mount path
   `/var/data`, size 1GB.
5. Environment → Add Environment Variables (see `.env.example` for the
   full list): `BYBIT_DEMO_API_KEY`, `BYBIT_DEMO_API_SECRET`,
   `INTENDED_ACCOUNT_SIZE_USDT`, `DB_PATH=/var/data/wicktor.db`, and the
   rest of the tunables (risk/leverage/cadence) — all have sensible
   defaults in `src/config.js` if omitted, except the two Bybit
   credentials which are required.
6. Deploy. Health check path is `/health`.

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
