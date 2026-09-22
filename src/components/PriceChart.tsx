import { useEffect, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type CandlestickData, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../market';

/** 默认可见蜡烛数；比 fitContent 铺满 300 根更宽松 */
const DEFAULT_VISIBLE_BARS = 72;
const RIGHT_PAD = 6;

function chartTheme() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: pick('--chart-bg') || '#0b1118',
    text: pick('--chart-text') || '#6f7c8f',
    grid: pick('--chart-grid') || '#16202b',
    line: pick('--line') || '#1b2532',
    cross: pick('--chart-cross') || '#3a4a5c',
    up: pick('--green') || '#3ecf8e',
    down: pick('--red') || '#ff6b81',
  };
}

function showRecentBars(chart: IChartApi, length: number) {
  if (length <= 0) return;
  const visible = Math.min(DEFAULT_VISIBLE_BARS, length);
  chart.timeScale().setVisibleLogicalRange({
    from: length - visible,
    to: length + RIGHT_PAD - 1,
  });
}

export function PriceChart({ candles, theme }: { candles: Candle[]; theme: 'dark' | 'light' }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const colors = chartTheme();
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: colors.background }, textColor: colors.text, fontFamily: 'Manrope, sans-serif' },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.line },
      timeScale: {
        borderColor: colors.line,
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 12,
        minBarSpacing: 4,
        rightOffset: RIGHT_PAD,
      },
      crosshair: { vertLine: { color: colors.cross }, horzLine: { color: colors.cross } },
    });
    const series = chart.addCandlestickSeries({
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const colors = chartTheme();
    chart.applyOptions({
      layout: { background: { color: colors.background }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.line },
      timeScale: { borderColor: colors.line },
      crosshair: { vertLine: { color: colors.cross }, horzLine: { color: colors.cross } },
    });
  }, [theme]);

  const count = useRef(0);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const data: CandlestickData[] = candles
      .filter((item) => [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite))
      .map((item) => ({
        time: item.time as UTCTimestamp,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
      }));
    series.setData(data);
    // 首次加载或换品种/周期时重置到最近一段，避免 300 根铺满显得拥挤
    if (count.current === 0 || data.length > count.current + 20 || data.length < count.current - 20) {
      showRecentBars(chart, data.length);
    }
    count.current = data.length;
  }, [candles]);

  return <div className="price-chart" ref={host} />;
}
