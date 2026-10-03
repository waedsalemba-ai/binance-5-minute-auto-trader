import React, { useRef, useEffect, useState } from 'react';
import { Candle, TechnicalIndicators } from '../types/index.ts';

interface CandleChartProps {
  symbol: string;
  candles: Candle[];
  indicators?: TechnicalIndicators;
  supportLevels?: number[];
  resistanceLevels?: number[];
  height?: number;
}

export const CandleChart: React.FC<CandleChartProps> = ({
  symbol,
  candles,
  indicators,
  supportLevels = [],
  resistanceLevels = [],
  height = 420,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width = canvas.parentElement?.clientWidth || 800;
    const h = canvas.height = height;

    ctx.clearRect(0, 0, width, h);

    // Layout: Main chart 65%, Volume 15%, RSI 20%
    const mainHeight = h * 0.62;
    const volTop = mainHeight + 10;
    const volHeight = h * 0.15;
    const rsiTop = volTop + volHeight + 10;
    const rsiHeight = h - rsiTop - 25;

    const paddingRight = 65;
    const chartWidth = width - paddingRight;

    // Price scaling
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let maxVol = 0;

    candles.forEach(c => {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
      if (c.volume > maxVol) maxVol = c.volume;
    });

    // Add padding to price range
    const pricePadding = (maxPrice - minPrice) * 0.05 || 1;
    minPrice -= pricePadding;
    maxPrice += pricePadding;
    const priceRange = maxPrice - minPrice || 1;

    const candleCount = candles.length;
    const candleWidth = Math.max(2, (chartWidth / candleCount) * 0.7);
    const candleSpacing = chartWidth / candleCount;

    // Draw Grid Lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const y = (mainHeight / gridSteps) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(chartWidth, y);
      ctx.stroke();

      const priceVal = maxPrice - (priceRange / gridSteps) * i;
      ctx.fillStyle = '#64748b';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(priceVal.toFixed(priceVal > 100 ? 2 : 4), chartWidth + 6, y + 4);
    }

    // Draw Support & Resistance Lines
    resistanceLevels.forEach(res => {
      if (res >= minPrice && res <= maxPrice) {
        const y = mainHeight - ((res - minPrice) / priceRange) * mainHeight;
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ef4444';
        ctx.fillText(`R: ${res.toFixed(2)}`, chartWidth + 6, y + 3);
      }
    });

    supportLevels.forEach(sup => {
      if (sup >= minPrice && sup <= maxPrice) {
        const y = mainHeight - ((sup - minPrice) / priceRange) * mainHeight;
        ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#22c55e';
        ctx.fillText(`S: ${sup.toFixed(2)}`, chartWidth + 6, y + 3);
      }
    });

    // Draw EMA Lines if available
    const drawLine = (data: number[] | undefined, color: string, width = 1.5) => {
      if (!data || data.length === 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let started = false;

      for (let i = 0; i < candleCount; i++) {
        const val = data[i];
        if (val && !isNaN(val) && val >= minPrice && val <= maxPrice) {
          const x = i * candleSpacing + candleSpacing / 2;
          const y = mainHeight - ((val - minPrice) / priceRange) * mainHeight;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    };

    if (indicators) {
      drawLine(indicators.bollingerBands?.upper, 'rgba(56, 189, 248, 0.25)', 1);
      drawLine(indicators.bollingerBands?.lower, 'rgba(56, 189, 248, 0.25)', 1);
      drawLine(indicators.ema9, '#38bdf8', 1.5); // Sky blue EMA 9
      drawLine(indicators.ema21, '#fbbf24', 1.5); // Amber EMA 21
      drawLine(indicators.ema50, '#a855f7', 1.5); // Purple EMA 50
      drawLine(indicators.ema200, '#f43f5e', 2); // Rose EMA 200
    }

    // Draw Candlesticks & Volume
    for (let i = 0; i < candleCount; i++) {
      const c = candles[i];
      const x = i * candleSpacing + candleSpacing / 2;
      const isBull = c.close >= c.open;
      const color = isBull ? '#10b981' : '#f43f5e';

      // 1. Wicks
      const yHigh = mainHeight - ((c.high - minPrice) / priceRange) * mainHeight;
      const yLow = mainHeight - ((c.low - minPrice) / priceRange) * mainHeight;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // 2. Candle Body
      const yOpen = mainHeight - ((c.open - minPrice) / priceRange) * mainHeight;
      const yClose = mainHeight - ((c.close - minPrice) / priceRange) * mainHeight;
      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));

      ctx.fillStyle = color;
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);

      // 3. Volume Bar
      const vHeight = maxVol > 0 ? (c.volume / maxVol) * volHeight : 0;
      const vTop = volTop + volHeight - vHeight;
      ctx.fillStyle = isBull ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)';
      ctx.fillRect(x - candleWidth / 2, vTop, candleWidth, vHeight);
    }

    // Draw RSI Subgraph (14)
    if (indicators?.rsi14) {
      // RSI Bounds (0 - 100, 70 line, 30 line)
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      const y70 = rsiTop + rsiHeight * 0.3;
      const y30 = rsiTop + rsiHeight * 0.7;

      ctx.beginPath();
      ctx.moveTo(0, y70);
      ctx.lineTo(chartWidth, y70);
      ctx.moveTo(0, y30);
      ctx.lineTo(chartWidth, y30);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.fillText('70', chartWidth + 6, y70 + 3);
      ctx.fillText('30', chartWidth + 6, y30 + 3);

      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let startedRsi = false;

      for (let i = 0; i < candleCount; i++) {
        const rsiVal = indicators.rsi14[i];
        if (rsiVal && !isNaN(rsiVal)) {
          const x = i * candleSpacing + candleSpacing / 2;
          const y = rsiTop + (1 - rsiVal / 100) * rsiHeight;
          if (!startedRsi) {
            ctx.moveTo(x, y);
            startedRsi = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
    }

    // Crosshair hover
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < candleCount) {
      const hoverX = hoverIndex * candleSpacing + candleSpacing / 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hoverX, 0);
      ctx.lineTo(hoverX, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [candles, indicators, supportLevels, resistanceLevels, height, hoverIndex]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const chartWidth = canvas.width - 65;
    const candleSpacing = chartWidth / candles.length;
    const idx = Math.floor(x / candleSpacing);

    if (idx >= 0 && idx < candles.length) {
      setHoverIndex(idx);
      setHoveredCandle(candles[idx]);
    } else {
      setHoverIndex(null);
      setHoveredCandle(null);
    }
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
    setHoveredCandle(null);
  };

  const latestCandle = hoveredCandle || candles[candles.length - 1];

  return (
    <div className="relative w-full bg-[#0d121d] border border-slate-800 rounded-xl p-4">
      {/* Top Header & Legend */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 text-xs border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-4">
          <span className="font-bold text-sm text-slate-100">{symbol}</span>
          {latestCandle && (
            <div className="flex items-center gap-3 font-mono text-xs">
              <span className="text-slate-400">O: <span className="text-slate-200">{latestCandle.open}</span></span>
              <span className="text-slate-400">H: <span className="text-emerald-400">{latestCandle.high}</span></span>
              <span className="text-slate-400">L: <span className="text-rose-400">{latestCandle.low}</span></span>
              <span className="text-slate-400">C: <span className={latestCandle.close >= latestCandle.open ? 'text-emerald-400' : 'text-rose-400'}>{latestCandle.close}</span></span>
              <span className="text-slate-400">Vol: <span className="text-slate-200">{latestCandle.volume.toLocaleString()}</span></span>
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#38bdf8]"></span>EMA 9</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#fbbf24]"></span>EMA 21</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#a855f7]"></span>EMA 50</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#f43f5e]"></span>EMA 200</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#eab308]"></span>RSI 14</span>
        </div>
      </div>

      <div className="w-full overflow-x-hidden">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="w-full cursor-crosshair block"
          style={{ height: `${height}px` }}
        />
      </div>
    </div>
  );
};
