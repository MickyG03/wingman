import { defineConfig } from 'vite'

const BRIDGE_PORT = process.env.BRIDGE_PORT ?? '8787'

export default defineConfig({
  server: {
    // shared/protocol.ts lives outside this package.
    fs: { allow: ['..'] },
    host: true,
    port: 5173,
    // Same-origin path to the bridge in dev, so neither the simulator nor the
    // sideloaded app on real glasses needs a whitelist entry or CORS.
    proxy: {
      '/bridge': {
        target: `ws://localhost:${BRIDGE_PORT}`,
        ws: true,
        rewrite: path => path.replace(/^\/bridge/, '/ws'),
      },
    },
  },
  build: { target: 'esnext' },
})
