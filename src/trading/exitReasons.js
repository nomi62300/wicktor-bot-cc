// Exit-reason enum. Set ONLY from the bot's own internal state machine at
// the moment a close is detected via real execution data (orderId match
// against our own tracked TP/SL orders, or Bybit's execution-level
// `stopOrderType` field) — never inferred afterward from PnL sign or price-
// move magnitude (brief 5c: the old bot's exit-reason reconstruction from
// PnL sign, in two separate places, is the confirmed root cause of its
// uninterpretable R-multiple data).
//
// STOP_LOSS_HIT / BREAKEVEN_STOP / TRAILING_STOP_HIT are kept as three
// distinct reasons (not conflated into one "stop hit") per brief section 8 —
// the old bot's first log conflated these, which was part of what made its
// R-multiple data uninterpretable.
const EXIT_REASONS = Object.freeze({
  PARTIAL_TP1: 'PARTIAL_TP1',
  PARTIAL_TP2: 'PARTIAL_TP2',
  TAKE_PROFIT_FINAL: 'TAKE_PROFIT_FINAL',
  STOP_LOSS_HIT: 'STOP_LOSS_HIT',
  BREAKEVEN_STOP: 'BREAKEVEN_STOP',
  TRAILING_STOP_HIT: 'TRAILING_STOP_HIT',
  // JAW_INVALIDATION removed (brief section 9a, Phase 4) — Phase 3's real
  // 377-trade sample showed it was the largest exit category (43.2%) with
  // a mean R (-0.906) essentially as bad as a genuine stop-loss hit
  // (-0.940), i.e. it wasn't earning its keep as an early-exit mechanism.
  // A user-initiated close via the admin API (not a bot-driven exit) —
  // still recorded from the real closing execution's price/qty, same as
  // every other reason, never inferred.
  MANUAL_CLOSE: 'MANUAL_CLOSE',
});

// Position lifecycle stage — determines which exit-reason a native SL
// trigger fill maps to.
const STAGE = Object.freeze({
  INITIAL: 'initial',       // SL still at the original computed price
  BREAKEVEN: 'breakeven',   // SL moved to entry after TP1 filled
  TRAILING: 'trailing',     // SL moved to TP1 price after TP2 filled
});

function slExitReasonForStage(stage) {
  if (stage === STAGE.BREAKEVEN) return EXIT_REASONS.BREAKEVEN_STOP;
  if (stage === STAGE.TRAILING) return EXIT_REASONS.TRAILING_STOP_HIT;
  return EXIT_REASONS.STOP_LOSS_HIT;
}

module.exports = { EXIT_REASONS, STAGE, slExitReasonForStage };
