import { parseSymbol, type Candle, type CandleInterval, type MarketKind } from './market';

const STEP: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const OKX_BAR: Record<CandleInterval, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D',
};

const BYBIT_BAR: Record<CandleInterval, string> = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D',
};

const LIMIT = 300;
let lighterMarkets: Map<string, number> | null = null;

async function publicText(url: string, init?: { method: 'POST'; body: string }) {
  if (window.panel) {
    const result = await window.panel.fetchPublic(init ? { url, ...init } : url);
    if (result.status >= 400) throw new Error(`历史 K 线 ${result.status}`);
    return result.text;
  }
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`历史 K 线 ${response.status}`);
  return response.text();
}

function seconds(value: number) {
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function candle(time: number, open: unknown, high: unknown, low: unknown, close: unknown): Candle | null {
  const item = {
    time: seconds(time),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
  };
  if (![item.time, item.open, item.high, item.low, item.close].every((value) => Number.isFinite(value) && value > 0)) return null;
  return item;
}

function finish(rows: Array<Candle | null>) {
  const map = new Map<number, Candle>();
  for (const row of rows) if (row) map.set(row.time, row);
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-LIMIT);
}

function bucket4h(rows: Candle[]) {
  const buckets = new Map<number, Candle>();
  for (const row of rows) {
    const time = Math.floor(row.time / STEP['4h']) * STEP['4h'];
    const prev = buckets.get(time);
    if (!prev) buckets.set(time, { ...row, time });
    else {
      prev.high = Math.max(prev.high, row.high);
      prev.low = Math.min(prev.low, row.low);
      prev.close = row.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function binance(asset: string, quote: string, kind: MarketKind, interval: CandleInterval) {
  const symbol = `${asset}${quote}`;
  const query = `symbol=${symbol}&interval=${interval}&limit=${LIMIT}`;
  const vision = publicText(`https://data-api.binance.vision/api/v3/klines?${query}`);
  const direct = publicText(kind === 'SPOT'
    ? `https://api.binance.com/api/v3/klines?${query}`
    : `https://fapi.binance.com/fapi/v1/klines?${query}`);
  const text = await new Promise<string>((resolve, reject) => {
    let fallback = '';
    const timer = setTimeout(() => { if (fallback) resolve(fallback); }, 1500);
    direct.then((value) => { clearTimeout(timer); resolve(value); }, () => { if (fallback) resolve(fallback); });
    vision.then((value) => { fallback = value; }, reject);
  });
  const rows = JSON.parse(text) as unknown[];
  return finish(rows.map((row) => Array.isArray(row) ? candle(Number(row[0]), row[1], row[2], row[3], row[4]) : null));
}

async function gate(asset: string, quote: string, kind: MarketKind, interval: CandleInterval) {
  const pair = `${asset}_${quote}`;
  const text = kind === 'SPOT'
    ? await publicText(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${LIMIT}`)
    : await publicText(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${pair}&interval=${interval}&limit=${LIMIT}`);
  const rows = JSON.parse(text) as unknown[];
  return finish(rows.map((row) => {
    if (Array.isArray(row)) return candle(Number(row[0]), row[5], row[3], row[4], row[2]);
    if (!row || typeof row !== 'object') return null;
    const item = row as Record<string, unknown>;
    return candle(Number(item.t), item.o, item.h, item.l, item.c);
  }));
}

async function okx(asset: string, quote: string, kind: MarketKind, interval: CandleInterval) {
  const instId = kind === 'SPOT' ? `${asset}-${quote}` : `${asset}-${quote}-SWAP`;
  const text = await publicText(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${OKX_BAR[interval]}&limit=${LIMIT}`);
  const rows = (JSON.parse(text) as { data?: unknown[] }).data || [];
  return finish(rows.map((row) => Array.isArray(row) ? candle(Number(row[0]), row[1], row[2], row[3], row[4]) : null));
}

async function bybit(asset: string, quote: string, kind: MarketKind, interval: CandleInterval) {
  const category = kind === 'SPOT' ? 'spot' : 'linear';
  const symbol = kind === 'FUTURE' && quote === 'USDC' ? `${asset}PERP` : `${asset}${quote}`;
  const text = await publicText(`https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${BYBIT_BAR[interval]}&limit=${LIMIT}`);
  const rows = (JSON.parse(text) as { result?: { list?: unknown[] } }).result?.list || [];
  return finish(rows.map((row) => Array.isArray(row) ? candle(Number(row[0]), row[1], row[2], row[3], row[4]) : null));
}

async function kraken(asset: string, interval: CandleInterval) {
  const base = asset === 'BTC' ? 'XBT' : asset === 'DOGE' ? 'XDG' : asset;
  const text = await publicText(`https://futures.kraken.com/api/charts/v1/trade/PF_${base}USD/${interval}?count=${LIMIT}`);
  const rows = (JSON.parse(text) as { candles?: Record<string, unknown>[] }).candles || [];
  return finish(rows.map((row) => candle(Number(row.time), row.open, row.high, row.low, row.close)));
}

async function hyperliquid(asset: string, interval: CandleInterval) {
  const end = Date.now();
  const start = end - STEP[interval] * LIMIT * 1000;
  const text = await publicText('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: asset, interval, startTime: start, endTime: end } }),
  });
  const rows = JSON.parse(text) as Record<string, unknown>[];
  return finish((Array.isArray(rows) ? rows : []).map((row) => candle(Number(row.t), row.o, row.h, row.l, row.c)));
}

async function deribit(asset: string, interval: CandleInterval) {
  const end = Date.now();
  const resolution = interval === '4h' ? '60' : interval === '1d' ? '1D' : String(STEP[interval] / 60);
  const span = (interval === '4h' ? STEP['1h'] : STEP[interval]) * (interval === '4h' ? LIMIT * 4 : LIMIT) * 1000;
  const text = await publicText(`https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=${asset}_USDC-PERPETUAL&start_timestamp=${end - span}&end_timestamp=${end}&resolution=${resolution}`);
  const result = (JSON.parse(text) as { result?: Record<string, number[]> }).result;
  if (!result?.ticks) return [];
  const rows = finish(result.ticks.map((tick, index) => candle(tick, result.open?.[index], result.high?.[index], result.low?.[index], result.close?.[index])));
  return interval === '4h' ? bucket4h(rows) : rows;
}

async function lighterId(asset: string) {
  if (!lighterMarkets) {
    const text = await publicText('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
    const books = (JSON.parse(text) as { order_books?: { symbol?: string; market_id?: number }[] }).order_books || [];
    lighterMarkets = new Map(books.flatMap((item) => item.symbol && item.market_id != null ? [[item.symbol.toUpperCase(), item.market_id] as const] : []));
  }
  const id = lighterMarkets.get(asset);
  if (id == null) throw new Error('没有 Lighter 行情');
  return id;
}

async function lighter(asset: string, interval: CandleInterval) {
  const id = await lighterId(asset);
  const end = Date.now();
  const start = end - STEP[interval] * LIMIT * 1000;
  const text = await publicText(`https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=${id}&resolution=${interval}&start_timestamp=${start}&end_timestamp=${end}&count_back=${LIMIT}`);
  const payload = JSON.parse(text) as { c?: Record<string, unknown>[]; candles?: Record<string, unknown>[] };
  const rows = payload.c || payload.candles || [];
  return finish(rows.map((row) => candle(Number(row.t), row.o, row.h, row.l, row.c)));
}

export async function loadCandleHistory(symbol: string, interval: CandleInterval): Promise<Candle[]> {
  const parsed = parseSymbol(symbol);
  if (!parsed) return [];
  const { venue, asset, quote, kind } = parsed;
  if (venue === 'BINANCE') return binance(asset, quote, kind, interval);
  if (venue === 'GATE') return gate(asset, quote, kind, interval);
  if (venue === 'OKX') return okx(asset, quote, kind, interval);
  if (venue === 'BYBIT') return bybit(asset, quote, kind, interval);
  if (venue === 'KRAKEN' && kind === 'FUTURE') return kraken(asset, interval);
  if (venue === 'HYPERLIQUID' && kind === 'FUTURE') return hyperliquid(asset, interval);
  if (venue === 'DERIBIT' && kind === 'FUTURE') return deribit(asset, interval);
  if (venue === 'LIGHTER' && kind === 'FUTURE') return lighter(asset, interval);
  return [];
}

export function mergeCandles(history: Candle[], live: Candle[]) {
  const map = new Map<number, Candle>();
  for (const item of history) map.set(item.time, item);
  for (const item of live) map.set(item.time, item);
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-500);
}
