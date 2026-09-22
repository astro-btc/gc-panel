import { useEffect, useMemo, useState } from 'react';
import { AssetsPage } from './components/AssetsPage';
import { TradePage } from './components/TradePage';
import { getExchangePosition, type PositionData } from './gateApi';
import { parseFutureLegs } from './positions';

type Page = 'trade' | 'assets';
type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  const current = document.documentElement.dataset.theme;
  return current === 'light' ? 'light' : 'dark';
}

export function App() {
  const [page, setPage] = useState<Page>('trade');
  const [keyOpen, setKeyOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const [keyHint, setKeyHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [positions, setPositions] = useState<PositionData | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const legs = useMemo(() => parseFutureLegs(positions?.future), [positions]);

  async function refreshStatus() {
    if (!window.panel) return;
    const status = await window.panel.credentialStatus();
    setSaved(status.saved);
    setKeyHint(status.keyHint);
    if (!status.saved) setPositions(null);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('astro-gc-theme', theme);
  }, [theme]);

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (!saved) return;
    let cancelled = false;
    getExchangePosition().then((resp) => {
      if (!cancelled && resp.code === 0 && resp.data) setPositions(resp.data);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [saved]);

  async function refreshPositions() {
    if (!saved) return;
    const resp = await getExchangePosition();
    if (resp.code === 0 && resp.data) setPositions(resp.data);
  }

  async function submitKeys() {
    if (!window.panel) return;
    setBusy(true);
    setNotice('');
    try {
      const status = await window.panel.saveCredentials(apiKey, apiSecret);
      setSaved(status.saved);
      setKeyHint(status.keyHint);
      setApiKey('');
      setApiSecret('');
      setKeyOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function clearKeys() {
    if (!window.panel) return;
    await window.panel.clearCredentials();
    setSaved(false);
    setKeyHint('');
    setPositions(null);
    setKeyOpen(false);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button className="brand-home" onClick={() => setPage('trade')}>
            <img className="brand-symbol" src="./icon.png" alt="" />
            <strong>GC Panel</strong>
          </button>
          <a className="brand-by" href="https://astro-btc.xyz/" target="_blank" rel="noreferrer">
            by astro
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v7.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5" /><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7.2 8.8" /></svg>
          </a>
        </div>
        <nav>
          <button className={page === 'trade' ? 'active' : ''} onClick={() => setPage('trade')}>交易</button>
          <button className={page === 'assets' ? 'active' : ''} onClick={() => setPage('assets')}>资产</button>
        </nav>
        <div className="top-actions">
          <button className="theme-button" onClick={() => {
            const next = theme === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = next;
            setTheme(next);
          }}>
            {theme === 'dark' ? '浅色' : '深色'}
          </button>
          <button className="settings-button" onClick={() => { setNotice(''); setKeyOpen(true); }} aria-label="API 密钥">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3" /><path d="M5 19c1.5-3 4-4.5 7-4.5S17.5 16 19 19" /></svg>
          </button>
        </div>
      </header>

      {page === 'trade' ? (
        <TradePage legs={legs} loggedIn={saved} theme={theme} onOpenAssets={() => setPage('assets')} onCloseLeg={() => setPage('assets')} onRefreshPositions={refreshPositions} />
      ) : (
        <AssetsPage loggedIn={saved} onPositions={setPositions} />
      )}

      <footer className="statusbar">
        <div>
          <span className={saved ? 'connected' : ''}>{saved ? `API 已保存 ${keyHint}` : '未填写 API'}</span>
        </div>
        <span>密钥由系统加密，只保存在本机</span>
      </footer>

      {keyOpen && (
        <div className="modal-backdrop" onMouseDown={() => setKeyOpen(false)}>
          <form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitKeys(); }}>
            <header><strong>Gate API</strong><button type="button" onClick={() => setKeyOpen(false)}>×</button></header>
            <p className="hint">填写 Gate APIv4 的 Key 和 Secret。保存后由系统加密写在本机（macOS 钥匙串 / Windows DPAPI），界面不再显示 Secret。</p>
            {saved && <p className="hint">当前已保存 {keyHint}。重新填写会覆盖。</p>}
            <label className="field"><span>API Key</span><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="field"><span>API Secret</span><input type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            {notice && <p className="form-error">{notice}</p>}
            {!window.panel && <p className="hint">当前是浏览器预览，密钥只能在 Electron 里保存。</p>}
            <div className="modal-actions">
              {saved && <button type="button" className="danger" onClick={() => void clearKeys()}>清除</button>}
              <button className="submit-order buy" type="submit" disabled={busy || !window.panel}><strong>{busy ? '保存中…' : '加密保存'}</strong></button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
