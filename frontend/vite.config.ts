import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 06-frontend-architecture.md §1. Proxying in dev means the app runs
// same-origin, so httpOnly cookies behave locally exactly as they do in prod.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      // ws:true is essential — without it sockets fail in dev only, which is a
      // miserable bug to find later.
      '/socket.io': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router'],
          // Split out because the welcome page, the login form and the invite
          // landing page never open a socket — only the table does. Keeping it
          // in the entry chunk makes the first screen pay for the last one.
          socket: ['socket.io-client'],
          // Game renderers are lazy routes, deliberately not chunked here.
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
