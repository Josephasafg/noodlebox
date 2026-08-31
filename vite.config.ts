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
      // Songs are imported from chord-site links. Neither site sends CORS
      // headers, so the browser cannot fetch them itself; the dev server fetches
      // on their behalf, same-origin, exactly as `/api` does for the video
      // service. See `src/chords/import.ts` for the matching paths.
      '/tab4u': {
        target: 'https://www.tab4u.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tab4u/, ''),
      },
      '/ug': {
        // Song pages are canonically served from the `tabs` subdomain, which
        // answers for a `www` path too, so one target covers either link.
        target: 'https://tabs.ultimate-guitar.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ug/, ''),
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
