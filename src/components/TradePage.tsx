import { useEffect, useMemo, useRef, useState } from 'react';
import { PriceChart } from './PriceChart';
import {
  INTERVALS,
  VENUE_ICONS,
  VENUES,
  loadCatalog,
  parseSymbol,
  symbolOf,
  watchMarket,
  type BookLevel,
  type Candle,
  type CandleInterval,
  type CatalogSymbol,
  type MarketKind,
  type Ticker,
  type TradeTick,
  type Venue,
} from '../market';
import { loadCandleHistory, mergeCandles } from '../candleHistory';
import { loadFundingIntervalHours } from '../fundingInterval';
import {
  cancelOrder,
  getHistoryOrders,
  getHistoryTrades,
  getOpenOrders,
  placeOrder,
  type GateOrderRow,
  type GateTradeRow,
} from '../gateApi';
import type { FutureLeg } from '../positions';
import { formatNumberPretty } from '../positions';

type BottomTab = 'positions' | 'open' | 'history' | 'fills';

function pairLabel(asset: string, quote: string, kind: MarketKind) {
  return kind === 'SPOT' ? `${asset}/${quote} 现货` : `${asset}${quote} 永续`;
}

function defaultQuote(venue: Venue) {
  if (venue === 'HYPERLIQUID' || venue === 'LIGHTER' || venue === 'DERIBIT') return 'USDC';
  if (venue === 'KRAKEN') return 'USD';
  return 'USDT';
}

function contractLabel(symbol: string) {
  const parsed = parseSymbol(symbol);
  if (!parsed) return symbol;
  return parsed.kind === 'SPOT' ? `${parsed.asset}/${parsed.quote}` : `${parsed.asset}${parsed.quote}`;
}

function VenueMark({ venue }: { venue: string }) {
  const file = VENUE_ICONS[venue as Venue];
  if (!file) return <i className={`venue-icon venue-${venue.toLowerCase()}`}>{venue.slice(0, 1)}</i>;
  return <img className="venue-icon" src={`./${file}`} alt="" />;
}

function priceText(value: string | number | null | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function tickDecimals(tick: string | null | undefined) {
  const fraction = tick?.split('.')[1]?.replace(/0+$/, '') ?? '';
  return fraction.length;
}

function fixedPrice(value: string | number | null | undefined, digits: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const negative = n < 0;
  const [whole, fraction] = Math.abs(n).toFixed(digits).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction == null ? grouped : `${grouped}.${fraction}`;
  return negative ? `-${body}` : body;
}

function clock(ts: number) {
  const date = new Date(ts > 10_000_000_000 ? ts : ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function countdown(target: number | null, now: number) {
  if (!target) return '—';
  const ms = target > 10_000_000_000 ? target - now : target * 1000 - now;
  if (ms <= 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function dateTime(ts: string | number | null | undefined) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const date = new Date(n > 10_000_000_000 ? n : n * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function orderStateLabel(state: string) {
  const key = state.toUpperCase();
  if (key === 'NEW') return '待提交';
  if (key === 'OPEN') return '挂单中';
  if (key === 'PARTIALLY_FILLED') return '部分成交';
  if (key === 'FILLED') return '完全成交';
  if (key === 'FAIL') return '失败';
  if (key === 'REJECT') return '拒绝';
  if (key === 'CANCELED' || key === 'CANCELLED') return '已撤销';
  if (key === 'EXPIRED') return '已过期';
  return state || '—';
}

function orderSideLabel(order: GateOrderRow) {
  const side = order.side.toUpperCase() === 'BUY' ? '买' : '卖';
  const type = order.type.toUpperCase() === 'LIMIT' ? '限价' : '市价';
  const reduce = order.reduceOnly ? ' · 减仓' : '';
  return `${side} · ${type}${reduce}`;
}

function orderPriceLabel(order: GateOrderRow) {
  if (order.type.toUpperCase() === 'MARKET' || !(Number(order.price) > 0)) return '市价';
  return priceText(order.price);
}

export function TradePage({
  legs,
  loggedIn,
  theme,
  onOpenAssets,
  onCloseLeg,
  onRefreshPositions,
}: {
  legs: FutureLeg[];
  loggedIn: boolean;
  theme: 'dark' | 'light';
  onOpenAssets: () => void;
  onCloseLeg: (leg: FutureLeg) => void; // 切到资产页继续平仓
  onRefreshPositions: () => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<CatalogSymbol[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [venue, setVenue] = useState<Venue>('BINANCE');
  const [asset, setAsset] = useState('BTC');
  const [quote, setQuote] = useState('USDT');
  const [kind, setKind] = useState<MarketKind>('FUTURE');
  const [venueOpen, setVenueOpen] = useState(false);
  const [assetQuery, setAssetQuery] = useState('');
  const [assetOpen, setAssetOpen] = useState(false);
  const [interval, setInterval] = useState<CandleInterval>('1m');
  const [bookTab, setBookTab] = useState<'book' | 'trades'>('book');
  const [bottomTab, setBottomTab] = useState<BottomTab>('positions');
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [bids, setBids] = useState<BookLevel[]>([]);
  const [asks, setAsks] = useState<BookLevel[]>([]);
  const [trades, setTrades] = useState<TradeTick[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [now, setNow] = useState(Date.now());
  const [side, setSide] = useState<'open' | 'close'>('open');
  const [orderType, setOrderType] = useState<'Limit' | 'Market'>('Limit');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState('');
  const [fundingHours, setFundingHours] = useState<number | null>(null);
  const [openOrders, setOpenOrders] = useState<GateOrderRow[]>([]);
  const [historyOrders, setHistoryOrders] = useState<GateOrderRow[]>([]);
  const [historyTrades, setHistoryTrades] = useState<GateTradeRow[]>([]);
  const [ordersReady, setOrdersReady] = useState(false);
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);
  const [panelUpdatedAt, setPanelUpdatedAt] = useState('');
  const [panelRefreshing, setPanelRefreshing] = useState(false);
  const exchangeRef = useRef<HTMLDivElement>(null);
  const assetRef = useRef<HTMLDivElement>(null);

  const symbol = symbolOf(venue, asset, quote, kind);
  const positionCount = legs.filter((leg) => leg.direction).length;

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const pull = (force: boolean) => {
      loadCatalog(force).then((rows) => {
        if (cancelled) return;
        setCatalog(rows);
        setCatalogReady(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => pull(true), 5 * 60 * 1000);
      }).catch(() => {
        if (cancelled) return;
        setCatalogReady(false);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => pull(true), 15_000);
      });
    };
    pull(false);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!venueOpen && !assetOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (venueOpen && exchangeRef.current && !exchangeRef.current.contains(target)) setVenueOpen(false);
      if (assetOpen && assetRef.current && !assetRef.current.contains(target)) {
        setAssetOpen(false);
        setAssetQuery('');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [venueOpen, assetOpen]);

  useEffect(() => {
    setCandles([]);
    setTrades([]);
    setTicker(null);
    setPrice('');
    const stop = watchMarket({
      symbol,
      interval,
      onStatus: () => undefined,
      onTicker: (next) => {
        setTicker(next);
        setPrice((current) => current || next.lastPrice);
      },
      onBook: (nextBids, nextAsks) => {
        setBids(nextBids);
        setAsks(nextAsks);
      },
      onTrade: (trade) => setTrades((current) => [trade, ...current].slice(0, 20)),
      onCandle: (candle, candleInterval) => {
        if (candleInterval !== interval) return;
        setCandles((current) => {
          const next = current.filter((item) => item.time !== candle.time);
          next.push(candle);
          next.sort((a, b) => a.time - b.time);
          return next.slice(-500);
        });
      },
    });
    return stop;
  }, [symbol, interval]);

  useEffect(() => {
    let cancelled = false;
    loadCandleHistory(symbol, interval).then((history) => {
      if (!cancelled) setCandles((current) => mergeCandles(history, current));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [symbol, interval]);

  useEffect(() => {
    if (kind !== 'FUTURE') {
      setFundingHours(null);
      return;
    }
    let cancelled = false;
    setFundingHours(null);
    loadFundingIntervalHours(symbol).then((hours) => {
      if (!cancelled) setFundingHours(hours);
    }).catch(() => {
      if (!cancelled) setFundingHours(null);
    });
    return () => { cancelled = true; };
  }, [symbol, kind]);

  async function refreshOrders(includeHistory = true) {
    if (!loggedIn || !window.panel) {
      setOpenOrders([]);
      setHistoryOrders([]);
      setHistoryTrades([]);
      setOrdersReady(false);
      setPanelUpdatedAt('');
      return;
    }
    const openResp = await getOpenOrders();
    if (openResp.code === 0) setOpenOrders(openResp.data || []);
    if (includeHistory) {
      const [historyResp, fillsResp] = await Promise.all([getHistoryOrders(50), getHistoryTrades(50)]);
      if (historyResp.code === 0) setHistoryOrders(historyResp.data || []);
      if (fillsResp.code === 0) setHistoryTrades(fillsResp.data || []);
    }
    setOrdersReady(true);
    setPanelUpdatedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
  }

  async function refreshPanel() {
    if (!loggedIn || panelRefreshing) return;
    setPanelRefreshing(true);
    try {
      await Promise.all([onRefreshPositions(), refreshOrders(true)]);
    } catch {
      setOrdersReady(true);
    } finally {
      setPanelRefreshing(false);
    }
  }

  useEffect(() => {
    if (!loggedIn) {
      setOpenOrders([]);
      setHistoryOrders([]);
      setHistoryTrades([]);
      setOrdersReady(false);
      setPanelUpdatedAt('');
      return;
    }
    let cancelled = false;
    const pull = (includeHistory: boolean) => {
      refreshOrders(includeHistory).catch(() => {
        if (!cancelled) setOrdersReady(true);
      });
    };
    pull(true);
    const timer = window.setInterval(() => pull(false), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    if (bottomTab !== 'history' && bottomTab !== 'fills') return;
    void refreshOrders(true).catch(() => undefined);
  }, [bottomTab, loggedIn]);

  const venuePairs = useMemo(() => {
    const pairs: { asset: string; quote: string; kind: MarketKind }[] = [];
    const seen = new Set<string>();
    for (const item of catalog) {
      const parsed = parseSymbol(item.symbol);
      if (!parsed || parsed.venue !== venue) continue;
      const key = `${parsed.kind}:${parsed.asset}:${parsed.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(parsed);
    }
    pairs.sort((a, b) => a.asset.localeCompare(b.asset) || a.quote.localeCompare(b.quote) || (a.kind === b.kind ? 0 : a.kind === 'FUTURE' ? -1 : 1));
    return pairs;
  }, [catalog, venue]);

  const assetOptions = useMemo(() => {
    const query = assetQuery.trim().toUpperCase();
    if (!catalogReady) return [];
    if (!query) {
      const quote = defaultQuote(venue);
      const preferred = venuePairs.filter((pair) => pair.asset === 'BTC' && pair.quote === quote && pair.kind === 'FUTURE');
      if (preferred.length) return preferred;
      const anyBtc = venuePairs.filter((pair) => pair.asset === 'BTC' && pair.kind === 'FUTURE');
      if (anyBtc.length) return anyBtc;
      return venuePairs.slice(0, 40);
    }
    const rank = (item: { asset: string; quote: string }) => {
      if (item.asset === query) return 0;
      if (item.asset.startsWith(query)) return 1;
      return 2;
    };
    return venuePairs
      .filter((item) => item.asset.includes(query) || `${item.asset}${item.quote}`.includes(query) || `${item.asset}/${item.quote}`.includes(query))
      .sort((a, b) => rank(a) - rank(b) || a.asset.localeCompare(b.asset) || a.quote.localeCompare(b.quote))
      .slice(0, 40);
  }, [assetQuery, catalogReady, venue, venuePairs]);

  const maxSize = Math.max(1, ...bids.map((l) => l.size), ...asks.map((l) => l.size));
  const priceDigits = useMemo(() => {
    const row = catalog.find((item) => item.symbol === symbol);
    return row ? tickDecimals(row.tick_size) : null;
  }, [catalog, symbol]);
  const marketPrice = (value: string | number | null | undefined) => priceDigits == null ? priceText(value) : fixedPrice(value, priceDigits);
  const funding = Number(ticker?.fundingRate ?? 0);
  const total = orderType === 'Market'
    ? Number(amount) * Number(ticker?.lastPrice || 0)
    : Number(amount) * Number(price || 0);

  function pickAsset(next: { asset: string; quote: string; kind: MarketKind }) {
    setAsset(next.asset);
    setQuote(next.quote);
    setKind(next.kind);
    setAssetOpen(false);
    setAssetQuery('');
  }

  function pickVenue(next: Venue) {
    setVenue(next);
    setVenueOpen(false);
    const preferred = catalog.find((item) => item.symbol === symbolOf(next, asset, quote, kind))
      || catalog.find((item) => item.symbol === symbolOf(next, asset, defaultQuote(next), kind))
      || catalog.find((item) => item.symbol === symbolOf(next, asset, 'USDT', kind))
      || catalog.find((item) => item.symbol === symbolOf(next, asset, 'USDC', kind))
      || catalog.find((item) => {
        const parsed = parseSymbol(item.symbol);
        return parsed?.venue === next && parsed.asset === asset;
      });
    if (preferred) {
      const parsed = parseSymbol(preferred.symbol);
      if (parsed) {
        setQuote(parsed.quote);
        setKind(parsed.kind);
      }
    } else {
      setQuote(defaultQuote(next));
    }
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 4200);
  }

  async function submitOrder(orderSide: 'BUY' | 'SELL', positionSide: 'LONG' | 'SHORT', reduceOnly: boolean) {
    const qty = Number(amount);
    if (!Number.isFinite(qty) || qty <= 0) {
      notify('请填写数量');
      return;
    }
    if (orderType === 'Limit' && !(Number(price) > 0)) {
      notify('请填写价格');
      return;
    }
    if (!window.panel) {
      notify('请在应用窗口里使用已保存的 API 下单');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await placeOrder({
        symbol,
        side: orderSide,
        positionSide,
        type: orderType === 'Limit' ? 'LIMIT' : 'MARKET',
        qty: amount.trim(),
        price: price.trim(),
        reduceOnly,
      });
      if (resp.code !== 0) throw new Error(resp.message || '下单失败');
      notify(resp.data?.orderId ? `已提交 ${resp.data.orderId}` : '已提交');
      setAmount('');
      void refreshOrders(true).catch(() => undefined);
    } catch (error) {
      notify(error instanceof Error ? error.message : '下单失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancelOrder(order: GateOrderRow) {
    if (!order.orderId || cancellingIds.includes(order.orderId)) return;
    setCancellingIds((current) => [...current, order.orderId]);
    try {
      const resp = await cancelOrder(order.orderId);
      if (resp.code !== 0) throw new Error(resp.message || '撤单失败');
      notify(`已撤销 ${order.orderId}`);
      void refreshOrders(true).catch(() => undefined);
    } catch (error) {
      notify(error instanceof Error ? error.message : '撤单失败');
    } finally {
      setCancellingIds((current) => current.filter((id) => id !== order.orderId));
    }
  }

  return (
    <div className="workspace">
      <section className="market-header">
        <div className="exchange-control" ref={exchangeRef}>
          <button
            className={`exchange-selector${venueOpen ? ' open' : ''}`}
            onClick={() => {
              setVenueOpen((open) => !open);
              setAssetOpen(false);
              setAssetQuery('');
            }}
          >
            <VenueMark venue={venue} />
            <strong>{venue}</strong>
            <i className="pair-chevron" />
          </button>
          {venueOpen && (
            <div className="exchange-menu">
              <header><span>交易所</span></header>
              <div className="exchange-menu-list">
                {VENUES.map((item) => (
                  <button key={item} className={item === venue ? 'selected' : ''} onClick={() => pickVenue(item)}>
                    <VenueMark venue={item} />
                    <span><strong>{item}</strong></span>
                    {item === venue && <svg className="exchange-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.2 6.3 11.2 12.8 4.6" /></svg>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="pair-title" ref={assetRef}>
          <button
            className={`pair-button${assetOpen ? ' open' : ''}`}
            onClick={() => {
              setAssetOpen((open) => !open);
              setVenueOpen(false);
            }}
          >
            <strong>{kind === 'SPOT' ? `${asset}/${quote}` : `${asset}${quote}`}</strong>
            <span className="pair-kind">{kind === 'SPOT' ? '现货' : '永续'}</span>
            <i className="pair-chevron" />
          </button>
          {assetOpen && (
            <div className="asset-menu">
              <input autoFocus value={assetQuery} placeholder="搜索资产" onChange={(event) => setAssetQuery(event.target.value.toUpperCase())} />
              <ul>
                {assetOptions.map((item) => (
                  <li key={`${item.kind}-${item.asset}-${item.quote}`}><button onClick={() => pickAsset(item)}>{pairLabel(item.asset, item.quote, item.kind)}</button></li>
                ))}
                {assetOptions.length === 0 && (
                  <li className="muted">
                    {catalogReady
                      ? (assetQuery ? `这个交易所没有 ${assetQuery}` : `这个交易所没有 BTC${defaultQuote(venue)} 永续`)
                      : '行情目录还在加载'}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
        <div className="headline-price">
          <strong>{marketPrice(ticker?.lastPrice)}</strong>
        </div>
        <dl className="market-stats">
          <div><dt>24h 高</dt><dd className="stat-num">{marketPrice(ticker?.high24h)}</dd></div>
          <div><dt>24h 低</dt><dd className="stat-num">{marketPrice(ticker?.low24h)}</dd></div>
          <div><dt>24h 额</dt><dd>{ticker?.quoteVolume24h ? `$${(Number(ticker.quoteVolume24h) / 1_000_000).toFixed(2)}M` : '—'}</dd></div>
          {kind === 'FUTURE' && <div><dt>{`资金费率(${fundingHours ?? '-'}h)/倒计时`}</dt><dd><span className={funding >= 0 ? 'positive' : 'negative'}>{(funding * 100).toFixed(4)}%</span> · {countdown(ticker?.nextFundingAt ?? null, now)}</dd></div>}
        </dl>
      </section>

      <section className="terminal-grid">
        <div className="chart-panel terminal-panel">
          <div className="panel-tabs">
            <button className="active">图表</button>
          </div>
          <div className="chart-toolbar">
            {INTERVALS.map((item) => (
              <button key={item} className={interval === item ? 'active' : ''} onClick={() => setInterval(item)}>{item}</button>
            ))}
            <span className="toolbar-divider" />
            <span className="live-market">实时 K 线</span>
          </div>
          <div className="ohlc">
            <span>O {priceText(candles.at(-1)?.open)}</span>
            <span>H {priceText(candles.at(-1)?.high)}</span>
            <span>L {priceText(candles.at(-1)?.low)}</span>
            <span>C {priceText(candles.at(-1)?.close)}</span>
          </div>
          <PriceChart candles={candles} theme={theme} />
        </div>

        <aside className="orderbook-panel terminal-panel">
          <div className="panel-tabs">
            <button className={bookTab === 'book' ? 'active' : ''} onClick={() => setBookTab('book')}>订单表</button>
            <button className={bookTab === 'trades' ? 'active' : ''} onClick={() => setBookTab('trades')}>最新成交</button>
          </div>
          {bookTab === 'book' && (
            <>
              <div className="book-head"><span>价格 ({quote})</span><span>数量</span></div>
              {asks.length === 0 && bids.length === 0 && <div className="book-empty">还没有订单</div>}
              <div className="book-rows asks">
                {asks.slice(0, 10).reverse().map((level) => (
                  <div key={level.price} style={{ ['--depth' as string]: `${Math.min(100, (level.size / maxSize) * 100)}%` }}>
                    <span>{marketPrice(level.price)}</span><span>{formatNumberPretty(level.size)}</span>
                  </div>
                ))}
              </div>
              <div className="mid-price"><strong>{marketPrice(ticker?.lastPrice)}</strong></div>
              <div className="book-rows bids">
                {bids.slice(0, 10).map((level) => (
                  <div key={level.price} style={{ ['--depth' as string]: `${Math.min(100, (level.size / maxSize) * 100)}%` }}>
                    <span>{marketPrice(level.price)}</span><span>{formatNumberPretty(level.size)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {bookTab === 'trades' && (
            <>
              <div className="book-head trades-head"><span>时间</span><span>成交价</span><span>数量({asset})</span></div>
              {trades.length === 0 && <div className="book-empty">还没有最新成交</div>}
              <div className="book-rows trades-list">
                {trades.map((trade) => (
                  <div key={trade.id} className={trade.side === 'BUY' ? 'trade-buy' : 'trade-sell'}>
                    <span>{clock(trade.ts)}</span>
                    <span className="trade-price">{marketPrice(trade.price)}</span>
                    <span>{formatNumberPretty(trade.size)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>

        <aside className="order-panel terminal-panel">
          <div className="trade-side-tabs">
            {kind === 'SPOT' ? (
              <>
                <button className={side === 'open' ? 'active buy' : ''} onClick={() => setSide('open')}>买入</button>
                <button className={side === 'close' ? 'active sell' : ''} onClick={() => setSide('close')}>卖出</button>
              </>
            ) : (
              <>
                <button className={side === 'open' ? 'active' : ''} onClick={() => setSide('open')}>开仓</button>
                <button className={side === 'close' ? 'active' : ''} onClick={() => setSide('close')}>平仓</button>
              </>
            )}
          </div>
          <div className="ticket-toolbar">
            <div className="order-type-tabs">
              {(['Limit', 'Market'] as const).map((type) => (
                <button key={type} className={orderType === type ? 'active' : ''} onClick={() => setOrderType(type)}>{type === 'Limit' ? '限价' : '市价'}</button>
              ))}
            </div>
          </div>
          {orderType === 'Limit' && (
            <label className="trade-input"><span>价格</span><input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" /><b>{quote}</b></label>
          )}
          <label className="trade-input"><span>数量</span><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /><b>{asset}</b></label>
          <label className="trade-input total"><span>金额</span><input value={Number.isFinite(total) && total > 0 ? total.toFixed(2) : ''} readOnly /><b>{quote}</b></label>
          {kind !== 'SPOT' && side === 'close' && <p className="order-hint">平仓单会带 reduceOnly</p>}
          <div className={`order-actions${kind === 'SPOT' ? ' single' : ''}`}>
            {kind === 'SPOT' ? (
              <button
                className={`submit-order ${side === 'open' ? 'buy' : 'sell'}`}
                disabled={submitting}
                onClick={() => void submitOrder(side === 'open' ? 'BUY' : 'SELL', 'LONG', false)}
              >
                <strong>{side === 'open' ? '买入' : '卖出'}</strong>
              </button>
            ) : side === 'open' ? (
              <>
                <button className="submit-order buy" disabled={submitting} onClick={() => void submitOrder('BUY', 'LONG', false)}><strong>开多</strong></button>
                <button className="submit-order sell" disabled={submitting} onClick={() => void submitOrder('SELL', 'SHORT', false)}><strong>开空</strong></button>
              </>
            ) : (
              <>
                <button className="submit-order buy" disabled={submitting} onClick={() => void submitOrder('BUY', 'SHORT', true)}><strong>平空</strong></button>
                <button className="submit-order sell" disabled={submitting} onClick={() => void submitOrder('SELL', 'LONG', true)}><strong>平多</strong></button>
              </>
            )}
          </div>
          <div className="order-summary">
            <div><dt>账户操作</dt><dd><button onClick={onOpenAssets}>打开资产</button></dd></div>
          </div>
        </aside>
      </section>

      <section className="positions-panel">
        <div className="positions-head">
          <div className="panel-tabs">
            <button className={bottomTab === 'positions' ? 'active' : ''} onClick={() => setBottomTab('positions')}>合约持仓({positionCount})</button>
            <button className={bottomTab === 'open' ? 'active' : ''} onClick={() => setBottomTab('open')}>当前委托({openOrders.length})</button>
            <button className={bottomTab === 'history' ? 'active' : ''} onClick={() => setBottomTab('history')}>历史委托</button>
            <button className={bottomTab === 'fills' ? 'active' : ''} onClick={() => setBottomTab('fills')}>历史成交</button>
          </div>
          <div className="positions-meta">
            <span className="positions-updated">{panelUpdatedAt ? `更新于 ${panelUpdatedAt}` : '尚未刷新'}</span>
            <button className="positions-refresh" disabled={!loggedIn || panelRefreshing} onClick={() => void refreshPanel()}>
              {panelRefreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
        </div>
        {bottomTab === 'positions' && (
          <>
            {!loggedIn && <div className="empty-state"><strong>还没有填写 API</strong><p>保存 Key 和 Secret 后，这里显示 GC Panel 合约持仓。</p></div>}
            {loggedIn && legs.length === 0 && <div className="empty-state"><strong>没有合约持仓</strong><p>现货余额和划转在资产页。</p></div>}
            {loggedIn && legs.length > 0 && (
              <div className="table-wrap positions-table">
                <table>
                  <thead>
                    <tr><th>合约</th><th>方向</th><th>数量</th><th>价格</th><th>保证金模式</th><th /></tr>
                  </thead>
                  <tbody>
                    {legs.filter((leg) => leg.direction).map((leg) => (
                      <tr key={`${leg.key}-${leg.side}`}>
                        <td><strong>{leg.displayKey}</strong></td>
                        <td><small className={leg.direction === '多' ? 'long-tag' : 'short-tag'}>{leg.direction}</small></td>
                        <td>{leg.value}</td>
                        <td>{leg.unitPrice == null ? '—' : priceText(leg.unitPrice)}</td>
                        <td>{leg.marginMode || '—'}</td>
                        <td><button className="row-action close-position-action" onClick={() => onCloseLeg(leg)}>平仓</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {bottomTab === 'open' && (
          <>
            {!loggedIn && <div className="empty-state"><strong>还没有填写 API</strong><p>保存 Key 后可查看当前委托。</p></div>}
            {loggedIn && !ordersReady && <div className="empty-state"><strong>加载中</strong><p>正在读取当前委托。</p></div>}
            {loggedIn && ordersReady && openOrders.length === 0 && <div className="empty-state"><strong>没有当前委托</strong><p>限价单挂上后会出现在这里。</p></div>}
            {loggedIn && openOrders.length > 0 && (
              <div className="table-wrap positions-table">
                <table>
                  <thead>
                    <tr><th>时间</th><th>合约</th><th>交易所</th><th>方向 / 类型</th><th>价格</th><th>数量</th><th>已成交</th><th>状态</th><th>订单 ID</th><th /></tr>
                  </thead>
                  <tbody>
                    {openOrders.map((order) => (
                      <tr key={order.orderId || order.text}>
                        <td>{dateTime(order.createTime || order.updateTime)}</td>
                        <td><strong>{contractLabel(order.symbol)}</strong></td>
                        <td>{order.exchangeType || parseSymbol(order.symbol)?.venue || '—'}</td>
                        <td><small className={order.side.toUpperCase() === 'BUY' ? 'long-tag' : 'short-tag'}>{orderSideLabel(order)}</small></td>
                        <td>{orderPriceLabel(order)}</td>
                        <td>{formatNumberPretty(Number(order.qty))}</td>
                        <td>{formatNumberPretty(Number(order.executedQty))}</td>
                        <td>{orderStateLabel(order.state)}</td>
                        <td className="mono-cell">{order.orderId || order.text || '—'}</td>
                        <td>
                          <button
                            className="row-action close-position-action"
                            disabled={cancellingIds.includes(order.orderId)}
                            onClick={() => void onCancelOrder(order)}
                          >
                            {cancellingIds.includes(order.orderId) ? '撤销中' : '撤单'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {bottomTab === 'history' && (
          <>
            {!loggedIn && <div className="empty-state"><strong>还没有填写 API</strong><p>保存 Key 后可查看历史委托。</p></div>}
            {loggedIn && !ordersReady && <div className="empty-state"><strong>加载中</strong><p>正在读取历史委托。</p></div>}
            {loggedIn && ordersReady && historyOrders.length === 0 && <div className="empty-state"><strong>没有历史委托</strong><p>成交或撤销后会出现在这里。</p></div>}
            {loggedIn && historyOrders.length > 0 && (
              <div className="table-wrap positions-table">
                <table>
                  <thead>
                    <tr><th>时间</th><th>合约</th><th>交易所</th><th>方向 / 类型</th><th>价格</th><th>数量</th><th>已成交</th><th>状态</th><th>订单 ID</th></tr>
                  </thead>
                  <tbody>
                    {historyOrders.map((order) => (
                      <tr key={order.orderId || order.text}>
                        <td>{dateTime(order.createTime || order.updateTime)}</td>
                        <td><strong>{contractLabel(order.symbol)}</strong></td>
                        <td>{order.exchangeType || parseSymbol(order.symbol)?.venue || '—'}</td>
                        <td><small className={order.side.toUpperCase() === 'BUY' ? 'long-tag' : 'short-tag'}>{orderSideLabel(order)}</small></td>
                        <td>{orderPriceLabel(order)}</td>
                        <td>{formatNumberPretty(Number(order.qty))}</td>
                        <td>{formatNumberPretty(Number(order.executedQty))}</td>
                        <td>{orderStateLabel(order.state)}</td>
                        <td className="mono-cell">{order.orderId || order.text || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {bottomTab === 'fills' && (
          <>
            {!loggedIn && <div className="empty-state"><strong>还没有填写 API</strong><p>保存 Key 后可查看历史成交。</p></div>}
            {loggedIn && !ordersReady && <div className="empty-state"><strong>加载中</strong><p>正在读取历史成交。</p></div>}
            {loggedIn && ordersReady && historyTrades.length === 0 && <div className="empty-state"><strong>没有历史成交</strong><p>成交记录会出现在这里。</p></div>}
            {loggedIn && historyTrades.length > 0 && (
              <div className="table-wrap positions-table">
                <table>
                  <thead>
                    <tr><th>时间</th><th>合约</th><th>交易所</th><th>方向</th><th>成交价</th><th>数量</th><th>手续费</th><th>已实现盈亏</th><th>成交 ID</th></tr>
                  </thead>
                  <tbody>
                    {historyTrades.map((fill) => (
                      <tr key={fill.tradeId || `${fill.orderId}-${fill.createTime}`}>
                        <td>{dateTime(fill.createTime)}</td>
                        <td><strong>{contractLabel(fill.symbol)}</strong></td>
                        <td>{fill.exchangeType || parseSymbol(fill.symbol)?.venue || '—'}</td>
                        <td><small className={fill.side.toUpperCase() === 'BUY' ? 'long-tag' : 'short-tag'}>{fill.side.toUpperCase() === 'BUY' ? '买' : '卖'}</small></td>
                        <td>{priceText(fill.price)}</td>
                        <td>{formatNumberPretty(Number(fill.qty))}</td>
                        <td>{`${formatNumberPretty(Number(fill.fee))}${fill.feeCoin ? ` ${fill.feeCoin}` : ''}`}</td>
                        <td className={Number(fill.rpnl) >= 0 ? 'positive' : 'negative'}>{priceText(fill.rpnl)}</td>
                        <td className="mono-cell">{fill.tradeId || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
      {toast && <div className="toast" role="status"><span>i</span><div><strong>交易</strong><p>{toast}</p></div></div>}
    </div>
  );
}
