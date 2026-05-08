import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'fs'

let httpsConfig = false
try {
  httpsConfig = {
    key: fs.readFileSync('C:/Users/Christoth/100.77.170.83-key.pem'),
    cert: fs.readFileSync('C:/Users/Christoth/100.77.170.83.pem'),
  }
} catch (_) {}

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        name: 'Coaching Assistant',
        short_name: 'CoachAI',
        description: 'Swimming coaching assistant',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        orientation: 'portrait',
        icons: [
          { src: '/logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/logo.png',     sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: [],
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: 'NetworkOnly' },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    https: httpsConfig,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    host: true,
    port: 5173,
    https: httpsConfig,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
