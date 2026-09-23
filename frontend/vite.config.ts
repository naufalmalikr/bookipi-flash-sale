import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev: relative '/api' calls are proxied to the backend at
// http://localhost:3001 (VITE_API_URL empty). In compose, browsers hit the
// frontend container but must reach the backend via an absolute URL, so the
// app uses import.meta.env.VITE_API_URL when set — the proxy below is
// local-dev only (`npm run dev` outside compose).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
});
