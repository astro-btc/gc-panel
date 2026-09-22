import { useEffect, useState } from 'react';
import {
  adjustMargin,
  clearSpot,
  getAccountTransferMeta,
  getExchangePosition,
  getHlTopUpMeta,
  getLighterTopUpMeta,
  getTransferMeta,
  orderConvert,
  quoteConvert,
  reducePosition,
  topUpHl,
  topUpLighter,
  transferAccountUsdt,
  withdrawAsset,
  withdrawKrakenUsd,
  type AccountDirection,
  type AccountTransferMeta,
  type ConvertDirection,
  type ConvertQuote,
  type PositionData,
  type TransferMeta,
} from '../gateApi';
import {
  formatNumberPretty,
  isAccountUsdt,
  isHyperliquidUsdc,
  isKrakenUsd,
  isLighterUsdc,
  isQuoteCoin,
  isStableConvertAsset,
  parseFutureLegs,
  parseSpotRows,
  parseTransferAsset,
  type FutureLeg,
  type SpotRow,
} from '../positions';

type Dialog =
  | { kind: 'transfer'; row: SpotRow }
  | { kind: 'withdraw'; row: SpotRow }
  | { kind: 'kraken'; row: SpotRow }
  | { kind: 'hl'; row: SpotRow }
  | { kind: 'lighter'; row: SpotRow }
  | { kind: 'convert'; row: SpotRow }
  | { kind: 'sell'; row: SpotRow }
  | { kind: 'close'; leg: FutureLeg }
  | { kind: 'margin'; leg: FutureLeg }
  | null;

const ACCOUNT_LABEL: Record<AccountDirection, string> = {
  'spot-to-crossex': 'Gate 统一账户 → Gate CrossEx账户',
  'crossex-to-spot': 'Gate CrossEx账户 → Gate 统一账户',
};

function destinationLabel(venue?: string) {
  return venue === 'HYPERLIQUID' || venue === 'LIGHTER'
    ? 'Gate 统一账户（SPOT）'
    : 'Gate CrossEx账户（CROSSEX_GATE）';
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return '请求失败';
}

function positionModeLabel(mode?: string) {
  if (mode === 'SINGLE') return '单向持仓模式';
  if (mode === 'DUAL') return '双向持仓模式';
  return '';
}

export function AssetsPage({
  loggedIn,
  onPositions,
}: {
  loggedIn: boolean;
  onPositions: (data: PositionData | null) => void;
}) {
  const [data, setData] = useState<PositionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<AccountDirection>('crossex-to-spot');
  const [convertDirection, setConvertDirection] = useState<ConvertDirection>('venue-to-spot');
  const [marginAction, setMarginAction] = useState<'add' | 'remove'>('add');
  const [meta, setMeta] = useState<TransferMeta | AccountTransferMeta | null>(null);
  const [quote, setQuote] = useState<ConvertQuote | null>(null);
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    if (!loggedIn) return;
    setLoading(true);
    setError('');
    try {
      const resp = await getExchangePosition();
      if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '获取持仓失败');
      setData(resp.data);
      onPositions(resp.data);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (loggedIn) void refresh();
    else {
      setData(null);
      onPositions(null);
    }
    // 登录状态或服务器地址变化时重新拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

  function open(next: Dialog) {
    setDialog(next);
    setAmount('');
    setMeta(null);
    setQuote(null);
    setStatus('');
    setDirection('crossex-to-spot');
    setConvertDirection('venue-to-spot');
    setMarginAction('add');
    if (next?.kind === 'withdraw') void loadWithdraw(next.row.key);
    if (next?.kind === 'transfer') void loadAccountMeta();
    if (next?.kind === 'hl') void loadTopUp('hl');
    if (next?.kind === 'lighter') void loadTopUp('lighter');
  }

  async function loadWithdraw(symbol: string) {
    setStatus('正在读取 Gate 划转规则…');
    try {
      const resp = await getTransferMeta(symbol);
      if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '获取划转规则失败');
      setMeta(resp.data);
      setStatus(resp.data.disabled ? `Gate 当前已暂停 ${resp.data.coin} 划转` : '');
    } catch (err) {
      setStatus(errorText(err));
    }
  }

  async function loadAccountMeta() {
    setStatus('正在读取账户划转规则…');
    try {
      const resp = await getAccountTransferMeta();
      if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '获取划转规则失败');
      setMeta(resp.data);
      setStatus(resp.data.disabled ? 'Gate 当前已暂停 USDT 账户划转' : '');
    } catch (err) {
      setStatus(errorText(err));
    }
  }

  async function loadTopUp(kind: 'hl' | 'lighter') {
    setStatus('正在读取充值规则…');
    try {
      const resp = kind === 'hl' ? await getHlTopUpMeta() : await getLighterTopUpMeta();
      if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '获取充值规则失败');
      setMeta(resp.data);
      setStatus(resp.data.disabled ? 'Gate 当前已暂停这笔充值' : '');
    } catch (err) {
      setStatus(errorText(err));
    }
  }

  async function submit() {
    if (!dialog) return;
    const value = amount.trim();
    if (!value || !/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0) {
      setStatus('请输入有效数量');
      return;
    }
    setSubmitting(true);
    setStatus('正在提交…');
    try {
      if (dialog.kind === 'transfer') {
        const resp = await transferAccountUsdt(direction, value);
        if (resp.code !== 0) throw new Error(resp.message || '划转失败');
        setStatus(resp.data?.status === 'SUCCESS' ? '划转已成功' : resp.data?.failReason || resp.message || '已提交');
      } else if (dialog.kind === 'withdraw') {
        const resp = await withdrawAsset(dialog.row.key, value);
        if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '提取失败');
        if (resp.data.status === 'FAIL') throw new Error(resp.data.failReason || '提取失败');
        setStatus(resp.data.status === 'SUCCESS'
          ? `已提取，实际到账 ${resp.data.actualReceive} ${resp.data.coin}`
          : `订单处理中 ${resp.data.txId || resp.data.text}`);
      } else if (dialog.kind === 'kraken') {
        const resp = await withdrawKrakenUsd(value);
        if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '提取失败');
        setStatus(resp.data.status === 'SUCCESS'
          ? `已提取 ${resp.data.fromAmount} USD → ${resp.data.toAmount} USDT`
          : resp.data.failReason || '结果未确认，请先在 Gate 核对');
      } else if (dialog.kind === 'hl' || dialog.kind === 'lighter') {
        const resp = dialog.kind === 'hl' ? await topUpHl(value) : await topUpLighter(value);
        if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '充值失败');
        if (resp.data.status === 'FAIL') throw new Error(resp.data.failReason || '充值失败');
        setStatus(resp.data.status === 'SUCCESS' ? '充值已成功' : `处理中 ${resp.data.txId || resp.data.text}`);
      } else if (dialog.kind === 'sell') {
        const resp = await clearSpot(dialog.row.key, value);
        if (resp.code !== 0) throw new Error(resp.message || '卖出失败');
        setStatus('现货已卖出');
      } else if (dialog.kind === 'close') {
        if (!dialog.leg.side) throw new Error('无法识别方向');
        const resp = await reducePosition(dialog.leg.key, value, dialog.leg.side);
        if (resp.code !== 0) throw new Error(resp.message || '平仓失败');
        setStatus('平仓已提交');
      } else if (dialog.kind === 'margin') {
        if (!dialog.leg.side) throw new Error('无法识别方向');
        const resp = await adjustMargin(dialog.leg.key, value, dialog.leg.side, marginAction);
        if (resp.code !== 0) throw new Error(resp.message || '调整保证金失败');
        setStatus(marginAction === 'add' ? '已增加保证金' : '已减少保证金');
      } else if (dialog.kind === 'convert') {
        if (!quote) {
          const resp = await quoteConvert(dialog.row.key, convertDirection, value);
          if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '报价失败');
          setQuote(resp.data);
          setStatus(`报价 ${resp.data.fromAmount} ${resp.data.fromCoin} → ${resp.data.toAmount} ${resp.data.toCoin}，确认后下单`);
          setSubmitting(false);
          return;
        }
        const resp = await orderConvert(quote);
        if (resp.code !== 0 || !resp.data) throw new Error(resp.message || '兑换失败');
        setStatus(resp.data.status === 'SUCCESS' ? `兑换成功 ${resp.data.toAmount} ${resp.data.toCoin}` : resp.data.failReason || '结果未确认');
        setQuote(null);
      }
      window.setTimeout(() => void refresh(), 600);
    } catch (err) {
      setStatus(errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  const legs = parseFutureLegs(data?.future);
  const rows = data ? parseSpotRows(data.spot, data.spotAvailable) : [];
  const modeLabel = positionModeLabel(data?.positionMode);
  const contractTitle = modeLabel ? `合约 (${modeLabel})` : '合约';

  return (
    <div className="alternate-view assets-view">
      <div className="view-heading">
        <div>
          <h1>资产与划转</h1>
          <p>持仓、提取、账户划转、稳定币兑换、Hyperliquid / Lighter 充值，都用本机保存的 Gate API 直接请求。</p>
        </div>
        <button className="refresh-button" onClick={() => void refresh()} disabled={!loggedIn || loading}>{loading ? '刷新中…' : '刷新'}</button>
      </div>
      {!loggedIn && <div className="panel-card empty-card"><strong>先填写 API</strong><p>右上角保存 Gate API Key 和 Secret 后，才会读取资产。</p></div>}
      {error && <p className="form-error">{error}</p>}
      {loggedIn && (
        <>
          <div className="assets-grid">
            <section className="panel-card">
              <header className="section-title"><h2>{contractTitle}</h2></header>
              {legs.filter((leg) => leg.direction).length === 0 && <p className="muted pad">没有合约持仓</p>}
              {legs.filter((leg) => leg.direction).map((leg) => (
                <div className="asset-row" key={`${leg.key}-${leg.side}`}>
                  <span className={`dir ${leg.direction === '多' ? 'long' : 'short'}`}>{leg.direction}</span>
                  <div><strong>{leg.displayKey}</strong><small>{leg.marginMode || '保证金模式未知'}{leg.unitPrice != null ? ` · ${formatNumberPretty(leg.unitPrice)}` : ''}</small></div>
                  <span><strong>{leg.value}</strong>
                    <small className="row-actions">
                      <button onClick={() => open({ kind: 'close', leg })}>平</button>
                      {leg.key.startsWith('HYPERLIQUID:') && leg.marginMode === 'isolated' && (
                        <button onClick={() => open({ kind: 'margin', leg })}>保证金</button>
                      )}
                    </small>
                  </span>
                </div>
              ))}
            </section>
            <section className="panel-card">
              <header className="section-title"><h2>现货</h2></header>
              {rows.map((row) => {
                const transfer = parseTransferAsset(row.key);
                const available = row.available ?? row.amount;
                return (
                  <div className="asset-row" key={row.key}>
                    <span className={`dir ${isQuoteCoin(row.key) ? 'quote' : 'spot'}`}>{isQuoteCoin(row.key) ? '余' : '现'}</span>
                    <div><strong>{row.key}</strong><small>{row.available != null ? `可划 ${formatNumberPretty(row.available)}` : '余额'}</small></div>
                    <span>
                      <strong>{formatNumberPretty(row.amount)}</strong>
                      <small className="row-actions">
                        {isAccountUsdt(row.key) && <button onClick={() => open({ kind: 'transfer', row })}>划转</button>}
                        {isKrakenUsd(row.key) && available > 0 && <button onClick={() => open({ kind: 'kraken', row })}>提取</button>}
                        {isHyperliquidUsdc(row.key) && <button onClick={() => open({ kind: 'hl', row })}>充值</button>}
                        {isLighterUsdc(row.key) && <button onClick={() => open({ kind: 'lighter', row })}>充值</button>}
                        {transfer && available > 0 && <button onClick={() => open({ kind: 'withdraw', row })}>提取</button>}
                        {isStableConvertAsset(transfer) && <button onClick={() => open({ kind: 'convert', row })}>兑换</button>}
                        {!isQuoteCoin(row.key) && row.amount > 0 && <button onClick={() => open({ kind: 'sell', row })}>卖出</button>}
                      </small>
                    </span>
                  </div>
                );
              })}
            </section>
          </div>
        </>
      )}

      {dialog && (
        <div className="modal-backdrop" onMouseDown={() => !submitting && setDialog(null)}>
          <form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <header>
              <strong>{titleOf(dialog)}</strong>
              <button type="button" onClick={() => setDialog(null)}>×</button>
            </header>
            {dialog.kind === 'transfer' && (
              <label className="field"><span>方向</span>
                <select value={direction} onChange={(event) => setDirection(event.target.value as AccountDirection)}>
                  {(Object.keys(ACCOUNT_LABEL) as AccountDirection[]).map((item) => <option key={item} value={item}>{ACCOUNT_LABEL[item]}</option>)}
                </select>
              </label>
            )}
            {dialog.kind === 'convert' && (
              <label className="field"><span>方向</span>
                <select value={convertDirection} onChange={(event) => { setConvertDirection(event.target.value as ConvertDirection); setQuote(null); }}>
                  <option value="venue-to-spot">{dialog.row.key} → CROSSEX:USDT</option>
                  <option value="spot-to-venue">CROSSEX:USDT → {dialog.row.key}</option>
                </select>
              </label>
            )}
            {dialog.kind === 'margin' && (
              <label className="field"><span>动作</span>
                <select value={marginAction} onChange={(event) => setMarginAction(event.target.value as 'add' | 'remove')}>
                  <option value="add">增加</option>
                  <option value="remove">减少</option>
                </select>
              </label>
            )}
            {dialog.kind === 'withdraw' && <p className="hint">提取到 {destinationLabel(parseTransferAsset(dialog.row.key)?.venue)}</p>}
            {dialog.kind === 'kraken' && <p className="hint">Kraken USD 会闪兑后提取为账户 USDT。</p>}
            <label className="field"><span>数量</span><input value={amount} onChange={(event) => { setAmount(event.target.value); setQuote(null); }} inputMode="decimal" autoFocus /></label>
            {meta && 'minAmount' in meta && <p className="hint">最小 {meta.minAmount} · 精度 {meta.precision} · 手续费 {meta.fee}{meta.disabled ? ' · 已暂停' : ''}</p>}
            {quote && <p className="hint">得到约 {quote.toAmount} {quote.toCoin}，价格 {quote.price}</p>}
            {status && <p className="status-line">{status}</p>}
            <button className="submit-order buy" type="submit" disabled={submitting || Boolean(meta && 'disabled' in meta && meta.disabled)}>
              <strong>{submitting ? '提交中…' : dialog.kind === 'convert' && !quote ? '获取报价' : '确认'}</strong>
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function titleOf(dialog: Exclude<Dialog, null>) {
  if (dialog.kind === 'transfer') return 'USDT 账户划转';
  if (dialog.kind === 'withdraw') return `提取 ${dialog.row.key}`;
  if (dialog.kind === 'kraken') return '提取 Kraken USD';
  if (dialog.kind === 'hl') return '充值 Hyperliquid USDC';
  if (dialog.kind === 'lighter') return '充值 Lighter USDC';
  if (dialog.kind === 'convert') return `兑换 ${dialog.row.key}`;
  if (dialog.kind === 'sell') return `卖出 ${dialog.row.key}`;
  if (dialog.kind === 'close') return `平仓 ${dialog.leg.displayKey}`;
  return `调整保证金 ${dialog.leg.displayKey}`;
}
