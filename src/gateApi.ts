export interface ApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

export interface PositionData {
  spot: Record<string, number> | null;
  spotAvailable?: Record<string, number>;
  future: Record<string, unknown> | null;
  futureMargin?: number;
  /** CrossEx 合约持仓模式：SINGLE 单向 / DUAL 双向 */
  positionMode?: 'SINGLE' | 'DUAL' | '';
}

export interface TransferMeta {
  symbol: string;
  venue: string;
  coin: string;
  from: string;
  to: string;
  minAmount: string;
  fee: string;
  precision: number;
  disabled: boolean;
}

export interface WithdrawResult {
  symbol: string;
  venue: string;
  coin: string;
  amount: string;
  status: 'PENDING' | 'SUCCESS' | 'FAIL' | string;
  actualReceive: string;
  failReason: string;
  txId: string;
  text: string;
}

export interface KrakenWithdrawResult {
  fromAmount: string;
  toAmount: string;
  status: 'SUCCESS' | 'UNKNOWN' | string;
  text: string;
  failReason: string;
  orderId: string;
}

export type AccountDirection = 'spot-to-crossex' | 'crossex-to-spot';

export interface AccountTransferMeta {
  coin: 'USDT';
  minAmount: string;
  fee: string;
  precision: number;
  disabled: boolean;
}

export type ConvertDirection = 'spot-to-venue' | 'venue-to-spot';

export interface ConvertQuote {
  exchangeType: string;
  direction: ConvertDirection;
  symbol: string;
  fromAsset: string;
  toAsset: string;
  quoteId: string;
  validMs: string;
  fromCoin: string;
  toCoin: string;
  fromAmount: string;
  toAmount: string;
  price: string;
}

async function call<T>(action: string, payload?: unknown): Promise<ApiResponse<T>> {
  if (!window.panel) return { code: -1, message: '请在 Electron 窗口中使用 API 密钥' };
  const result = await window.panel.gateCall(action, payload);
  if (!result.ok) return { code: -1, message: result.message || '请求失败' };
  return { code: 0, data: result.data as T };
}

export const getExchangePosition = () => call<PositionData>('portfolio');
export const getTransferMeta = (symbol: string) => call<TransferMeta>('transferMeta', { symbol });
export const withdrawAsset = (symbol: string, amount: string) => call<WithdrawResult>('withdraw', { symbol, amount });
export const withdrawKrakenUsd = (amount: string) => call<KrakenWithdrawResult>('krakenWithdraw', { amount });
export const getHlTopUpMeta = () => call<TransferMeta>('hlTopUpMeta');
export const topUpHl = (amount: string) => call<WithdrawResult>('hlTopUp', { amount });
export const getLighterTopUpMeta = () => call<TransferMeta>('lighterTopUpMeta');
export const topUpLighter = (amount: string) => call<WithdrawResult>('lighterTopUp', { amount });
export const getAccountTransferMeta = () => call<AccountTransferMeta>('accountTransferMeta');
export const transferAccountUsdt = (direction: AccountDirection, amount: string) => call<WithdrawResult>('accountTransfer', { direction, amount });
export const quoteConvert = (symbol: string, direction: ConvertDirection, amount: string) => call<ConvertQuote>('convertQuote', { symbol, direction, amount });
export const orderConvert = (quote: ConvertQuote) => call<ConvertQuote & { status: string; orderId: string; text: string; failReason: string }>('convertOrder', { quote });
export const reducePosition = (coin: string, size: string, side: string) => call<null>('reduce', { coin, size, side });
export const placeOrder = (payload: {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'LIMIT' | 'MARKET';
  qty: string;
  price?: string;
  reduceOnly: boolean;
}) => call<{ orderId: string; state: string; reduceOnly: boolean }>('placeOrder', payload);

export interface GateOrderRow {
  orderId: string;
  text: string;
  state: string;
  symbol: string;
  side: string;
  type: string;
  exchangeType: string;
  businessType: string;
  qty: string;
  price: string;
  executedQty: string;
  executedAvgPrice: string;
  reduceOnly: boolean;
  positionSide: string;
  createTime: string;
  updateTime: string;
  reason: string;
}

export interface GateTradeRow {
  tradeId: string;
  orderId: string;
  symbol: string;
  exchangeType: string;
  side: string;
  qty: string;
  price: string;
  fee: string;
  feeCoin: string;
  rpnl: string;
  positionSide: string;
  createTime: string;
}

export const getOpenOrders = () => call<GateOrderRow[]>('openOrders');
export const getHistoryOrders = (limit = 50) => call<GateOrderRow[]>('historyOrders', { page: 1, limit });
export const getHistoryTrades = (limit = 50) => call<GateTradeRow[]>('historyTrades', { page: 1, limit });
export const cancelOrder = (orderId: string) => call<unknown>('cancelOrder', { orderId });
export const clearSpot = (coin: string, size: string) => call<{ executedSize?: string }>('clearSpot', { coin, size });
export const adjustMargin = (coin: string, amount: string, side: string, action: 'add' | 'remove') => call<unknown>('adjustMargin', { coin, amount, side, action });
