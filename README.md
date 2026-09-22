# GC Panel

本地 Electron 面板。首页是交易终端布局，行情走公共推送。资产、划转和平仓用你自己的 Gate API Key / Secret 直接请求，不需要登录。

## 启动

```bash
yarn
yarn dev
```

## 打包

```bash
yarn build
```

产物在 `release/`：Apple Silicon 的 `.dmg` 和 `.zip`。没有开发者证书时会跳过签名，第一次打开需要在「隐私与安全性」里允许。

## API 密钥

右上角填写 Gate APIv4 的 Key 和 Secret。保存时用操作系统加密（macOS 钥匙串 / Windows DPAPI），密文只写在本机，界面之后只显示 Key 的末四位。
