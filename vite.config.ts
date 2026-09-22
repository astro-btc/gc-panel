import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/crossex-symbols': {
        target: 'https://api.gateio.ws',
        changeOrigin: true,
        rewrite: () => '/api/v4/crossex/rule/symbols',
      },
      '/venue/api.gateio.ws': {
        target: 'https://api.gateio.ws',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/venue\/api\.gateio\.ws/, '') || '/',
      },
      '/venue/fapi.binance.com': {
        target: 'https://fapi.binance.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/venue\/fapi\.binance\.com/, '') || '/',
      },
      '/venue/www.okx.com': {
        target: 'https://www.okx.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/venue\/www\.okx\.com/, '') || '/',
      },
      '/venue/api.bybit.com': {
        target: 'https://api.bybit.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/venue\/api\.bybit\.com/, '') || '/',
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
