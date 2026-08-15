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
      // The tab-video extraction service, started alongside by `npm run dev` and
      // by the noodlebox command. Proxying keeps it same-origin, so no CORS
      // negotiation is involved. TABVIDEO_PORT is the service's own variable, so
      // the two stay in step wherever it is moved.
      '/api': {
        target: `http://127.0.0.1:${process.env.TABVIDEO_PORT ?? 8787}`,
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
