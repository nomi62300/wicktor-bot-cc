// Single Node process running both the HTTP server (dashboard + API) and
// the background scan/monitor loop on setInterval — not a separate cron
// job (brief section 6). This is exactly what a persistent Render web
// service enables that the old GitHub Actions/cron-based bot couldn't.
const express = require('express');
const path = require('path');
const config = require('./config');
const dashboardRoutes = require('./dashboard/routes');
const { startTradingLoop } = require('./trading/cycle');
const logger = require('./utils/logger');

const app = express();

app.get('/', (req, res) => res.redirect('/performance'));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
// Self-hosted lightweight-charts UMD build (brief 9d) — served from
// node_modules rather than an external CDN, consistent with not
// depending on third-party availability for the dashboard to render.
app.get('/vendor/lightweight-charts.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'));
});
app.use('/', dashboardRoutes);

app.listen(config.port, () => {
  logger.info('server', `HTTP server listening on port ${config.port}`);
});

startTradingLoop().then(() => {
  logger.info('server', 'trading loop started', {
    positionMonitorIntervalMs: config.positionMonitorIntervalMs,
    entryScanIntervalMs: config.entryScanIntervalMs,
    maxPositions: config.maxPositions,
  });
}).catch(err => {
  logger.error('server', 'startTradingLoop failed to start', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logger.error('server', 'unhandled promise rejection', { error: err && err.message, stack: err && err.stack });
});
