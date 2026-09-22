import { parseSymbol } from './market';

const TTL = 5 * 60 * 1000;
const cache = new Map<string, { hours: number; at: number }>();
const inflight = new Map<string, Promise<number | null>>();

// 这些所的公开接口不给可变周期。astro-server 在 CrossEx 没有 funding_interval 时用这个规格。
const FIXED_HOURS: Record<string, number> = {
  HYPERLIQUID: 1,
  LIGHTER: 1,
  KRAKEN: 1,
  DERIBIT: 8,
};

let binanceInfo: { map: Map<string, number>; at: number } | null = null;
let binanceInflight: Promise<Map<string, number>> | null = null;

async function publicText(url: string) {
  if (window.panel) {
    const result = await window.panel.fetchPublic(url);
    if (result.status >= 400) throw new Error(`资金周期 ${result.status}`);
    return result.text;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`资金周期 ${response.status}`);
  return response.text();
}

// CrossEx funding_interval 单位是秒。整数小时直接用，否则保留一位，和 astro-server 一样。
function hoursFromSeconds(value: unknown): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return hoursFromHours(seconds / 3600);
}

function hoursFromHours(value: unknown): number | null {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return null;
  if (Number.isInteger(hours)) return hours;
  const rounded = Number(hours.toFixed(1));
  return rounded > 0 && rounded <= 24 ? rounded : null;
}

async function crossExHours(symbol: string): Promise<number | null> {
  if (!window.panel) return null;
  const result = await window.panel.gateCall('fundingInfo', { symbol });
  if (!result.ok) return null;
  return hoursFromSeconds((result.data as { fundingInterval?: unknown } | undefined)?.fundingInterval);
}

async function binanceIntervalMap() {
  if (binanceInfo && Date.now() - binanceInfo.at < TTL) return binanceInfo.map;
  if (binanceInflight) return binanceInflight;
  const request = publicText('https://fapi.binance.com/fapi/v1/fundingInfo').then((text) => {
    const rows = JSON.parse(text) as { symbol?: string; fundingIntervalHours?: unknown }[];
    if (!Array.isArray(rows)) throw new Error('资金周期');
    const map = new Map<string, number>();
    for (const row of rows) {
      const hours = hoursFromHours(row.fundingIntervalHours);
      if (row.symbol && hours) map.set(row.symbol, hours);
    }
    binanceInfo = { map, at: Date.now() };
    return map;
  }).finally(() => {
    if (binanceInflight === request) binanceInflight = null;
  });
  binanceInflight = request;
  return request;
}

async function publicHours(venue: string, asset: string, quote: string): Promise<number | null> {
  if (venue === 'BINANCE') {
    // fundingInfo 只列出改过周期或上限的合约。不在列表里就是默认 8 小时。请求失败则不要猜。
    const map = await binanceIntervalMap();
    return map.get(`${asset}${quote}`) ?? 8;
  }
  if (venue === 'OKX') {
    const text = await publicText(`https://www.okx.com/api/v5/public/funding-rate?instId=${asset}-${quote}-SWAP`);
    const row = (JSON.parse(text) as { data?: { fundingTime?: string; nextFundingTime?: string }[] }).data?.[0];
    const current = Number(row?.fundingTime);
    const next = Number(row?.nextFundingTime);
    if (!current || !next || next <= current) return null;
    return hoursFromHours((next - current) / 3_600_000);
  }
  if (venue === 'BYBIT') {
    const symbol = quote === 'USDC' ? `${asset}PERP` : `${asset}${quote}`;
    const text = await publicText(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    const row = (JSON.parse(text) as { result?: { list?: { fundingIntervalHour?: unknown }[] } }).result?.list?.[0];
    return hoursFromHours(row?.fundingIntervalHour);
  }
  if (venue === 'GATE') {
    const settle = quote.toLowerCase();
    const text = await publicText(`https://api.gateio.ws/api/v4/futures/${settle}/contracts/${asset}_${quote}`);
    const row = JSON.parse(text) as { funding_interval?: unknown };
    return hoursFromSeconds(row.funding_interval);
  }
  return FIXED_HOURS[venue] ?? null;
}

async function fetchHours(symbol: string): Promise<number | null> {
  const parsed = parseSymbol(symbol);
  if (!parsed || parsed.kind !== 'FUTURE') return null;
  const fromCrossEx = await crossExHours(symbol).catch(() => null);
  if (fromCrossEx != null) return fromCrossEx;
  return publicHours(parsed.venue, parsed.asset, parsed.quote).catch(() => FIXED_HOURS[parsed.venue] ?? null);
}

export async function loadFundingIntervalHours(symbol: string): Promise<number | null> {
  const parsed = parseSymbol(symbol);
  if (!parsed || parsed.kind !== 'FUTURE') return null;
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.hours;
  const pending = inflight.get(symbol);
  if (pending) return pending;
  const request = fetchHours(symbol).then((hours) => {
    if (hours != null) cache.set(symbol, { hours, at: Date.now() });
    return hours;
  }).finally(() => {
    if (inflight.get(symbol) === request) inflight.delete(symbol);
  });
  inflight.set(symbol, request);
  return request;
}
