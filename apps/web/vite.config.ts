import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.VITE_API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // No inline scripts or styles: the server's CSP only allows 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api },
      '/ws': { target: api, ws: true },
    },
  },
});
