/* ==========================================================================
   Wicktor — Indicator Engine

   RE-SYNC NOTE: manually copied from github.com/nomi62300/wicktor-scanner
   js/indicators.js @ commit 48bf029faa5d0cac88e800a3934fe963ee58922d (2026-08-09).
   Copied verbatim, no changes. If the scanner repo's indicator logic changes,
   re-copy this file and re-check trading/signalScanner.js still matches the
   shape of analyzeTimeframe()'s return value.

   All functions take arrays of candle objects: {t, o, h, l, c, v}
   Sorted oldest -> newest. Returns arrays aligned to the same index.
   ========================================================================== */

const Indicators = (() => {

  function medianPrice(candles) {
    return candles.map(c => (c.h + c.l) / 2);
  }

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  // Smoothed moving average (Wilder-style), used for Alligator lines
  function smma(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    out[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
    }
    return out;
  }

  // Shifts a series forward by `offset` bars (Alligator lines are displaced).
  // shifted[i] = raw value that was computed `offset` bars ago,
  // i.e. what would visually be plotted at bar i.
  function shiftForward(values, offset) {
    const out = new Array(values.length).fill(null);
    for (let i = offset; i < values.length; i++) {
      out[i] = values[i - offset];
    }
    return out;
  }

  /**
   * Convert real OHLCV candles to Heikin Ashi candles using the standard
   * formula. Returns the same {t,o,h,l,c,v} shape so it is a drop-in
   * replacement for the alligator() function's input.
   *   haClose = (o + h + l + c) / 4
   *   haOpen  = (prevHaOpen + prevHaClose) / 2  (first: (o + c) / 2)
   *   haHigh  = max(h, haOpen, haClose)
   *   haLow   = min(l, haOpen, haClose)
   */
  function heikinAshi(candles) {
    const ha = new Array(candles.length);
    for (let i = 0; i < candles.length; i++) {
      const { t, o, h, l, c, v } = candles[i];
      const haClose = (o + h + l + c) / 4;
      const haOpen  = i === 0
        ? (o + c) / 2
        : (ha[i - 1].o + ha[i - 1].c) / 2;
      const haHigh  = Math.max(h, haOpen, haClose);
      const haLow   = Math.min(l, haOpen, haClose);
      ha[i] = { t, o: haOpen, h: haHigh, l: haLow, c: haClose, v };
    }
    return ha;
  }

  /**
   * Williams Alligator on Heikin Ashi median price.
   * Jaw: SMMA(13) shifted +8, Teeth: SMMA(8) shifted +5, Lips: SMMA(5) shifted +3
   * Returns { jaw, teeth, lips, haCandles } arrays aligned to candle index.
   * haCandles is exposed so analyzeTimeframe() can pass it to alligatorTouchState()
   * without converting twice.
   */
  function alligator(candles) {
    const ha  = heikinAshi(candles);
    const med = medianPrice(ha);
    const jaw   = shiftForward(smma(med, 13), 8);
    const teeth = shiftForward(smma(med,  8), 5);
    const lips  = shiftForward(smma(med,  5), 3);
    return { jaw, teeth, lips, haCandles: ha };
  }

  /**
   * Walk the HA candle series forward and track whether the alligator's jaw
   * has been touched (invalidating the current move) and not yet cleared.
   *
   * Bullish context (lips > teeth > jaw at bar i):
   *   - Invalidate when haCandles[i].l <= jaw[i]
   *   - Clear when a later haCandles[k].c > lips[k]
   *
   * Bearish context (lips < teeth < jaw at bar i):
   *   - Invalidate when haCandles[i].h >= jaw[i]
   *   - Clear when a later haCandles[k].c < lips[k]
   *
   * Returns a boolean array aligned to candle index (true = invalidated).
   */
  function alligatorTouchState(haCandles, jaw, teeth, lips) {
    const n = haCandles.length;
    const invalidated = new Array(n).fill(false);
    let isInvalidated = false;

    for (let i = 0; i < n; i++) {
      const jawV   = jaw[i];
      const teethV = teeth[i];
      const lipsV  = lips[i];

      // Need all three lines present to make a determination
      if (jawV == null || teethV == null || lipsV == null) {
        invalidated[i] = false;
        continue;
      }

      const bullish = lipsV > teethV && teethV > jawV;
      const bearish = lipsV < teethV && teethV < jawV;

      if (bullish) {
        if (isInvalidated) {
          // Clear condition: HA close back above lips
          if (haCandles[i].c > lipsV) isInvalidated = false;
        } else {
          // Invalidate condition: HA low dips into or through jaw
          if (haCandles[i].l <= jawV) isInvalidated = true;
        }
      } else if (bearish) {
        if (isInvalidated) {
          // Clear condition: HA close back below lips
          if (haCandles[i].c < lipsV) isInvalidated = false;
        } else {
          // Invalidate condition: HA high touches or exceeds jaw
          if (haCandles[i].h >= jawV) isInvalidated = true;
        }
      } else {
        // Mixed/flat: don't flip state, just carry forward
      }

      invalidated[i] = isInvalidated;
    }

    return invalidated;
  }

  /**
   * Divergent Bar (grigorykov's AFDSA) — a REVERSAL signal, not
   * continuation. Fires bullish specifically when the Alligator is in
   * BEARISH order (lips < teeth < jaw), catching the bar that dips
   * furthest below a bearish mouth and snaps back (mirror for bearish DB
   * in a bullish mouth). Runs on the same HA candles as the Alligator
   * lines. Uses only the strict tier (the reference script's simple/medium
   * tiers are intermediate steps toward it); the medium tier's "OR
   * downFractal" branch is dropped since fractals are computed on real
   * candles elsewhere in Wicktor and cross-referencing them here would mix
   * two different candle bases for one signal — the `low <= low[2]` check
   * alone still captures the core bar-shape condition.
   * Returns { up, down } booleans for bar `i`.
   */
  function divergentBar(haCandles, jaw, teeth, lips, i) {
    if (i < 2) return { up: false, down: false };
    const jawV = jaw[i], teethV = teeth[i], lipsV = lips[i];
    if (jawV == null || teethV == null || lipsV == null) return { up: false, down: false };

    const bar = haCandles[i], prev1 = haCandles[i - 1], prev2 = haCandles[i - 2];
    const hl2 = (bar.h + bar.l) / 2;

    const simpleUp = bar.h < jawV && bar.h < teethV && bar.h < lipsV &&
                      bar.l < prev1.l && bar.c > hl2;
    const mediumUp = simpleUp && bar.l <= prev2.l;
    const strictUp = mediumUp && lipsV < teethV && teethV < jawV;

    const simpleDown = bar.l > jawV && bar.l > teethV && bar.l > lipsV &&
                        bar.h > prev1.h && bar.c < hl2;
    const mediumDown = simpleDown && bar.h >= prev2.h;
    const strictDown = mediumDown && lipsV > teethV && teethV > jawV;

    return { up: strictUp, down: strictDown };
  }

  /**
   * Crossing Lips — an early, softer warning tier between "fully aligned"
   * and jaw-touch invalidation: the Alligator is STILL in the original
   * trend's order while price, having closed on the trend side of lips for
   * 2 straight bars, just closed back through it. Non-invalidating by
   * design — a UI-only warning flag, not wired into the alignment/
   * touch-state logic (kept separate deliberately: see backlog notes).
   * Returns { up, down } booleans for bar `i`.
   */
  function crossingLips(haCandles, jaw, teeth, lips, i) {
    if (i < 2) return { up: false, down: false };
    const teethV = teeth[i], jawV = jaw[i];
    const l0 = lips[i], l1 = lips[i - 1], l2 = lips[i - 2];
    if (l0 == null || l1 == null || l2 == null || teethV == null || jawV == null) {
      return { up: false, down: false };
    }
    const c0 = haCandles[i].c, c1 = haCandles[i - 1].c, c2 = haCandles[i - 2].c;

    const down = c0 < l0 && c1 > l1 && c2 > l2 && l0 > teethV && teethV > jawV;
    const up   = c0 > l0 && c1 < l1 && c2 < l2 && l0 < teethV && teethV < jawV;
    return { up, down };
  }

  /**
   * Awesome Oscillator: SMA(median,5) - SMA(median,34)
   * Operates on REAL candles — unchanged.
   */
  function awesomeOscillator(candles) {
    const med = medianPrice(candles);
    const fast = sma(med, 5);
    const slow = sma(med, 34);
    return med.map((_, i) => {
      if (fast[i] == null || slow[i] == null) return null;
      return fast[i] - slow[i];
    });
  }

  // SMA that treats a null anywhere in the window as "not enough data yet"
  // rather than propagating NaN — needed for accelerator(), whose input
  // (AO) itself starts with a run of nulls.
  function smaSkipNulls(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0, ok = true;
      for (let k = i - period + 1; k <= i; k++) {
        if (values[k] == null) { ok = false; break; }
        sum += values[k];
      }
      if (ok) out[i] = sum / period;
    }
    return out;
  }

  /**
   * Accelerator Oscillator (Bill Williams): AO - SMA(AO, 5). Measures
   * whether AO's own momentum is accelerating/decelerating, catching a
   * shift before AO itself crosses zero. Operates on REAL candles.
   */
  function acceleratorOscillator(candles) {
    const aoSeries = awesomeOscillator(candles);
    const aoSma5 = smaSkipNulls(aoSeries, 5);
    return aoSeries.map((v, i) => (v == null || aoSma5[i] == null) ? null : v - aoSma5[i]);
  }

  /**
   * Market Facilitation Index (Bill Williams): (high - low) / volume.
   * Operates on REAL candles.
   */
  function mfi(candles) {
    return candles.map(c => (c.v > 0 ? (c.h - c.l) / c.v : null));
  }

  /**
   * Squat / Fake / Green bar classification (Bill Williams), from the
   * 1-bar rate of change of MFI and of volume:
   *   Squat = mfiDiff < 0 AND volumeDiff > 0   -> reversal warning
   *   Fake  = mfiDiff > 0 AND volumeDiff < 0   -> weak/unconvincing move
   *   Green = mfiDiff > 0 AND volumeDiff > 0   -> continuation confirmation
   * The 4th combination (both falling) is labeled 'fade' — informational
   * only, not fed into scoring.
   * Returns an array of 'squat'|'fake'|'green'|'fade'|null aligned to candle index.
   */
  function mfiClassification(candles) {
    const mfiSeries = mfi(candles);
    const out = new Array(candles.length).fill(null);
    for (let i = 1; i < candles.length; i++) {
      if (mfiSeries[i] == null || mfiSeries[i - 1] == null) continue;
      const mfiDiff = mfiSeries[i] - mfiSeries[i - 1];
      const volumeDiff = candles[i].v - candles[i - 1].v;
      if (mfiDiff < 0 && volumeDiff > 0) out[i] = 'squat';
      else if (mfiDiff > 0 && volumeDiff < 0) out[i] = 'fake';
      else if (mfiDiff > 0 && volumeDiff > 0) out[i] = 'green';
      else out[i] = 'fade';
    }
    return out;
  }

  /**
   * "Wiseman" AO-shape reversal signals — two independent patterns, keyed
   * off AO's own shape alone (distinct from the Alligator-based Divergent
   * Bar). Wiseman1: price makes a fresh 2-bar low but closes in the upper
   * half of the bar while AO is still falling for 2 bars straight — a
   * momentum/price disagreement. Wiseman2: AO is in a "trough, rise, dip,
   * rise" shape below zero — a double-bottom in the histogram itself.
   * Mirror conditions (Wiseman1/2 short) for the bearish case.
   * Operates on REAL candles. Returns booleans for bar `i`.
   */
  function wisemanSignals(candles, aoSeries, i) {
    const none = { long1: false, long2: false, short1: false, short2: false };
    if (i < 4) return none;
    const ao0 = aoSeries[i], ao1 = aoSeries[i - 1], ao2 = aoSeries[i - 2],
          ao3 = aoSeries[i - 3], ao4 = aoSeries[i - 4];
    if ([ao0, ao1, ao2, ao3, ao4].some(v => v == null)) return none;

    const bar = candles[i], prev = candles[i - 1];
    const ohlc4 = (bar.o + bar.h + bar.l + bar.c) / 4;
    const lowest2 = Math.min(bar.l, prev.l);
    const highest2 = Math.max(bar.h, prev.h);

    return {
      long1:  bar.c > ohlc4 && bar.l === lowest2 && ao0 < 0 && ao0 < ao1 && ao1 < ao2,
      long2:  ao0 < 0 && ao0 > ao1 && ao1 > ao2 && ao2 > ao3 && ao3 < ao4,
      short1: bar.c < ohlc4 && bar.h === highest2 && ao0 > 0 && ao0 > ao1 && ao1 > ao2,
      short2: ao0 > 0 && ao0 < ao1 && ao1 < ao2 && ao2 < ao3 && ao3 > ao4
    };
  }

  /**
   * Williams Fractals (5-bar) with tie-tolerance. A run of equal
   * high (or low) values up to `tolerance` bars wide is treated as a
   * single peak/trough rather than blocking detection — ported from the
   * AFDSA/AlFReSco reference scripts, since the original strict-inequality
   * check could miss a real fractal on a tie. The plateau must still be
   * flanked by 2 strictly lower (or higher) bars on both sides just
   * outside the run, and is reported once, at the LAST bar of the tie
   * (so it's still only confirmed once 2 bars exist after it — same
   * confirmation-lag semantics as before). tolerance defaults to 5,
   * matching the reference scripts; a plateau of 1 bar (no tie) reduces
   * to the original classic strict 5-bar fractal test.
   * Returns { up: [indices], down: [indices] }
   * Operates on REAL candles — unchanged.
   */
  function fractals(candles, tolerance = 5) {
    const n = candles.length;
    const up = [];
    const down = [];
    for (let i = 2; i < n - 2; i++) {
      if (isFractalEdge(candles, i, 'h', tolerance, n, false)) up.push(i);
      if (isFractalEdge(candles, i, 'l', tolerance, n, true)) down.push(i);
    }
    return { up, down };
  }

  function isFractalEdge(candles, i, key, tolerance, n, isLow) {
    const v = candles[i][key];

    // Walk across bars tied with the center value (the plateau), capped
    // at `tolerance` bars from i on each side.
    let left = i;
    while (left > 0 && candles[left - 1][key] === v && (i - (left - 1)) <= tolerance) left--;
    let right = i;
    while (right < n - 1 && candles[right + 1][key] === v && ((right + 1) - i) <= tolerance) right++;

    // Only flag once, at the plateau's rightmost bar.
    if (i !== right) return false;
    if (left < 2 || right > n - 3) return false;

    const outer = [candles[left - 2][key], candles[left - 1][key], candles[right + 1][key], candles[right + 2][key]];
    return isLow ? outer.every(x => x > v) : outer.every(x => x < v);
  }

  function lastFractal(fractalIndices, beforeIndex) {
    for (let i = fractalIndices.length - 1; i >= 0; i--) {
      if (fractalIndices[i] <= beforeIndex) return fractalIndices[i];
    }
    return null;
  }

  /**
   * True Range and Wilder-smoothed ATR. Operates on REAL candles.
   */
  function trueRange(candles) {
    const out = new Array(candles.length).fill(null);
    for (let i = 0; i < candles.length; i++) {
      if (i === 0) { out[i] = candles[i].h - candles[i].l; continue; }
      const prevClose = candles[i - 1].c;
      out[i] = Math.max(
        candles[i].h - candles[i].l,
        Math.abs(candles[i].h - prevClose),
        Math.abs(candles[i].l - prevClose)
      );
    }
    return out;
  }

  function atr(candles, period = 14) {
    return smma(trueRange(candles), period);
  }

  // ATR expressed as a fraction of price, bucketed into discrete steps
  // (0.1% / 0.2% / 0.3% / 0.5% / 0.75% / 1%) rather than used as a raw
  // continuous value — reduces noise-driven jitter in anything derived
  // from it (Skyrexio pattern). Fractions, not fixed dollar steps, so it
  // scales across assets from micro-cap tokens to BTC. Snaps UP to the
  // nearest bucket at or above the raw ratio; ratios beyond the largest
  // bucket are left unbucketed (real high-volatility conditions, not noise).
  const ATR_PCT_BUCKETS = [0.001, 0.002, 0.003, 0.005, 0.0075, 0.01];

  function bucketedAtr(atrValue, price) {
    if (atrValue == null || !price) return atrValue;
    const ratio = atrValue / price;
    const bucket = ATR_PCT_BUCKETS.find(b => ratio <= b);
    return (bucket != null ? bucket : ratio) * price;
  }

  /**
   * Nearest-fractal support/resistance around the current price — reuses the
   * same fractal set as the jaw-touch SL / "last opposing fractal" logic
   * elsewhere, rather than introducing a second unrelated notion of "level".
   * Resistance = nearest fractal high above price; Support = nearest
   * fractal low below price, both within `lookback` bars of the latest bar.
   * Falls back to a bucketed-ATR-scaled buffer when no fractal exists on
   * that side (e.g. price at a new high/low within the window).
   */
  function nearestLevels(candles, frac, price, atrValue, lookback = 150) {
    const minIdx = Math.max(0, candles.length - 1 - lookback);

    let resistance = null;
    frac.up.forEach(i => {
      if (i < minIdx) return;
      const h = candles[i].h;
      if (h > price && (resistance == null || h < resistance)) resistance = h;
    });

    let support = null;
    frac.down.forEach(i => {
      if (i < minIdx) return;
      const l = candles[i].l;
      if (l < price && (support == null || l > support)) support = l;
    });

    const atrBucketed = bucketedAtr(atrValue, price) ?? price * 0.01;
    const atrBuffer = atrBucketed * 1.5;
    if (resistance == null) resistance = price + atrBuffer;
    if (support == null) support = price - atrBuffer;

    return { resistance, support };
  }

  /**
   * RSI, Wilder's smoothing, standard 14-period default.
   * Operates on REAL candles — unchanged.
   */
  function rsi(candles, period = 14) {
    const closes = candles.map(c => c.c);
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;

    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gainSum += diff; else lossSum -= diff;
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return out;
  }

  /**
   * Divergence check between price pivots (fractal highs/lows) and RSI
   * at those same pivots. Looks at the two most recent same-type
   * fractals within `lookback` bars of the latest closed bar.
   * Returns 'bull' | 'bear' | 'none'
   * Operates on REAL candles — unchanged.
   */
  function divergence(candles, rsiSeries, frac, lookback = 60) {
    const lastIdx = candles.length - 1;
    const minIdx = Math.max(0, lastIdx - lookback);

    const recentDown = frac.down.filter(i => i >= minIdx);
    if (recentDown.length >= 2) {
      const [i1, i2] = recentDown.slice(-2);
      const priceLower = candles[i2].l < candles[i1].l;
      const rsiHigher = rsiSeries[i2] != null && rsiSeries[i1] != null &&
                         rsiSeries[i2] > rsiSeries[i1];
      if (priceLower && rsiHigher) return 'bull';
    }

    const recentUp = frac.up.filter(i => i >= minIdx);
    if (recentUp.length >= 2) {
      const [i1, i2] = recentUp.slice(-2);
      const priceHigher = candles[i2].h > candles[i1].h;
      const rsiLower = rsiSeries[i2] != null && rsiSeries[i1] != null &&
                        rsiSeries[i2] < rsiSeries[i1];
      if (priceHigher && rsiLower) return 'bear';
    }

    return 'none';
  }

  /**
   * 5-tier per-TF alignment confidence (Profitunity multi-timeframe
   * screener), richer than the binary aligned/not-aligned `alignment`
   * value: grades HOW CLEAN the current alignment is by checking whether
   * any of the last 5 HA closes dipped back across lips against the
   * trend (a weakening/recovering tell that precedes an actual jaw-touch
   * invalidation). Only meaningful when `alignment` is already non-zero
   * (jaw-touch already resets alignment to 0, so "opposite trend" here
   * just falls out of alignment === -1 vs 1 — no separate case needed).
   * Returns 'strong_bull' | 'weak_bull' | 'neutral' | 'weak_bear' | 'strong_bear'.
   */
  function tfConfidenceTier(haCandles, lips, alignment, lastIdx) {
    if (alignment === 0) return 'neutral';
    const from = Math.max(0, lastIdx - 4);
    let wrongSideCount = 0;
    for (let k = from; k <= lastIdx; k++) {
      const lipsV = lips[k];
      if (lipsV == null) continue;
      if (alignment === 1 && haCandles[k].c < lipsV) wrongSideCount++;
      else if (alignment === -1 && haCandles[k].c > lipsV) wrongSideCount++;
    }
    if (wrongSideCount === 0) return alignment === 1 ? 'strong_bull' : 'strong_bear';
    return alignment === 1 ? 'weak_bull' : 'weak_bear';
  }

  /**
   * Convenience: compute everything for one timeframe's candles and
   * return a compact snapshot of the latest closed bar.
   *
   * Alligator + touch-state invalidation run on Heikin Ashi candles.
   * AO, RSI, Fractals, Divergence remain on real candles.
   */
  function analyzeTimeframe(candles) {
    if (!candles || candles.length < 40) return null;
    const lastIdx = candles.length - 1;

    // Alligator on HA candles
    const { jaw, teeth, lips, haCandles } = alligator(candles);

    // AO, Fractals, RSI, Divergence all on REAL candles — untouched
    const ao = awesomeOscillator(candles);
    const frac = fractals(candles);
    const rsiSeries = rsi(candles);
    const div = divergence(candles, rsiSeries, frac);

    // Raw line-ordering alignment from displaced HA-SMMA lines
    const jawV = jaw[lastIdx], teethV = teeth[lastIdx], lipsV = lips[lastIdx];
    let alignment = 0; // 1 bullish, -1 bearish, 0 mixed/flat
    if (jawV != null && teethV != null && lipsV != null) {
      if (lipsV > teethV && teethV > jawV) alignment = 1;
      else if (lipsV < teethV && teethV < jawV) alignment = -1;
    }

    // Touch-state invalidation — walks HA candles, returns bool[] per bar
    const touchStates = alligatorTouchState(haCandles, jaw, teeth, lips);
    const alligatorInvalidated = touchStates[lastIdx];

    // If the jaw was touched and not yet cleared, override alignment to 0
    if (alligatorInvalidated) alignment = 0;

    const confidence = tfConfidenceTier(haCandles, lips, alignment, lastIdx);

    const aoV = ao[lastIdx];
    const aoPrev = ao[lastIdx - 1];
    const aoRising = aoV != null && aoPrev != null && aoV > aoPrev;

    const acSeries = acceleratorOscillator(candles);
    const acV = acSeries[lastIdx];
    const acPrev = acSeries[lastIdx - 1];
    const acRising = acV != null && acPrev != null && acV > acPrev;

    const mfiSignal = mfiClassification(candles)[lastIdx];

    const db = divergentBar(haCandles, jaw, teeth, lips, lastIdx);
    const crossLips = crossingLips(haCandles, jaw, teeth, lips, lastIdx);
    const wiseman = wisemanSignals(candles, ao, lastIdx);

    const lastUpFrac = lastFractal(frac.up, lastIdx - 2);
    const lastDownFrac = lastFractal(frac.down, lastIdx - 2);
    const price = candles[lastIdx].c;
    const aboveUpFractal = lastUpFrac != null && price > candles[lastUpFrac].h;
    const belowDownFractal = lastDownFrac != null && price < candles[lastDownFrac].l;

    const atrV = atr(candles)[lastIdx];
    const { resistance, support } = nearestLevels(candles, frac, price, atrV);

    return {
      alignment,              // 1 / -1 / 0 (0 if jaw was touched and not cleared)
      confidence,             // 5-tier: strong_bull/weak_bull/neutral/weak_bear/strong_bear
      alligatorInvalidated,   // true if jaw-touch rule is currently active
      ao: aoV,
      aoRising,
      ac: acV,
      acRising,
      mfiSignal,
      divergentBarUp: db.up,
      divergentBarDown: db.down,
      crossingLipsUp: crossLips.up,
      crossingLipsDown: crossLips.down,
      wisemanBullish: wiseman.long1 || wiseman.long2,
      wisemanBearish: wiseman.short1 || wiseman.short2,
      rsi: rsiSeries[lastIdx],
      divergence: div,
      lastUpFractal: lastUpFrac != null ? candles[lastUpFrac].h : null,
      lastDownFractal: lastDownFrac != null ? candles[lastDownFrac].l : null,
      aboveUpFractal,
      belowDownFractal,
      atr: atrV,
      resistance,
      support,
      close: price
    };
  }

  return {
    medianPrice, sma, smma, shiftForward,
    heikinAshi, alligator, alligatorTouchState,
    divergentBar, crossingLips,
    awesomeOscillator, acceleratorOscillator, wisemanSignals, mfi, mfiClassification,
    fractals, rsi, divergence, tfConfidenceTier,
    lastFractal, trueRange, atr, bucketedAtr, nearestLevels, analyzeTimeframe
  };
})();

if (typeof module !== 'undefined') module.exports = Indicators;

