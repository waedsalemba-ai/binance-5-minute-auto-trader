import { Candle, TechnicalIndicators } from '../types/index.ts';

/**
 * Filters raw candle series to ensure ONLY completed, closed candles are used.
 * Drops any currently forming unfinished candle (e.g. isClosed === false).
 */
export function filterClosedCandles(candles: Candle[]): Candle[] {
  if (!candles || candles.length === 0) return [];
  const now = Date.now();
  return candles.filter(c => c.isClosed || c.closeTime < now);
}

export function calculateSMA(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (data.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    sum += data[i] - data[i - period];
    result[i] = sum / period;
  }
  return result;
}

export function calculateEMA(data: number[], period: number): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (data.length < period) return result;

  const multiplier = 2 / (period + 1);

  // Initial SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  result[period - 1] = sum / period;

  // Subsequent EMAs
  for (let i = period; i < data.length; i++) {
    result[i] = (data[i] - result[i - 1]) * multiplier + result[i - 1];
  }
  return result;
}

export function calculateRSI(closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return result;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - (100 / (1 + rs));
    }
  }
  return result;
}

export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);

  const macdLine: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(fastEMA[i]) && !isNaN(slowEMA[i])) {
      macdLine[i] = fastEMA[i] - slowEMA[i];
    }
  }

  // Filter valid macdLine numbers to calculate signal EMA
  const validIndices: number[] = [];
  const validMacdValues: number[] = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (!isNaN(macdLine[i])) {
      validIndices.push(i);
      validMacdValues.push(macdLine[i]);
    }
  }

  const signalEMAValues = calculateEMA(validMacdValues, signalPeriod);
  const signalLine: number[] = new Array(closes.length).fill(NaN);
  const histogram: number[] = new Array(closes.length).fill(NaN);

  for (let i = 0; i < validIndices.length; i++) {
    const originalIdx = validIndices[i];
    signalLine[originalIdx] = signalEMAValues[i];
    if (!isNaN(macdLine[originalIdx]) && !isNaN(signalLine[originalIdx])) {
      histogram[originalIdx] = macdLine[originalIdx] - signalLine[originalIdx];
    }
  }

  return { macdLine, signalLine, histogram };
}

export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2
): { upper: number[]; middle: number[]; lower: number[]; bandwidth: number[] } {
  const middle = calculateSMA(closes, period);
  const upper: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);
  const bandwidth: number[] = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    upper[i] = mean + stdDevMultiplier * stdDev;
    lower[i] = mean - stdDevMultiplier * stdDev;
    bandwidth[i] = mean > 0 ? (upper[i] - lower[i]) / mean : 0;
  }

  return { upper, middle, lower, bandwidth };
}

export function calculateATR(candles: Candle[], period = 14): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length <= period) return result;

  const trueRanges: number[] = [candles[0].high - candles[0].low];

  for (let i = 1; i < candles.length; i++) {
    const highLow = candles[i].high - candles[i].low;
    const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
    const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
    trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trueRanges[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + trueRanges[i]) / period;
  }

  return result;
}

export function calculateVWAP(candles: Candle[]): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  let cumVolume = 0;
  let cumTypicalPriceVol = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumTypicalPriceVol += typicalPrice * c.volume;
    cumVolume += c.volume;

    result[i] = cumVolume > 0 ? cumTypicalPriceVol / cumVolume : typicalPrice;
  }
  return result;
}

/**
 * Calculates all technical indicators using STRICTLY closed completed candles.
 */
export function calculateAllIndicators(rawCandles: Candle[]): TechnicalIndicators {
  // Enforce CLOSED candles only rule
  const candles = filterClosedCandles(rawCandles);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);

  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);
  const sma200 = calculateSMA(closes, 200);

  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes, 12, 26, 9);
  const bollingerBands = calculateBollingerBands(closes, 20, 2);
  const atr14 = calculateATR(candles, 14);
  const vwap = calculateVWAP(candles);

  // Volume calculations: Compare current closed candle against average of previous completed candles
  const lastIdx = candles.length - 1;
  const lastClosedVol = volumes[lastIdx] || 0;

  // Previous completed 20 bars prior to latest bar
  const prevVolumes = volumes.slice(Math.max(0, lastIdx - 20), lastIdx);
  const prevVolSum = prevVolumes.reduce((s, v) => s + v, 0);
  const prevVolAvg = prevVolumes.length > 0 ? prevVolSum / prevVolumes.length : 1;
  const volumeRatio = prevVolAvg > 0 ? Number((lastClosedVol / prevVolAvg).toFixed(2)) : 1;

  const volumeSma20 = calculateSMA(volumes, 20);

  return {
    ema9,
    ema21,
    ema50,
    ema200,
    sma20,
    sma50,
    sma200,
    rsi14,
    macd,
    bollingerBands,
    atr14,
    vwap,
    volumeSma20,
    volumeRatio,
  };
}
