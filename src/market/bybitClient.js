// Single shared Bybit V5 REST client, pointed at Demo Trading.
// `demoTrading: true` is the specific SDK config the old bot got right
// (brief section 5f) — keeping it unchanged here.
const { RestClientV5 } = require('bybit-api');
const config = require('../config');

const client = new RestClientV5({
  key: config.bybit.apiKey,
  secret: config.bybit.apiSecret,
  demoTrading: config.bybit.demoTrading,
});

module.exports = client;
