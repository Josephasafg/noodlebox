import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/noodlebox/',
  plugins: [react()],
  optimizeDeps: {
    include: ['smplr'],
  },
  server: {
    proxy: {
      // The tab-video extraction service, started alongside by `npm run dev`.
      // Proxying keeps it same-origin, so no CORS negotiation is involved.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
