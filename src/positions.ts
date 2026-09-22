export function formatNumberPretty(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

const isFutureMetaKey = (key: string) => key.endsWith('-PRICE') || key.endsWith('-MARGIN_MODE');

export function assetOf(key: string): string {
  return String(key || '').toUpperCase().split(':').pop() || '';
}

export function isQuoteCoin(key: string): boolean {
  const asset = assetOf(key);
  return asset === 'USDT' || asset === 'USDC' || asset === 'USD';
}

export function isAccountUsdt(key: string): boolean {
  return String(key || '').trim().toUpperCase() === 'CROSSEX:USDT';
}

export function isHyperliquidUsdc(key: string): boolean {
  return String(key || '').trim().toUpperCase() === 'HYPERLIQUID:USDC';
}

export function isLighterUsdc(key: string): boolean {
  return String(key || '').trim().toUpperCase() === 'LIGHTER:USDC';
}

export function isKrakenUsd(key: string): boolean {
  return String(key || '').trim().toUpperCase() === 'KRAKEN:USD';
}

const TRANSFER_VENUES = new Set([
  'BINANCE', 'OKX', 'GATE', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER',
]);

export interface TransferAsset {
  venue: string;
  coin: string;
  symbol: string;
}

export function parseTransferAsset(value: string): TransferAsset | null {
  const symbol = String(value || '').trim().toUpperCase();
  const match = symbol.match(/^([A-Z]+):([A-Z0-9._-]+)$/);
  if (!match || !TRANSFER_VENUES.has(match[1])) return null;
  const [, venue, coin] = match;
  if ((venue === 'HYPERLIQUID' || venue === 'LIGHTER') && coin !== 'USDC') return null;
  if (venue === 'KRAKEN' && coin !== 'USDT') return null;
  if (venue === 'GATE') return null;
  return { venue, coin, symbol: `${venue}:${coin}` };
}

export function isStableConvertAsset(asset: TransferAsset | null): boolean {
  return Boolean(asset) && (asset!.coin === 'USDC' || asset!.coin === 'USD');
}

export interface FutureLeg {
  key: string;
  displayKey: string;
  value: string;
  qty: number;
  direction: '多' | '空' | null;
  side: 'LONG' | 'SHORT' | null;
  marginMode: string | null;
  unitPrice: number | null;
}

export function parseFutureLegs(data: Record<string, unknown> | null | undefined): FutureLeg[] {
  if (!data || typeof data !== 'object') return [];
  const entries = Object.entries(data).filter(([key]) => !isFutureMetaKey(key));
  return entries.map(([rawKey, rawValue]) => {
    let displayKey = rawKey;
    let direction: FutureLeg['direction'] = null;
    let side: FutureLeg['side'] = null;
    if (rawKey.includes('-LONG')) {
      displayKey = rawKey.replace('-LONG', '');
      direction = '多';
      side = 'LONG';
    } else if (rawKey.includes('-SHORT')) {
      displayKey = rawKey.replace('-SHORT', '');
      direction = '空';
      side = 'SHORT';
    }
    const qty = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    const marginModeKey = side ? `${displayKey}-${side}-MARGIN_MODE` : null;
    const priceKey = `${displayKey}-PRICE`;
    const marginMode = marginModeKey && typeof data[marginModeKey] === 'string'
      ? String(data[marginModeKey]).toLowerCase()
      : null;
    const priceRaw = Number(data[priceKey]);
    return {
      key: displayKey,
      displayKey,
      value: Number.isFinite(qty) ? formatNumberPretty(qty) : String(rawValue),
      qty: Number.isFinite(qty) ? qty : 0,
      direction,
      side,
      marginMode,
      unitPrice: Number.isFinite(priceRaw) ? priceRaw : null,
    };
  }).sort((a, b) => {
    const rank = (leg: FutureLeg) => (leg.direction === '多' ? 0 : leg.direction === '空' ? 1 : 2);
    return rank(a) - rank(b);
  });
}

export interface SpotRow {
  key: string;
  amount: number;
  available: number | null;
}

export function parseSpotRows(
  spot: Record<string, number> | null | undefined,
  available: Record<string, number> | undefined,
): SpotRow[] {
  const source: Record<string, number> = { ...(spot || {}) };
  if (!Object.keys(source).some((key) => isAccountUsdt(key))) source['CROSSEX:USDT'] = 0;
  const rows = Object.entries(source).map(([key, value]) => ({
    key,
    amount: typeof value === 'number' ? value : Number(value) || 0,
    available: available && Number.isFinite(Number(available[key])) ? Number(available[key]) : null,
  }));
  rows.sort((a, b) => Number(isAccountUsdt(b.key)) - Number(isAccountUsdt(a.key))
    || Number(isQuoteCoin(b.key)) - Number(isQuoteCoin(a.key))
    || Math.abs(b.amount) - Math.abs(a.amount));
  return rows;
}
