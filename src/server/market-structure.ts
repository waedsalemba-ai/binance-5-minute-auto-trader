import { Candle, MarketStructure } from '../types/index.ts';
import { filterClosedCandles } from './indicators.ts';

export function analyzeMarketStructure(rawCandles: Candle[], lookback = 50): MarketStructure {
  const defaultRes: MarketStructure = {
    trend: 'CONSOLIDATION',
    structure: 'NEUTRAL',
    breakout: 'NONE',
    supportLevels: [],
    resistanceLevels: [],
    swingHighs: [],
    swingLows: [],
  };

  const candles = filterClosedCandles(rawCandles);
  if (candles.length < 20) return defaultRes;

  const data = candles.slice(-lookback);
  const swingHighs: { price: number; timestamp: number }[] = [];
  const swingLows: { price: number; timestamp: number }[] = [];

  // Identify local 5-bar swing points
  for (let i = 2; i < data.length - 2; i++) {
    const curr = data[i];
    const prev1 = data[i - 1];
    const prev2 = data[i - 2];
    const next1 = data[i + 1];
    const next2 = data[i + 2];

    if (
      curr.high > prev1.high &&
      curr.high > prev2.high &&
      curr.high > next1.high &&
      curr.high > next2.high
    ) {
      swingHighs.push({ price: curr.high, timestamp: curr.timestamp });
    }

    if (
      curr.low < prev1.low &&
      curr.low < prev2.low &&
      curr.low < next1.low &&
      curr.low < next2.low
    ) {
      swingLows.push({ price: curr.low, timestamp: curr.timestamp });
    }
  }

  // Derive Support & Resistance clusters
  const highPrices = swingHighs.map(s => s.price);
  const lowPrices = swingLows.map(s => s.price);

  const resistanceLevels = clusterPrices(highPrices, 0.005).slice(-3);
  const supportLevels = clusterPrices(lowPrices, 0.005).slice(-3);

  // Evaluate structure sequence
  let structure: MarketStructure['structure'] = 'NEUTRAL';
  let trend: MarketStructure['trend'] = 'CONSOLIDATION';

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];

  if (lastHigh && prevHigh && lastLow && prevLow) {
    const isHigherHigh = lastHigh.price > prevHigh.price;
    const isHigherLow = lastLow.price > prevLow.price;
    const isLowerHigh = lastHigh.price < prevHigh.price;
    const isLowerLow = lastLow.price < prevLow.price;

    if (isHigherHigh && isHigherLow) {
      structure = 'HIGHER_HIGH';
      trend = 'UPTREND';
    } else if (isLowerHigh && isLowerLow) {
      structure = 'LOWER_LOW';
      trend = 'DOWNTREND';
    } else if (isHigherLow && !isLowerLow) {
      structure = 'HIGHER_LOW';
      trend = 'UPTREND';
    } else if (isLowerHigh && !isHigherHigh) {
      structure = 'LOWER_HIGH';
      trend = 'DOWNTREND';
    }
  }

  // Detect Breakouts based on latest closed candle
  const currentClosedPrice = candles[candles.length - 1].close;
  let breakout: MarketStructure['breakout'] = 'NONE';

  if (resistanceLevels.length > 0) {
    const nearestRes = resistanceLevels[resistanceLevels.length - 1];
    if (currentClosedPrice > nearestRes * 1.001) {
      breakout = 'BREAKOUT';
    }
  }

  if (supportLevels.length > 0) {
    const nearestSup = supportLevels[0];
    if (currentClosedPrice < nearestSup * 0.999) {
      breakout = 'BREAKDOWN';
    }
  }

  return {
    trend,
    structure,
    breakout,
    supportLevels,
    resistanceLevels,
    swingHighs: swingHighs.slice(-6),
    swingLows: swingLows.slice(-6),
  };
}

function clusterPrices(prices: number[], tolerance = 0.005): number[] {
  if (prices.length === 0) return [];
  const sorted = [...prices].sort((a, b) => a - b);
  const clusters: number[] = [];

  let currentCluster: number[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    const prev = sorted[i - 1];
    if ((p - prev) / prev <= tolerance) {
      currentCluster.push(p);
    } else {
      const avg = currentCluster.reduce((sum, v) => sum + v, 0) / currentCluster.length;
      clusters.push(Number(avg.toFixed(6)));
      currentCluster = [p];
    }
  }

  if (currentCluster.length > 0) {
    const avg = currentCluster.reduce((sum, v) => sum + v, 0) / currentCluster.length;
    clusters.push(Number(avg.toFixed(6)));
  }

  return clusters;
}
