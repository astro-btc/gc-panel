export const PUBLIC_WS = 'wss://api.gateio.ws/ws/crossex/public';
export const SYMBOLS_URL = 'https://api.gateio.ws/api/v4/crossex/rule/symbols';

export const VENUES = [
  'BINANCE', 'OKX', 'BYBIT', 'GATE', 'HYPERLIQUID', 'LIGHTER', 'DERIBIT', 'KRAKEN',
] as const;

export type Venue = typeof VENUES[number];

export const VENUE_ICONS: Partial<Record<Venue, string>> = {
  GATE: 'exchange-icons/gate.png',
  BINANCE: 'exchange-icons/binance.png',
  OKX: 'exchange-icons/okx.jpg',
  BYBIT: 'exchange-icons/bybit.png',
  HYPERLIQUID: 'exchange-icons/hl.png',
  LIGHTER: 'exchange-icons/lighter.jpg',
};

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type CandleInterval = typeof INTERVALS[number];

export interface CatalogSymbol {
  symbol: string;
  exchange_type: string;
  business_type: string;
  state: string;
  tick_size: string | null;
  contract_size: string | null;
  default_leverage: string | null;
}

export interface Ticker {
  lastPrice: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  open24h: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string | null;
  quoteVolume24h: string | null;
  fundingRate: string | null;
  nextFundingAt: number | null;
}

export interface BookLevel { price: number; size: number; }
export interface TradeTick { id: string; price: number; size: number; side: 'BUY' | 'SELL'; ts: number; }
export interface Candle { time: number; open: number; high: number; low: number; close: number; }

export type MarketKind = 'FUTURE' | 'SPOT';

export function symbolOf(venue: string, asset: string, quote = 'USDT', kind: MarketKind = 'FUTURE') {
  return `${venue}_${kind}_${asset}_${quote}`;
}

export function parseSymbol(symbol: string): { venue: string; asset: string; quote: string; kind: MarketKind } | null {
  const match = symbol.match(/^([A-Z0-9]+)_(FUTURE|SPOT)_([A-Z0-9]+)_([A-Z0-9]+)$/);
  if (!match) return null;
  return { venue: match[1], asset: match[3], quote: match[4], kind: match[2] as MarketKind };
}

const CATALOG_REFRESH_MS = 5 * 60 * 1000;
let catalogMemory: CatalogSymbol[] | null = null;
let catalogMemoryAt = 0;
let catalogInflight: Promise<CatalogSymbol[]> | null = null;

export async function loadCatalog(force = false): Promise<CatalogSymbol[]> {
  if (!force && catalogMemory && Date.now() - catalogMemoryAt < CATALOG_REFRESH_MS) return catalogMemory;
  if (catalogInflight) return catalogInflight;
  const request = fetchCatalog().then((rows) => {
    catalogMemory = rows;
    catalogMemoryAt = Date.now();
    return rows;
  }).catch((error) => {
    if (catalogMemory) return catalogMemory;
    throw error;
  }).finally(() => {
    if (catalogInflight === request) catalogInflight = null;
  });
  catalogInflight = request;
  return request;
}

async function fetchCatalog(): Promise<CatalogSymbol[]> {
  const loadText = async () => {
    if (window.panel) {
      const result = await window.panel.fetchPublic(SYMBOLS_URL);
      if (result.status >= 400) throw new Error(`行情目录 ${result.status}`);
      return result.text;
    }
    const response = await fetch('/crossex-symbols');
    if (!response.ok) throw new Error(`行情目录 ${response.status}`);
    return response.text();
  };
  const data = JSON.parse(await loadText()) as CatalogSymbol[];
  return data.filter((item) => (item.business_type === 'FUTURE' || item.business_type === 'SPOT') && item.state === 'live');
}

type Listener = {
  symbol: string;
  interval: CandleInterval;
  onTicker: (ticker: Ticker) => void;
  onBook: (bids: BookLevel[], asks: BookLevel[]) => void;
  onTrade: (trade: TradeTick) => void;
  onCandle: (candle: Candle, interval: CandleInterval) => void;
  onStatus: (status: 'connecting' | 'live' | 'offline') => void;
};

let socket: WebSocket | null = null;
let listener: Listener | null = null;
let reconnectTimer = 0;
let seedTimer = 0;
const books = { bids: new Map<string, string>(), asks: new Map<string, string>() };
const pendingBookUpdates: BookUpdate[] = [];
let snapshotChannel: string | null = null;
let bookLimit = 48;
let bookReady = true;

// 订单表只画 10 档。支持的交易所先订一次完整的 10 档；OKX 最多 5，Bybit 最多 1。
// Kraken 没有 order_book_x，保持只吃增量。
const BOOK_SNAPSHOT_LEVEL: Partial<Record<Venue, number>> = {
  BINANCE: 10,
  GATE: 10,
  OKX: 5,
  BYBIT: 1,
  HYPERLIQUID: 10,
  LIGHTER: 10,
  DERIBIT: 10,
};

interface BookUpdate { ts: number; snapshot: boolean; bids: unknown; asks: unknown; }

function bookSnapshotChannel(symbol: string) {
  const venue = parseSymbol(symbol)?.venue as Venue | undefined;
  const level = venue ? BOOK_SNAPSHOT_LEVEL[venue] : undefined;
  return level ? `order_book_${level}` : null;
}

function resetBook(symbol: string) {
  books.bids.clear();
  books.asks.clear();
  pendingBookUpdates.length = 0;
  window.clearTimeout(seedTimer);
  snapshotChannel = bookSnapshotChannel(symbol);
  bookLimit = snapshotChannel ? Number(snapshotChannel.slice('order_book_'.length)) : 48;
  bookReady = !snapshotChannel;
  emitBook();
}

function send(channel: string, payload: string[], event: 'subscribe' | 'unsubscribe' = 'subscribe') {
  if (socket?.readyState !== WebSocket.OPEN || payload.length === 0) return;
  socket.send(JSON.stringify({
    time: Math.floor(Date.now() / 1000),
    event,
    channel,
    payload,
  }));
}

function subscribeAll() {
  if (!listener) return;
  const { symbol, interval } = listener;
  send('ticker', [symbol]);
  send('funding_rate', [symbol]);
  send('order_book_update', [symbol]);
  if (snapshotChannel && !bookReady) {
    send(snapshotChannel, [symbol]);
    window.clearTimeout(seedTimer);
    seedTimer = window.setTimeout(giveUpBookSeed, 3000);
  }
  send('trade', [symbol]);
  send(`kline_${interval}`, [symbol]);
}

function giveUpBookSeed() {
  if (bookReady || !listener) return;
  if (snapshotChannel) send(snapshotChannel, [listener.symbol], 'unsubscribe');
  snapshotChannel = null;
  bookLimit = 48;
  bookReady = true;
  const queued = pendingBookUpdates.splice(0);
  for (const update of queued) applyBookUpdate(update);
  emitBook();
}

function levels(map: Map<string, string>, desc: boolean): BookLevel[] {
  return [...map.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .filter((level) => level.size > 0 && Number.isFinite(level.price))
    .sort((a, b) => desc ? b.price - a.price : a.price - b.price)
    .slice(0, 16);
}

function trimBook(map: Map<string, string>, keepHigh: boolean) {
  if (map.size <= bookLimit) return;
  const ranked = [...map.keys()].sort((a, b) => keepHigh ? Number(b) - Number(a) : Number(a) - Number(b));
  for (const price of ranked.slice(bookLimit)) map.delete(price);
}

function applyBookUpdate(update: BookUpdate) {
  if (update.snapshot) {
    books.bids.clear();
    books.asks.clear();
  }
  applyLevels(books.bids, update.bids);
  applyLevels(books.asks, update.asks);
  trimBook(books.bids, true);
  trimBook(books.asks, false);
}

function seedBook(result: Record<string, unknown>) {
  const channel = snapshotChannel;
  books.bids.clear();
  books.asks.clear();
  applyLevels(books.bids, result.b);
  applyLevels(books.asks, result.a);
  const ts = Number(result.ts) || 0;
  const queued = pendingBookUpdates.splice(0);
  for (const update of queued) {
    if (update.ts < ts) continue;
    applyBookUpdate(update);
  }
  trimBook(books.bids, true);
  trimBook(books.asks, false);
  bookReady = true;
  window.clearTimeout(seedTimer);
  if (channel && listener) send(channel, [listener.symbol], 'unsubscribe');
  emitBook();
}

function emitBook() {
  listener?.onBook(levels(books.bids, true), levels(books.asks, false));
}

function applyLevels(map: Map<string, string>, updates: unknown) {
  if (!Array.isArray(updates)) return;
  for (const level of updates) {
    const price = Array.isArray(level) ? String(level[0]) : '';
    const size = Array.isArray(level) ? String(level[1]) : '';
    if (!price) continue;
    if (Number(size) === 0) map.delete(price);
    else map.set(price, size);
  }
}

const tickerState: Ticker = {
  lastPrice: '', bidPrice: '', bidSize: '', askPrice: '', askSize: '',
  open24h: null, high24h: null, low24h: null, volume24h: null, quoteVolume24h: null,
  fundingRate: null, nextFundingAt: null,
};

function resetTicker() {
  tickerState.lastPrice = '';
  tickerState.bidPrice = '';
  tickerState.askPrice = '';
  tickerState.fundingRate = null;
  tickerState.nextFundingAt = null;
}

function handleFrame(raw: string) {
  if (!listener) return;
  let frame: { channel?: string; event?: string; error?: unknown; result?: Record<string, unknown> };
  try { frame = JSON.parse(raw); } catch { return; }
  if (frame.event === 'subscribe' && snapshotChannel && frame.channel === snapshotChannel) {
    const status = typeof frame.result?.status === 'string' ? frame.result.status : '';
    if (status === 'failed' || frame.error) giveUpBookSeed();
    return;
  }
  if (frame.event !== 'update' || !frame.result) return;
  const result = frame.result;
  if (result.s !== listener.symbol && frame.channel !== `kline_${listener.interval}`) {
    if (typeof result.s === 'string' && result.s !== listener.symbol) return;
  }
  if (frame.channel === 'ticker') {
    Object.assign(tickerState, {
      lastPrice: String(result.lp ?? ''),
      bidPrice: String(result.bp ?? ''),
      bidSize: String(result.bs ?? ''),
      askPrice: String(result.ap ?? ''),
      askSize: String(result.as ?? ''),
      open24h: result.o == null ? tickerState.open24h : String(result.o),
      high24h: result.h == null ? tickerState.high24h : String(result.h),
      low24h: result.l == null ? tickerState.low24h : String(result.l),
      volume24h: result.v == null ? tickerState.volume24h : String(result.v),
      quoteVolume24h: result.q == null ? tickerState.quoteVolume24h : String(result.q),
    });
    listener.onTicker({ ...tickerState });
  } else if (frame.channel === 'funding_rate') {
    tickerState.fundingRate = String(result.r ?? '');
    tickerState.nextFundingAt = Number(result.T) || null;
    listener.onTicker({ ...tickerState });
  } else if (frame.channel === 'order_book_update') {
    const update = {
      ts: Number(result.ts) || 0,
      snapshot: Boolean(result.snapshot),
      bids: result.b,
      asks: result.a,
    };
    if (!bookReady) {
      pendingBookUpdates.push(update);
      if (pendingBookUpdates.length > 100) pendingBookUpdates.shift();
      return;
    }
    applyBookUpdate(update);
    emitBook();
  } else if (snapshotChannel && frame.channel === snapshotChannel) {
    if (!bookReady) seedBook(result);
  } else if (frame.channel === 'trade') {
    listener.onTrade({
      id: String(result.i ?? `${result.ts}-${result.p}`),
      price: Number(result.p),
      size: Number(result.q),
      side: result.S === 'BUY' ? 'BUY' : 'SELL',
      ts: Number(result.ts) || Date.now(),
    });
  } else if (frame.channel?.startsWith('kline_')) {
    const interval = frame.channel.slice('kline_'.length) as CandleInterval;
    const start = Number(result.t);
    listener.onCandle({
      time: start > 10_000_000_000 ? Math.floor(start / 1000) : start,
      open: Number(result.o),
      high: Number(result.h),
      low: Number(result.l),
      close: Number(result.c),
    }, interval);
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  listener?.onStatus('connecting');
  const next = new WebSocket(PUBLIC_WS);
  socket = next;
  next.onopen = () => {
    if (listener) resetBook(listener.symbol);
    listener?.onStatus('live');
    subscribeAll();
  };
  next.onmessage = (event) => handleFrame(String(event.data));
  next.onclose = () => {
    if (socket === next) socket = null;
    if (!listener) return;
    listener.onStatus('offline');
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 1500);
  };
  next.onerror = () => next.close();
}

export function watchMarket(next: Listener) {
  const changed = !listener || listener.symbol !== next.symbol || listener.interval !== next.interval;
  listener = next;
  if (changed) {
    resetBook(next.symbol);
    resetTicker();
    listener.onBook([], []);
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  }
  if (!socket || socket.readyState === WebSocket.CLOSED) connect();
  else if (socket.readyState === WebSocket.OPEN) subscribeAll();
  return () => {
    if (listener !== next) return;
    listener = null;
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(seedTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  };
}
