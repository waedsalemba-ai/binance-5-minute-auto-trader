import {
  Candle,
  TechnicalAnalysis,
  TechnicalIndicators,
  CandlePattern,
  MarketStructure,
  TimeframeSignal,
  StrategyState,
  ScoreComponent,
  TradingSettings,
} from '../types/index.ts';
import { calculateAllIndicators } from './indicators.ts';
import { detectCandlePatterns } from './pattern-detector.ts';
import { analyzeMarketStructure } from './market-structure.ts';

export class StrategyEngine {
  public static analyzeTimeframe(candles: Candle[], tf: '5m' | '15m' | '1h' | '4h'): TimeframeSignal {
    if (candles.length < 30) {
      return { timeframe: tf, trend: 'NEUTRAL', score: 50, rsi: 50, macdCross: 'NONE' };
    }

    const ind = calculateAllIndicators(candles);
    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;
    const ema9 = ind.ema9[lastIdx];
    const ema21 = ind.ema21[lastIdx];
    const ema50 = ind.ema50[lastIdx];
    const rsi = ind.rsi14[lastIdx] || 50;

    let score = 50;
    let trend: TimeframeSignal['trend'] = 'NEUTRAL';
    let macdCross: TimeframeSignal['macdCross'] = 'NONE';

    if (price > ema9 && ema9 > ema21) {
      score += 25;
      trend = 'BULLISH';
    } else if (price < ema9 && ema9 < ema21) {
      score -= 25;
      trend = 'BEARISH';
    }

    if (price > ema50) score += 10;
    else score -= 10;

    if (rsi > 55) score += 10;
    else if (rsi < 45) score -= 10;

    const hist0 = ind.macd.histogram[lastIdx] || 0;
    const hist1 = ind.macd.histogram[lastIdx - 1] || 0;
    if (hist1 <= 0 && hist0 > 0) {
      macdCross = 'BULLISH';
      score += 15;
    } else if (hist1 >= 0 && hist0 < 0) {
      macdCross = 'BEARISH';
      score -= 15;
    }

    return {
      timeframe: tf,
      trend,
      score: Math.max(0, Math.min(100, score)),
      rsi: Number(rsi.toFixed(1)),
      macdCross,
    };
  }

  public static calculateTechnicalScore(
    candles: Candle[],
    ind: TechnicalIndicators,
    patterns: CandlePattern[],
    structure: MarketStructure,
    mtf: { '5m': TimeframeSignal; '15m'?: TimeframeSignal; '1h'?: TimeframeSignal; '4h'?: TimeframeSignal }
  ): { score: number; components: ScoreComponent[] } {
    const components: ScoreComponent[] = [];
    const lastIdx = candles.length - 1;
    const price = candles[lastIdx].close;

    // 1. Trend Alignment (Weight 20)
    let trendScore = 0;
    const mtfSignals = [mtf['5m'], mtf['15m'], mtf['1h'], mtf['4h']].filter(Boolean) as TimeframeSignal[];
    const bullishTfs = mtfSignals.filter(s => s.trend === 'BULLISH').length;
    const bearishTfs = mtfSignals.filter(s => s.trend === 'BEARISH').length;

    if (bullishTfs >= 3) {
      trendScore = 20;
    } else if (bullishTfs === 2 && bearishTfs === 0) {
      trendScore = 15;
    } else if (bullishTfs === 2 && bearishTfs <= 1) {
      trendScore = 12;
    } else if (bullishTfs === 1 && bearishTfs === 0) {
      trendScore = 8;
    } else if (bearishTfs >= 2) {
      trendScore = 2;
    } else {
      trendScore = 10;
    }
    components.push({
      name: 'Trend Alignment',
      weight: 20,
      score: trendScore,
      details: `${bullishTfs}/${mtfSignals.length} timeframes bullish`,
    });

    // 2. Momentum (Weight 15)
    let momentumScore = 7.5;
    const hist = ind.macd.histogram[lastIdx] || 0;
    const histPrev = ind.macd.histogram[lastIdx - 1] || 0;
    const rsi = ind.rsi14[lastIdx] || 50;

    if (hist > 0 && hist > histPrev) {
      momentumScore += 5;
    } else if (hist > 0 && hist <= histPrev) {
      momentumScore += 2;
    } else if (hist < 0 && hist < histPrev) {
      momentumScore -= 5;
    }

    if (rsi >= 50 && rsi <= 70) {
      momentumScore += 2.5;
    } else if (rsi > 70) {
      momentumScore += 1; // strong but approaching overbought
    } else if (rsi < 40) {
      momentumScore -= 3;
    }
    momentumScore = Math.max(0, Math.min(15, momentumScore));
    components.push({
      name: 'Momentum',
      weight: 15,
      score: Number(momentumScore.toFixed(1)),
      details: `MACD hist: ${hist.toFixed(4)}, RSI: ${rsi.toFixed(1)}`,
    });

    // 3. Volume (Weight 15)
    let volumeScore = 5;
    const vr = ind.volumeRatio;
    if (vr >= 2.0 && price > candles[lastIdx].open) {
      volumeScore = 15;
    } else if (vr >= 1.4 && price > candles[lastIdx].open) {
      volumeScore = 12;
    } else if (vr >= 1.0 && price > candles[lastIdx].open) {
      volumeScore = 9;
    } else if (vr < 0.6) {
      volumeScore = 4;
    } else if (price < candles[lastIdx].open && vr >= 1.5) {
      volumeScore = 1; // high selling volume
    }
    components.push({
      name: 'Volume & Flow',
      weight: 15,
      score: volumeScore,
      details: `Volume Ratio: ${vr}x 20-SMA`,
    });

    // 4. EMA Structure (Weight 10)
    let emaScore = 5;
    const ema9 = ind.ema9[lastIdx];
    const ema21 = ind.ema21[lastIdx];
    const ema50 = ind.ema50[lastIdx];
    const ema200 = ind.ema200[lastIdx];

    const isBullStack = ema9 > ema21 && (isNaN(ema50) || ema21 > ema50) && (isNaN(ema200) || ema50 > ema200);
    const isPriceAboveEma = price > ema9;

    if (isBullStack && isPriceAboveEma) {
      emaScore = 10;
    } else if (ema9 > ema21 && isPriceAboveEma) {
      emaScore = 8;
    } else if (ema9 > ema21) {
      emaScore = 6;
    } else if (price < ema9 && ema9 < ema21) {
      emaScore = 1;
    }
    components.push({
      name: 'EMA Alignment',
      weight: 10,
      score: emaScore,
      details: isBullStack ? 'Full bullish stacked EMAs' : ema9 > ema21 ? 'EMA 9 > 21' : 'Bearish EMA structure',
    });

    // 5. RSI Context (Weight 10)
    let rsiScore = 5;
    if (rsi >= 52 && rsi <= 68) {
      rsiScore = 10; // optimal bull sweet spot
    } else if (rsi > 68 && rsi <= 78) {
      rsiScore = 7;
    } else if (rsi > 78) {
      rsiScore = 4; // overbought risk
    } else if (rsi >= 45 && rsi < 52) {
      rsiScore = 5;
    } else {
      rsiScore = 2;
    }
    components.push({
      name: 'RSI Context',
      weight: 10,
      score: rsiScore,
      details: `RSI-14: ${rsi.toFixed(1)}`,
    });

    // 6. MACD Structure (Weight 10)
    let macdScore = 5;
    const macdLine = ind.macd.macdLine[lastIdx] || 0;
    const signalLine = ind.macd.signalLine[lastIdx] || 0;
    if (macdLine > signalLine && macdLine > 0) {
      macdScore = 10;
    } else if (macdLine > signalLine && macdLine <= 0) {
      macdScore = 7;
    } else if (macdLine <= signalLine && macdLine > 0) {
      macdScore = 4;
    } else {
      macdScore = 1;
    }
    components.push({
      name: 'MACD Signal',
      weight: 10,
      score: macdScore,
      details: macdLine > signalLine ? 'MACD above Signal' : 'MACD below Signal',
    });

    // 7. Market Structure (Weight 10)
    let structScore = 5;
    if (structure.trend === 'UPTREND' && structure.structure === 'HIGHER_HIGH') {
      structScore = 10;
    } else if (structure.trend === 'UPTREND') {
      structScore = 8;
    } else if (structure.trend === 'CONSOLIDATION') {
      structScore = 5;
    } else {
      structScore = 2;
    }
    components.push({
      name: 'Market Structure',
      weight: 10,
      score: structScore,
      details: `${structure.trend} (${structure.structure})`,
    });

    // 8. Candle Pattern (Weight 5)
    let patternScore = 2.5;
    const hasBullishPattern = patterns.some(p => p.type === 'BULLISH' && p.significance === 'HIGH');
    const hasBearishPattern = patterns.some(p => p.type === 'BEARISH' && p.significance === 'HIGH');

    if (hasBullishPattern && !hasBearishPattern) {
      patternScore = 5;
    } else if (hasBearishPattern) {
      patternScore = 0;
    } else {
      patternScore = 2.5;
    }
    components.push({
      name: 'Candle Patterns',
      weight: 5,
      score: patternScore,
      details: patterns.length > 0 ? patterns.map(p => p.name).join(', ') : 'No primary pattern',
    });

    // 9. Breakout / Volatility Expansion (Weight 5)
    let breakoutScore = 2.5;
    const upperBB = ind.bollingerBands.upper[lastIdx];
    if (structure.breakout === 'BREAKOUT') {
      breakoutScore = 5;
    } else if (price >= upperBB) {
      breakoutScore = 4;
    } else if (structure.breakout === 'BREAKDOWN') {
      breakoutScore = 0;
    }
    components.push({
      name: 'Breakout Dynamics',
      weight: 5,
      score: breakoutScore,
      details: structure.breakout !== 'NONE' ? structure.breakout : 'In-range volatility',
    });

    const totalRaw = components.reduce((sum, c) => sum + c.score, 0);
    const finalScore = Math.max(0, Math.min(100, Math.round(totalRaw)));

    return { score: finalScore, components };
  }

  public static evaluateStrategyState(
    currentAnalysis: TechnicalAnalysis,
    previousState?: StrategyState,
    settings?: TradingSettings
  ): { state: StrategyState; reason: string } {
    const preBullishMin = settings?.preBullishScoreMin ?? 65;
    const strongBullishMin = settings?.strongBullishScoreMin ?? 80;
    const weakeningThreshold = settings?.weakeningThreshold ?? 70;

    const score = currentAnalysis.score;
    const ind = currentAnalysis.indicators;
    const lastIdx = ind.ema9.length - 1;
    const price = currentAnalysis.price;
    const ema9 = ind.ema9[lastIdx];
    const ema21 = ind.ema21[lastIdx];
    const rsi = ind.rsi14[lastIdx] || 50;
    const macdHist = ind.macd.histogram[lastIdx] || 0;
    const macdHistPrev = ind.macd.histogram[lastIdx - 1] || 0;

    // Strong Bullish Exit / Weakening Detector
    if (previousState === 'STRONG_BULLISH' || previousState === 'BULLISH') {
      const isScoreDeteriorating = score < weakeningThreshold;
      const isEMACrossDown = price < ema9 && ema9 < ema21;
      const isRsiReversal = rsi > 75 && rsi < (ind.rsi14[lastIdx - 1] || 50) - 4;
      const isMacdDeteriorating = macdHist < 0 || (macdHist > 0 && macdHist < macdHistPrev * 0.5);
      const isBearishBreakdown = currentAnalysis.marketStructure.breakout === 'BREAKDOWN';

      if (isScoreDeteriorating || isEMACrossDown || isBearishBreakdown || (isRsiReversal && isMacdDeteriorating)) {
        return {
          state: 'WEAKENING',
          reason: `Weakening detected: Score ${score} < ${weakeningThreshold}, MACD histogram shrinking, or EMA structure loss.`,
        };
      }

      if (score >= strongBullishMin) {
        return {
          state: 'STRONG_BULLISH',
          reason: `Strong bullish momentum confirmed (Score: ${score} >= ${strongBullishMin}). Holding position.`,
        };
      }

      return {
        state: 'BULLISH',
        reason: `Bullish trend intact (Score: ${score}). Holding position.`,
      };
    }

    if (previousState === 'WEAKENING') {
      return {
        state: 'EXIT',
        reason: 'Signal completed weakening phase; position scheduled for full liquidation.',
      };
    }

    // New setups:
    if (score >= strongBullishMin) {
      return {
        state: 'STRONG_BULLISH',
        reason: `High conviction strong bullish momentum (Score: ${score}).`,
      };
    }

    if (score >= preBullishMin) {
      return {
        state: 'PRE_BULLISH',
        reason: `Pre-bullish structural setup identified (Score: ${score} >= ${preBullishMin}). Valid entry signal.`,
      };
    }

    if (score >= 55) {
      return {
        state: 'NEUTRAL',
        reason: `Neutral-to-mildly constructive posture (Score: ${score}). No entry trigger.`,
      };
    }

    return {
      state: 'NEUTRAL',
      reason: `Market posture is neutral/bearish (Score: ${score} < ${preBullishMin}).`,
    };
  }
}
