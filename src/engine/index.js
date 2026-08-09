// indicators.js and scoring.js were written as browser IIFEs sharing a
// global scope (indicators.js loaded via <script> before scoring.js, so
// scoring.js's internal Indicators.analyzeTimeframe() calls resolve to a
// global). There's no equivalent implicit global in Node's CommonJS, so
// this loader recreates that load order before requiring scoring.js —
// keeps both ported files byte-for-byte unchanged rather than patching
// them to take Indicators as an explicit import.
const Indicators = require('./indicators');
global.Indicators = Indicators;
const Scoring = require('./scoring');

module.exports = { Indicators, Scoring };
