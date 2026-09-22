const crypto = require('crypto');

const API_ROOT = 'https://api.gateio.ws';
const BROKER_ID = 'astro';
const SPOT_ACCOUNT = 'SPOT';
const CROSSEX_ACCOUNT = 'CROSSEX';
const GATE_CROSSEX_ACCOUNT = 'CROSSEX_GATE';
const TRANSFER_VENUES = {
  BINANCE: 'bn', OKX: 'ok', GATE: 'gt', BYBIT: 'by', KRAKEN: 'kr',
  HYPERLIQUID: 'hl', DERIBIT: 'db', LIGHTER: 'lt',
};
const SPOT_USDC_VENUES = new Set(['HYPERLIQUID', 'LIGHTER']);
const FUTURE_VENUES = new Set(Object.keys(TRANSFER_VENUES));
const SPOT_TRADE_VENUES = new Set(['BINANCE', 'OKX', 'GATE', 'BYBIT', 'DERIBIT']);
const QUOTE_COINS = new Set(['USDT', 'USDC', 'USD']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  const data = error?.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  const label = data?.label ? String(data.label) : '';
  const message = data?.message || data?.msg || data?.detail || error?.message || String(error);
  if (label && message && !String(message).includes(label)) return `${label}: ${message}`;
  return String(message || 'unknown error');
}

function buildQuery(params) {
  const entries = Object.entries(params || {})
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => [String(key), String(value)]);
  return {
    signQuery: entries.map(([key, value]) => `${key}=${value}`).join('&'),
    urlQuery: entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&'),
  };
}

async function gateRequest(keys, method, apiPath, { signQuery = '', urlQuery = '', body = undefined, broker = false } = {}) {
  const bodyText = body == null ? '' : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha512').update(bodyText).digest('hex');
  const sign = crypto.createHmac('sha512', keys.S)
    .update(`${method}\n${apiPath}\n${signQuery}\n${bodyHash}\n${timestamp}`)
    .digest('hex');
  const response = await fetch(`${API_ROOT}${apiPath}${urlQuery ? `?${urlQuery}` : ''}`, {
    method,
    headers: {
      KEY: keys.K,
      Timestamp: String(timestamp),
      SIGN: sign,
      Accept: 'application/json',
      ...(bodyText ? { 'Content-Type': 'application/json' } : {}),
      ...(broker ? { 'X-Gate-Channel-Id': BROKER_ID } : {}),
    },
    body: bodyText || undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(errorText({ data, message: text || response.status }));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function plainAmount(value, maxDecimals = 20) {
  const raw = String(value ?? '').trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [intPart, fracPart = ''] = raw.split('.');
  const normalizedInt = intPart.replace(/^0+(?=\d)/, '') || '0';
  const trimmedFrac = fracPart.slice(0, maxDecimals).replace(/0+$/, '');
  return trimmedFrac ? `${normalizedInt}.${trimmedFrac}` : normalizedInt;
}

function floorAmount(value, precision) {
  if (!Number.isInteger(precision) || precision < 0 || precision > 20) return null;
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [intPart, fracPart = ''] = raw.split('.');
  const normalizedInt = intPart.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFrac = fracPart.slice(0, precision).replace(/0+$/, '');
  return normalizedFrac ? `${normalizedInt}.${normalizedFrac}` : normalizedInt;
}

function requireKeys(keys) {
  if (!keys?.K || !keys?.S) throw new Error('请先填写 API Key 和 API Secret');
}

async function fetchAccount(keys) {
  requireKeys(keys);
  let account;
  try {
    account = await gateRequest(keys, 'GET', '/api/v4/crossex/accounts');
  } catch (error) {
    if (String(error?.data?.label || '').toUpperCase() === 'QUERY_INVALID_EXCHANGE_TYPE') {
      throw new Error('GC Panel 仅支持跨所保证金模式（CROSS_EXCHANGE）');
    }
    throw error;
  }
  if (!account) throw new Error('账户响应为空');
  if (String(account.account_mode || '').toUpperCase() === 'ISOLATED_EXCHANGE') {
    throw new Error('GC Panel 仅支持跨所保证金模式（CROSS_EXCHANGE）');
  }
  return account;
}

function parsePortfolio(account, positions) {
  const spot = {};
  const spotAvailable = {};
  const future = {};
  for (const asset of Array.isArray(account?.assets) ? account.assets : []) {
    const amount = Number(asset?.balance);
    const availableAmount = Number(asset?.available_balance);
    const coin = String(asset?.coin || '').trim().toUpperCase();
    const exchange = String(asset?.exchange_type || 'CROSSEX').trim().toUpperCase();
    if (!coin || !exchange) continue;
    const key = `${exchange}:${coin}`;
    if (Number.isFinite(amount) && Math.abs(amount) > 1e-8) spot[key] = (spot[key] || 0) + amount;
    if (Number.isFinite(availableAmount)) spotAvailable[key] = (spotAvailable[key] || 0) + availableAmount;
  }
  for (const position of Array.isArray(positions) ? positions : []) {
    const parts = String(position?.symbol || '').trim().toUpperCase().split('_');
    if (parts.length < 4 || parts[1] !== 'FUTURE') continue;
    const exchange = parts[0];
    const quote = parts[parts.length - 1];
    const base = parts.slice(2, -1).join('_');
    const signedQty = Number(position?.position_qty);
    if (!exchange || !base || !quote || !Number.isFinite(signedQty) || Math.abs(signedQty) <= 1e-8) continue;
    const rawSide = String(position?.position_side || '').trim().toUpperCase();
    const side = rawSide === 'LONG' || rawSide === 'SHORT' ? rawSide : (signedQty < 0 ? 'SHORT' : 'LONG');
    const display = `${exchange}:${base}/${quote}`;
    const qtyKey = `${display}-${side}`;
    future[qtyKey] = (future[qtyKey] || 0) + Math.abs(signedQty);
    const marginMode = String(position?.margin_mode || '').trim().toLowerCase();
    if (marginMode === 'cross' || marginMode === 'isolated') future[`${qtyKey}-MARGIN_MODE`] = marginMode;
    const markPrice = Number(position?.mark_price ?? position?.entry_price);
    if (Number.isFinite(markPrice) && markPrice > 0) future[`${display}-PRICE`] = markPrice;
  }
  const positionMode = String(account?.position_mode || '').trim().toUpperCase();
  return {
    spot,
    spotAvailable,
    future,
    futureMargin: Number(account?.available_margin) || 0,
    positionMode: positionMode === 'SINGLE' || positionMode === 'DUAL' ? positionMode : '',
  };
}

async function portfolio(keys) {
  const [account, positions] = await Promise.all([
    fetchAccount(keys),
    gateRequest(keys, 'GET', '/api/v4/crossex/positions'),
  ]);
  return parsePortfolio(account, positions);
}

function parseTransferSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/^([A-Z]+):([A-Z0-9._-]+)$/);
  if (!match || !TRANSFER_VENUES[match[1]]) throw new Error(`不支持的划转资产：${value}`);
  const venue = match[1];
  const coin = match[2];
  if (SPOT_USDC_VENUES.has(venue) && coin !== 'USDC') throw new Error(`${venue} 只支持划转 USDC`);
  if (venue === 'KRAKEN' && coin !== 'USDT') throw new Error('Kraken 划转只支持 USDT');
  if (venue === 'GATE') throw new Error('GATE 资产已经在目标账户');
  return {
    venue,
    coin,
    symbol: `${venue}:${coin}`,
    from: `CROSSEX_${venue}`,
    to: SPOT_USDC_VENUES.has(venue) ? SPOT_ACCOUNT : GATE_CROSSEX_ACCOUNT,
  };
}

async function fetchCoinMeta(keys, coin) {
  const normalizedCoin = String(coin || '').trim().toUpperCase();
  const { signQuery, urlQuery } = buildQuery({ coin: normalizedCoin });
  const rows = await gateRequest(keys, 'GET', '/api/v4/crossex/transfers/coin', { signQuery, urlQuery });
  const row = (Array.isArray(rows) ? rows : []).find((item) => String(item?.coin || '').toUpperCase() === normalizedCoin);
  if (!row) throw new Error(`${normalizedCoin} 划转规则不可用`);
  const minAmount = plainAmount(row.min_trans_amount);
  const fee = plainAmount(row.est_fee);
  const precision = Number(row.precision);
  if (!minAmount || fee == null || !Number.isInteger(precision)) throw new Error(`${normalizedCoin} 划转规则无效`);
  return { coin: normalizedCoin, minAmount, fee, precision, disabled: Number(row.is_disabled) !== 0 };
}

async function transferMeta(keys, symbol) {
  const transfer = parseTransferSymbol(symbol);
  const coinMeta = await fetchCoinMeta(keys, transfer.coin);
  let fee = coinMeta.fee;
  if (transfer.venue === 'LIGHTER') fee = '0';
  return { ...transfer, ...coinMeta, fee };
}

async function accountTransferMeta(keys) {
  return fetchCoinMeta(keys, 'USDT');
}

async function topUpMeta(keys, venue) {
  const coinMeta = await fetchCoinMeta(keys, 'USDC');
  const fee = venue === 'HYPERLIQUID' ? '0.05' : coinMeta.fee;
  return {
    symbol: `${venue}:USDC`,
    venue,
    coin: 'USDC',
    from: SPOT_ACCOUNT,
    to: `CROSSEX_${venue}`,
    ...coinMeta,
    fee,
  };
}

function normalizeAmount(amount, meta) {
  if (meta?.disabled) throw new Error(`Gate 当前已暂停 ${meta.coin} 划转`);
  const submitted = floorAmount(amount, Number(meta.precision));
  if (!submitted || Number(submitted) <= 0) throw new Error('数量无效');
  if (Number(submitted) < Number(meta.minAmount)) {
    throw new Error(`数量不能低于 ${meta.minAmount} ${meta.coin}（含手续费 ${meta.fee}）`);
  }
  return submitted;
}

async function pollTransfer(keys, text) {
  let last = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const query = `order_id=${encodeURIComponent(text)}`;
    const rows = await gateRequest(keys, 'GET', '/api/v4/crossex/transfers', { signQuery: query, urlQuery: query });
    const record = (Array.isArray(rows) ? rows : []).find((item) => String(item?.text || '') === text || String(item?.id || '') === text);
    if (record) {
      last = record;
      const status = String(record.status || '').toUpperCase();
      if (status === 'SUCCESS' || status === 'FAIL') return record;
    }
    if (attempt < 7) await sleep(1000);
  }
  return last;
}

async function executeTransfer(keys, transfer, amount, meta) {
  const submitted = normalizeAmount(amount, meta);
  const text = `t-${TRANSFER_VENUES[transfer.venue] || 'ce'}-${transfer.from === SPOT_ACCOUNT ? 'dp' : 'wd'}-${crypto.randomBytes(9).toString('hex')}`;
  const postBody = { coin: transfer.coin, amount: submitted, from: transfer.from, to: transfer.to, text };
  let txId = '';
  try {
    const posted = await gateRequest(keys, 'POST', '/api/v4/crossex/transfers', { body: postBody });
    txId = String(posted?.tx_id || '');
  } catch (error) {
    if (error.status >= 400 && error.status < 500) throw new Error(`划转失败：${errorText(error)}`);
    return {
      ...transfer, amount: submitted, fee: meta.fee, minAmount: meta.minAmount, precision: meta.precision,
      status: 'PENDING', actualReceive: '', failReason: `无法确认划转结果：${errorText(error)}`, txId, text,
    };
  }
  const record = await pollTransfer(keys, text).catch(() => null);
  const rawStatus = String(record?.status || 'PENDING').toUpperCase();
  return {
    symbol: transfer.symbol,
    venue: transfer.venue,
    coin: transfer.coin,
    amount: submitted,
    from: transfer.from,
    to: transfer.to,
    fee: meta.fee,
    minAmount: meta.minAmount,
    precision: meta.precision,
    status: rawStatus === 'SUCCESS' || rawStatus === 'FAIL' ? rawStatus : 'PENDING',
    actualReceive: plainAmount(record?.actual_receive) || '',
    failReason: String(record?.fail_reason || ''),
    txId: String(record?.id || txId),
    text,
  };
}

function accountTransferRoute(direction) {
  if (direction === 'spot-to-crossex') return { symbol: 'CROSSEX:USDT', venue: 'CROSSEX', coin: 'USDT', from: SPOT_ACCOUNT, to: CROSSEX_ACCOUNT };
  if (direction === 'crossex-to-spot') return { symbol: 'CROSSEX:USDT', venue: 'CROSSEX', coin: 'USDT', from: CROSSEX_ACCOUNT, to: SPOT_ACCOUNT };
  throw new Error('划转方向无效');
}

function normalizePositive(value, label = '数量') {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${label}无效`);
  const [integer, fraction = ''] = raw.split('.');
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.slice(0, 16).replace(/0+$/, '');
  const normalized = normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
  if (/^0(?:\.0*)?$/.test(normalized)) throw new Error(`${label}无效`);
  return normalized;
}

async function convertQuote(keys, symbol, direction, amount) {
  requireKeys(keys);
  const transfer = parseTransferSymbol(symbol);
  if (transfer.coin !== 'USDC' && transfer.coin !== 'USD') throw new Error('目前只支持 USDC / USD 兑换');
  if (direction !== 'spot-to-venue' && direction !== 'venue-to-spot') throw new Error('兑换方向无效');
  const fromCoin = direction === 'venue-to-spot' ? transfer.coin : 'USDT';
  const toCoin = direction === 'venue-to-spot' ? 'USDT' : transfer.coin;
  const fromAmount = normalizePositive(amount);
  const data = await gateRequest(keys, 'POST', '/api/v4/crossex/convert/quote', {
    body: { exchange_type: transfer.venue, from_coin: fromCoin, to_coin: toCoin, from_amount: fromAmount },
  });
  return {
    exchangeType: transfer.venue,
    direction,
    symbol: transfer.symbol,
    fromAsset: direction === 'venue-to-spot' ? transfer.symbol : 'CROSSEX:USDT',
    toAsset: direction === 'venue-to-spot' ? 'CROSSEX:USDT' : transfer.symbol,
    quoteId: String(data?.quote_id || ''),
    validMs: String(data?.valid_ms || ''),
    fromCoin,
    toCoin,
    fromAmount: String(data?.from_amount || fromAmount),
    toAmount: String(data?.to_amount || ''),
    price: String(data?.price || ''),
  };
}

async function convertOrder(keys, quote) {
  requireKeys(keys);
  const quoteId = String(quote?.quoteId || '').trim();
  if (!quoteId) throw new Error('缺少报价');
  try {
    const data = await gateRequest(keys, 'POST', '/api/v4/crossex/convert/orders', { body: { quote_id: quoteId }, broker: true });
    return { ...quote, status: 'SUCCESS', orderId: String(data?.order_id || ''), text: String(data?.text || ''), failReason: '' };
  } catch (error) {
    if (error.status >= 400 && error.status < 500) throw new Error(`兑换失败：${errorText(error)}`);
    return { ...quote, status: 'UNKNOWN', orderId: '', text: '', failReason: `无法确认兑换结果：${errorText(error)}` };
  }
}

async function krakenWithdraw(keys, amount) {
  requireKeys(keys);
  const fromAmount = normalizePositive(amount);
  if (Number(fromAmount) > 10) throw new Error('Kraken USD 单笔不能超过 10');
  const quote = await gateRequest(keys, 'POST', '/api/v4/crossex/convert/quote', {
    body: { exchange_type: 'KRAKEN', from_coin: 'USD', to_coin: 'USDT', from_amount: fromAmount },
  });
  const snapshot = {
    exchangeType: 'KRAKEN',
    direction: 'withdraw',
    fromAsset: 'KRAKEN:USD',
    toAsset: 'CROSSEX:USDT',
    quoteId: String(quote?.quote_id || ''),
    fromAmount: String(quote?.from_amount || fromAmount),
    toAmount: String(quote?.to_amount || ''),
    price: String(quote?.price || ''),
  };
  try {
    const order = await gateRequest(keys, 'POST', '/api/v4/crossex/convert/orders', { body: { quote_id: snapshot.quoteId }, broker: true });
    return { ...snapshot, status: 'SUCCESS', orderId: String(order?.order_id || ''), text: String(order?.text || ''), failReason: '' };
  } catch (error) {
    if (error.status >= 400 && error.status < 500) throw new Error(`提取失败：${errorText(error)}`);
    return { ...snapshot, status: 'UNKNOWN', orderId: '', text: '', failReason: `无法确认提取结果：${errorText(error)}` };
  }
}

function futureSymbol(value) {
  const match = /^([A-Z]+):([^\s/:]+)\/([A-Z0-9]+)$/.exec(String(value || '').trim().toUpperCase());
  if (!match || !FUTURE_VENUES.has(match[1])) throw new Error(`合约代码无效：${value}`);
  return `${match[1]}_FUTURE_${match[2]}_${match[3]}`;
}

async function reducePosition(keys, coin, size, side) {
  requireKeys(keys);
  const positionSide = String(side || '').trim().toUpperCase();
  if (positionSide !== 'LONG' && positionSide !== 'SHORT') throw new Error('方向无效');
  const qty = Number(size);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('数量无效');
  const symbol = futureSymbol(coin);
  const postBody = {
    text: `t-gcx-close-${crypto.randomBytes(6).toString('hex')}`,
    symbol,
    side: positionSide === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    time_in_force: 'IOC',
    qty: qty.toFixed(12).replace(/\.?0+$/, ''),
    position_side: positionSide,
  };
  if (!symbol.startsWith('HYPERLIQUID_FUTURE_')) postBody.reduce_only = 'true';
  const placed = await gateRequest(keys, 'POST', '/api/v4/crossex/orders', { body: postBody, broker: true });
  const orderId = String(placed?.order_id || postBody.text);
  let last = placed;
  for (const delay of [100, 200, 400, 800, 1200]) {
    await sleep(delay);
    try {
      last = await gateRequest(keys, 'GET', `/api/v4/crossex/orders/${encodeURIComponent(postBody.text)}`);
      const state = String(last?.state || '').toUpperCase();
      if (['FILLED', 'FAIL', 'REJECT', 'CANCELED', 'CANCELLED', 'EXPIRED'].includes(state)) break;
    } catch { /* 短轮询允许瞬时查不到 */ }
  }
  const state = String(last?.state || '').toUpperCase();
  if (state === 'FAIL' || state === 'REJECT') throw new Error(last?.reason || `平仓失败：${state}`);
  return last || { orderId };
}

async function placeOrder(keys, payload) {
  requireKeys(keys);
  const symbol = String(payload?.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]+_(FUTURE|SPOT)_[A-Z0-9]+_[A-Z0-9]+$/.test(symbol)) throw new Error('交易对无效');
  const side = String(payload?.side || '').trim().toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('方向无效');
  const type = String(payload?.type || '').trim().toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
  const qty = Number(payload?.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('数量无效');
  const reduceOnly = payload?.reduceOnly === true;
  const future = symbol.includes('_FUTURE_');
  const postBody = {
    text: `t-gcx-${reduceOnly ? 'close' : 'open'}-${crypto.randomBytes(6).toString('hex')}`,
    symbol,
    side,
    type,
    time_in_force: type === 'MARKET' ? 'IOC' : 'GTC',
    qty: qty.toFixed(12).replace(/\.?0+$/, ''),
  };
  if (future) {
    const positionSide = String(payload?.positionSide || '').trim().toUpperCase();
    if (positionSide !== 'LONG' && positionSide !== 'SHORT') throw new Error('方向无效');
    postBody.position_side = positionSide;
    if (reduceOnly && !symbol.startsWith('HYPERLIQUID_FUTURE_')) postBody.reduce_only = 'true';
  }
  if (type === 'LIMIT') {
    const price = String(payload?.price || '').trim();
    if (!/^\d+(?:\.\d+)?$/.test(price) || Number(price) <= 0) throw new Error('价格无效');
    postBody.price = price;
  }
  const placed = await gateRequest(keys, 'POST', '/api/v4/crossex/orders', { body: postBody, broker: true });
  const orderId = String(placed?.order_id || postBody.text);
  let last = placed;
  for (const delay of [100, 200, 400, 800, 1200]) {
    await sleep(delay);
    try {
      last = await gateRequest(keys, 'GET', `/api/v4/crossex/orders/${encodeURIComponent(postBody.text)}`);
      const state = String(last?.state || '').toUpperCase();
      if (['FILLED', 'FAIL', 'REJECT', 'CANCELED', 'CANCELLED', 'EXPIRED'].includes(state)) break;
    } catch { /* 短轮询允许瞬时查不到 */ }
  }
  const state = String(last?.state || '').toUpperCase();
  if (state === 'FAIL' || state === 'REJECT') throw new Error(last?.reason || `下单失败：${state}`);
  return { orderId, state, reduceOnly: postBody.reduce_only === 'true' };
}

async function adjustMargin(keys, coin, amount, side, action) {
  requireKeys(keys);
  const match = /^HYPERLIQUID:([A-Z0-9_]+)\/([A-Z0-9]+)$/.exec(String(coin || '').trim().toUpperCase());
  if (!match) throw new Error('只支持 Hyperliquid 逐仓调整保证金');
  const symbol = `HYPERLIQUID_FUTURE_${match[1]}_${match[2]}`;
  const requestedSide = String(side || '').trim().toUpperCase();
  const { signQuery, urlQuery } = buildQuery({ symbol });
  const rows = await gateRequest(keys, 'GET', '/api/v4/crossex/positions', { signQuery, urlQuery });
  const position = (Array.isArray(rows) ? rows : []).find((item) => (
    String(item?.symbol || '').toUpperCase() === symbol
    && String(item?.position_side || '').toUpperCase() === requestedSide
  ));
  if (!position) throw new Error('找不到对应持仓');
  if (String(position.margin_mode || '').toUpperCase() !== 'ISOLATED') throw new Error('全仓不支持增减保证金');
  const raw = String(amount ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) < 0.01) throw new Error('保证金至少 0.01，最多 2 位小数');
  const margin = action === 'remove' ? `-${raw.replace(/^0+(?=\d)/, '')}` : raw.replace(/^0+(?=\d)/, '');
  return gateRequest(keys, 'POST', '/api/v4/crossex/positions/margin', {
    body: { symbol, margin, position_side: requestedSide },
  });
}

function decimalParts(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [integer, fraction = ''] = raw.split('.');
  return { integer: BigInt(`${integer}${fraction}` || '0'), scale: fraction.length };
}

function floorToStep(value, step) {
  const valueParts = decimalParts(value);
  const stepParts = decimalParts(step);
  if (!valueParts || !stepParts || stepParts.integer <= 0n) return '';
  const scale = Math.max(valueParts.scale, stepParts.scale);
  const factor = (exp) => 10n ** BigInt(exp);
  const valueInteger = valueParts.integer * factor(scale - valueParts.scale);
  const stepInteger = stepParts.integer * factor(scale - stepParts.scale);
  const floored = (valueInteger / stepInteger) * stepInteger;
  const text = floored.toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale) || '0';
  const frac = scale ? text.slice(text.length - scale).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}

async function clearSpot(keys, coin, size) {
  requireKeys(keys);
  const match = String(coin || '').trim().toUpperCase().match(/^([A-Z]+):([A-Z0-9]+)$/);
  if (!match) throw new Error('现货代码应为 VENUE:COIN');
  const [, venue, asset] = match;
  if (QUOTE_COINS.has(asset)) throw new Error(`${asset} 是计价币，不能卖出`);
  if (!SPOT_TRADE_VENUES.has(venue)) throw new Error(`${venue} 不支持现货卖出`);
  const symbol = `${venue}_SPOT_${asset}_USDT`;
  const { signQuery, urlQuery } = buildQuery({ symbols: symbol });
  const rules = await fetch(`${API_ROOT}/api/v4/crossex/rule/symbols?${urlQuery}`).then((response) => response.json());
  const rule = (Array.isArray(rules) ? rules : []).find((item) => String(item?.symbol || '').toUpperCase() === symbol);
  if (!rule || rule.state !== 'live') throw new Error(`${symbol} 当前不可交易`);
  const qty = floorToStep(size, rule.lot_size || rule.min_size || '0.00000001');
  if (!qty || Number(qty) <= 0) throw new Error('数量低于最小步长');
  const placed = await gateRequest(keys, 'POST', '/api/v4/crossex/orders', {
    broker: true,
    body: {
      text: `t-gcx-spot-${crypto.randomBytes(6).toString('hex')}`,
      symbol,
      side: 'SELL',
      type: 'MARKET',
      time_in_force: 'IOC',
      qty,
    },
  });
  return { executedSize: placed?.executed_qty || qty, orderId: placed?.order_id || '' };
}

function asRows(data) {
  return Array.isArray(data) ? data : [];
}

function mapOrder(row) {
  return {
    orderId: String(row?.order_id || ''),
    text: String(row?.text || row?.client_order_id || ''),
    state: String(row?.state || ''),
    symbol: String(row?.symbol || ''),
    side: String(row?.side || ''),
    type: String(row?.type || ''),
    exchangeType: String(row?.exchange_type || ''),
    businessType: String(row?.business_type || ''),
    qty: String(row?.qty || ''),
    price: String(row?.price || ''),
    executedQty: String(row?.executed_qty || ''),
    executedAvgPrice: String(row?.executed_avg_price || ''),
    reduceOnly: String(row?.reduce_only || '') === 'true',
    positionSide: String(row?.position_side || ''),
    createTime: String(row?.create_time || ''),
    updateTime: String(row?.update_time || ''),
    reason: String(row?.reason || ''),
  };
}

function mapTrade(row) {
  return {
    tradeId: String(row?.transaction_id || ''),
    orderId: String(row?.order_id || ''),
    symbol: String(row?.symbol || ''),
    exchangeType: String(row?.exchange_type || ''),
    side: String(row?.side || ''),
    qty: String(row?.qty || ''),
    price: String(row?.price || ''),
    fee: String(row?.fee || ''),
    feeCoin: String(row?.fee_coin || ''),
    rpnl: String(row?.rpnl || ''),
    positionSide: String(row?.position_side || ''),
    createTime: String(row?.create_time || ''),
  };
}

async function listOpenOrders(keys) {
  requireKeys(keys);
  return asRows(await gateRequest(keys, 'GET', '/api/v4/crossex/open_orders')).map(mapOrder);
}

async function listHistoryOrders(keys, payload) {
  requireKeys(keys);
  const { signQuery, urlQuery } = buildQuery({
    page: payload?.page || 1,
    limit: Math.min(100, Number(payload?.limit) || 50),
  });
  return asRows(await gateRequest(keys, 'GET', '/api/v4/crossex/history_orders', { signQuery, urlQuery })).map(mapOrder);
}

async function listHistoryTrades(keys, payload) {
  requireKeys(keys);
  const { signQuery, urlQuery } = buildQuery({
    page: payload?.page || 1,
    limit: Math.min(100, Number(payload?.limit) || 50),
  });
  return asRows(await gateRequest(keys, 'GET', '/api/v4/crossex/history_trades', { signQuery, urlQuery })).map(mapTrade);
}

async function cancelOrder(keys, payload) {
  requireKeys(keys);
  const orderId = String(payload?.orderId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(orderId)) throw new Error('订单号无效');
  return gateRequest(keys, 'DELETE', `/api/v4/crossex/orders/${encodeURIComponent(orderId)}`);
}

// funding_info 官方 1 rps，且不按 symbol 过滤才和 astro-server 一致。
// 全量缓存后按合约取 funding_interval（秒）。Kraken/HL/Deribit/Lighter 的报价币和页面上的 USDT 别名不同。
const FUNDING_INFO_TTL_MS = 2 * 60 * 1000;
const FUNDING_INFO_MIN_INTERVAL_MS = 1100;
const FUNDING_INFO_BACKOFF_MS = 20 * 1000;
const FUNDING_QUOTE_ALIAS = { KRAKEN: 'USD', HYPERLIQUID: 'USDC', DERIBIT: 'USDC', LIGHTER: 'USDC' };
let fundingBook = null;
let fundingBookAt = 0;
let fundingInflight = null;
let fundingBackoffUntil = 0;
let lastFundingInfoAt = 0;

function fundingRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.data)) return data.data;
  if (data && typeof data === 'object' && (data.symbol || data.funding_interval != null)) return [data];
  return [];
}

function lookupFundingInterval(book, symbol) {
  if (book.has(symbol)) return book.get(symbol);
  const match = symbol.match(/^([A-Z0-9]+)_FUTURE_([A-Z0-9]+)_([A-Z0-9]+)$/);
  const alias = match ? FUNDING_QUOTE_ALIAS[match[1]] : '';
  if (!alias || match[3] === alias) return null;
  const mapped = `${match[1]}_FUTURE_${match[2]}_${alias}`;
  return book.has(mapped) ? book.get(mapped) : null;
}

async function loadFundingBook(keys) {
  const now = Date.now();
  if (fundingBook && now - fundingBookAt < FUNDING_INFO_TTL_MS) return fundingBook;
  if (fundingInflight) return fundingInflight;
  if (now < fundingBackoffUntil && fundingBook) return fundingBook;

  fundingInflight = (async () => {
    const wait = FUNDING_INFO_MIN_INTERVAL_MS - (Date.now() - lastFundingInfoAt);
    if (wait > 0) await sleep(wait);
    lastFundingInfoAt = Date.now();
    try {
      const rows = await gateRequest(keys, 'GET', '/api/v4/crossex/market/funding_info');
      const book = new Map();
      for (const item of fundingRows(rows)) {
        const symbol = String(item?.symbol || '').trim().toUpperCase();
        if (!symbol || item?.funding_interval == null || item.funding_interval === '') continue;
        book.set(symbol, item.funding_interval);
      }
      if (book.size === 0) throw new Error('没有资金周期');
      fundingBook = book;
      fundingBookAt = Date.now();
      fundingBackoffUntil = 0;
      return book;
    } catch (error) {
      if (error?.status === 429) {
        fundingBackoffUntil = Date.now() + FUNDING_INFO_BACKOFF_MS;
        if (fundingBook) return fundingBook;
      }
      throw error;
    } finally {
      fundingInflight = null;
    }
  })();
  return fundingInflight;
}

const actions = {
  portfolio,
  transferMeta: (keys, payload) => transferMeta(keys, payload.symbol),
  accountTransferMeta,
  hlTopUpMeta: (keys) => topUpMeta(keys, 'HYPERLIQUID'),
  lighterTopUpMeta: (keys) => topUpMeta(keys, 'LIGHTER'),
  withdraw: async (keys, payload) => {
    const meta = await transferMeta(keys, payload.symbol);
    return executeTransfer(keys, meta, payload.amount, meta);
  },
  accountTransfer: async (keys, payload) => {
    const meta = await accountTransferMeta(keys);
    return executeTransfer(keys, accountTransferRoute(payload.direction), payload.amount, meta);
  },
  hlTopUp: async (keys, payload) => {
    const meta = await topUpMeta(keys, 'HYPERLIQUID');
    return executeTransfer(keys, meta, payload.amount, meta);
  },
  lighterTopUp: async (keys, payload) => {
    const meta = await topUpMeta(keys, 'LIGHTER');
    return executeTransfer(keys, meta, payload.amount, meta);
  },
  krakenWithdraw: (keys, payload) => krakenWithdraw(keys, payload.amount),
  convertQuote: (keys, payload) => convertQuote(keys, payload.symbol, payload.direction, payload.amount),
  convertOrder: (keys, payload) => convertOrder(keys, payload.quote),
  reduce: (keys, payload) => reducePosition(keys, payload.coin, payload.size, payload.side),
  placeOrder: (keys, payload) => placeOrder(keys, payload),
  openOrders: (keys) => listOpenOrders(keys),
  historyOrders: (keys, payload) => listHistoryOrders(keys, payload),
  historyTrades: (keys, payload) => listHistoryTrades(keys, payload),
  cancelOrder: (keys, payload) => cancelOrder(keys, payload),
  fundingInfo: async (keys, payload) => {
    if (!keys?.K || !keys?.S) throw new Error('还没有填写 API');
    const symbol = String(payload?.symbol || '').trim().toUpperCase();
    if (!symbol) throw new Error('缺少合约');
    const book = await loadFundingBook(keys);
    const seconds = lookupFundingInterval(book, symbol);
    if (seconds == null) throw new Error('没有这个合约的资金周期');
    return { fundingInterval: String(seconds) };
  },
  clearSpot: (keys, payload) => clearSpot(keys, payload.coin, payload.size),
  adjustMargin: (keys, payload) => adjustMargin(keys, payload.coin, payload.amount, payload.side, payload.action),
};

async function callGate(keys, action, payload) {
  const handler = actions[action];
  if (!handler) throw new Error(`未知操作：${action}`);
  return handler(keys, payload || {});
}

module.exports = { callGate };
