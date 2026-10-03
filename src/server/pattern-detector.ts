import { Candle, CandlePattern } from '../types/index.ts';
import { filterClosedCandles } from './indicators.ts';

export function detectCandlePatterns(rawCandles: Candle[]): CandlePattern[] {
  const candles = filterClosedCandles(rawCandles);
  const patterns: CandlePattern[] = [];
  const len = candles.length;
  if (len < 2) return patterns;

  const c0 = candles[len - 1]; // latest completed closed candle
  const c1 = candles[len - 2]; // 1 ago
  const c2 = len >= 3 ? candles[len - 3] : null; // 2 ago

  const body0 = Math.abs(c0.close - c0.open);
  const range0 = c0.high - c0.low || 0.00001;
  const isBullish0 = c0.close > c0.open;
  const isBearish0 = c0.close < c0.open;

  const upperWick0 = c0.high - Math.max(c0.close, c0.open);
  const lowerWick0 = Math.min(c0.close, c0.open) - c0.low;

  const body1 = Math.abs(c1.close - c1.open);
  const range1 = c1.high - c1.low || 0.00001;
  const isBullish1 = c1.close > c1.open;
  const isBearish1 = c1.close < c1.open;

  // 1. Doji (body < 10% of total range)
  if (body0 / range0 < 0.1) {
    patterns.push({
      name: 'Doji',
      type: 'NEUTRAL',
      significance: 'MEDIUM',
      description: 'Indecision candle with tight open/close balance.',
      timestamp: c0.timestamp,
    });
  }

  // 2. Hammer (long lower wick >= 2x body, tiny upper wick, at lower levels)
  if (lowerWick0 >= 2 * body0 && upperWick0 <= 0.2 * body0 && body0 > 0.1 * range0) {
    patterns.push({
      name: 'Hammer',
      type: 'BULLISH',
      significance: 'HIGH',
      description: 'Bullish reversal pin bar rejecting lower prices.',
      timestamp: c0.timestamp,
    });
  }

  // 3. Inverted Hammer (long upper wick >= 2x body, tiny lower wick)
  if (upperWick0 >= 2 * body0 && lowerWick0 <= 0.2 * body0 && body0 > 0.1 * range0) {
    patterns.push({
      name: 'Inverted Hammer',
      type: 'BULLISH',
      significance: 'MEDIUM',
      description: 'Potential bullish reversal with strong buying impulse.',
      timestamp: c0.timestamp,
    });
  }

  // 4. Shooting Star (bearish reversal pin bar at top)
  if (upperWick0 >= 2 * body0 && lowerWick0 <= 0.2 * body0 && isBearish0) {
    patterns.push({
      name: 'Shooting Star',
      type: 'BEARISH',
      significance: 'HIGH',
      description: 'Bearish rejection pin bar rejecting higher prices.',
      timestamp: c0.timestamp,
    });
  }

  // 5. Bullish Engulfing (current green candle body completely engulfs prior red body)
  if (
    isBearish1 &&
    isBullish0 &&
    c0.open <= c1.close &&
    c0.close >= c1.open &&
    body0 > body1
  ) {
    patterns.push({
      name: 'Bullish Engulfing',
      type: 'BULLISH',
      significance: 'HIGH',
      description: 'Strong bullish engulfing pattern overtaking prior bearish pressure.',
      timestamp: c0.timestamp,
    });
  }

  // 6. Bearish Engulfing (current red candle body engulfs prior green body)
  if (
    isBullish1 &&
    isBearish0 &&
    c0.open >= c1.close &&
    c0.close <= c1.open &&
    body0 > body1
  ) {
    patterns.push({
      name: 'Bearish Engulfing',
      type: 'BEARISH',
      significance: 'HIGH',
      description: 'Bearish engulfing pattern signaling momentum exhaustion.',
      timestamp: c0.timestamp,
    });
  }

  // 7. Morning Star (3-bar bullish reversal: bear, small body, strong bull)
  if (
    c2 &&
    c2.close < c2.open && // red bar
    body1 < 0.3 * range1 && // small star body
    isBullish0 && // green confirmation
    c0.close > (c2.open + c2.close) / 2 // closes above midpoint of c2
  ) {
    patterns.push({
      name: 'Morning Star',
      type: 'BULLISH',
      significance: 'HIGH',
      description: 'High-probability 3-candle bottom reversal formation.',
      timestamp: c0.timestamp,
    });
  }

  // 8. Three White Soldiers (3 consecutive strong bullish candles with higher closes)
  if (
    c2 &&
    isBullish0 &&
    isBullish1 &&
    c2.close > c2.open &&
    c0.close > c1.close &&
    c1.close > c2.close &&
    c0.open > c1.open &&
    c1.open > c2.open
  ) {
    patterns.push({
      name: 'Three White Soldiers',
      type: 'BULLISH',
      significance: 'HIGH',
      description: 'Aggressive sustained buyer dominance across 3 consecutive bars.',
      timestamp: c0.timestamp,
    });
  }

  // 9. Piercing Pattern (red candle followed by green candle opening below low and closing above 50% midpoint)
  if (
    isBearish1 &&
    isBullish0 &&
    c0.open < c1.low &&
    c0.close > (c1.open + c1.close) / 2 &&
    c0.close < c1.open
  ) {
    patterns.push({
      name: 'Piercing Line',
      type: 'BULLISH',
      significance: 'MEDIUM',
      description: 'Bullish thrust closing well above previous bar midpoint.',
      timestamp: c0.timestamp,
    });
  }

  return patterns;
}
