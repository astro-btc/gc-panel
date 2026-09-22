const { app, safeStorage, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { callGate } = require('./gate.cjs');

const DEV_URL = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:5173';
const isDev = !app.isPackaged;

const credentialFile = () => path.join(app.getPath('userData'), 'gate-credentials.bin');

function readCredentials() {
  const file = credentialFile();
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不能加密保存 API 密钥');
  const decoded = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  if (!decoded?.apiKey || !decoded?.apiSecret) return null;
  return { K: String(decoded.apiKey), S: String(decoded.apiSecret) };
}

function credentialStatus() {
  const keys = readCredentials();
  if (!keys) return { saved: false, keyHint: '' };
  const tail = keys.K.slice(-4);
  return { saved: true, keyHint: tail ? `····${tail}` : '已保存' };
}

function saveCredentials(apiKey, apiSecret) {
  const key = String(apiKey || '').trim();
  const secret = String(apiSecret || '').trim();
  if (!key || !secret) throw new Error('请填写 API Key 和 API Secret');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不能加密保存 API 密钥');
  const payload = safeStorage.encryptString(JSON.stringify({ apiKey: key, apiSecret: secret }));
  fs.mkdirSync(path.dirname(credentialFile()), { recursive: true });
  fs.writeFileSync(credentialFile(), payload, { mode: 0o600 });
  fs.chmodSync(credentialFile(), 0o600);
  return credentialStatus();
}

function clearCredentials() {
  fs.rmSync(credentialFile(), { force: true });
  return { saved: false, keyHint: '' };
}

function assertHttpUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只允许 http/https');
  return url;
}

function appIconPath() {
  const candidates = [
    path.join(__dirname, '../build/icon.png'),
    path.join(__dirname, '../public/icon.png'),
  ];
  return candidates.find((file) => fs.existsSync(file)) || '';
}

function createWindow() {
  const icon = appIconPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#121820',
    title: 'GC Panel',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' || target.protocol === 'http:') void shell.openExternal(url);
    } catch { /* 忽略非法地址 */ }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(DEV_URL)) return;
    const devFile = !isDev && url.startsWith('file:');
    if (devFile) return;
    event.preventDefault();
  });

  if (isDev) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

const PUBLIC_HOSTS = new Set([
  'api.gateio.ws',
  'fapi.binance.com',
  'api.binance.com',
  'data-api.binance.vision',
  'www.okx.com',
  'api.bybit.com',
  'futures.kraken.com',
  'api.hyperliquid.xyz',
  'www.deribit.com',
  'mainnet.zklighter.elliot.ai',
]);

ipcMain.handle('public:fetch', async (_event, request) => {
  const url = typeof request === 'string' ? request : request?.url;
  const method = request?.method === 'POST' ? 'POST' : 'GET';
  const target = assertHttpUrl(url);
  if (!PUBLIC_HOSTS.has(target.hostname)) throw new Error('行情代理不允许这个地址');
  if (method === 'POST' && target.hostname !== 'api.hyperliquid.xyz') throw new Error('不允许这个请求');
  const response = await fetch(target, {
    method,
    headers: {
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? String(request?.body || '').slice(0, 20_000) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  if (text.length > 8_000_000) throw new Error('行情响应太大');
  return { status: response.status, text };
});

ipcMain.handle('credentials:status', () => credentialStatus());

ipcMain.handle('credentials:save', (_event, payload) => saveCredentials(payload?.apiKey, payload?.apiSecret));

ipcMain.handle('credentials:clear', () => clearCredentials());

ipcMain.handle('gate:call', async (_event, payload) => {
  try {
    const data = await callGate(readCredentials(), payload?.action, payload?.payload);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

app.whenReady().then(() => {
  const icon = appIconPath();
  if (icon && process.platform === 'darwin' && app.dock) app.dock.setIcon(icon);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
