import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'fs'

const API_TARGET = process.env.VITE_API_TARGET || 'https://coaching-assistant-api.onrender.com'

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
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,json,png,svg,ttf,webmanifest,woff2}'],
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.method === 'GET' && url.pathname.startsWith('/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'lanewatch-ai-api-reads',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
          { urlPattern: /\/api\//, handler: 'NetworkOnly', method: 'POST' },
          { urlPattern: /\/api\//, handler: 'NetworkOnly', method: 'PUT' },
          { urlPattern: /\/api\//, handler: 'NetworkOnly', method: 'PATCH' },
          { urlPattern: /\/api\//, handler: 'NetworkOnly', method: 'DELETE' },
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
        // Defaults to the deployed API. Set VITE_API_TARGET to point at a
        // local backend (http://localhost:8001) when trying out changes that
        // are not deployed yet.
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
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
        // Defaults to the deployed API. Set VITE_API_TARGET to point at a
        // local backend (http://localhost:8001) when trying out changes that
        // are not deployed yet.
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
