/**
 * Vite config for the Bodhilander mobile-companion PWA.
 *
 * Contract (locked by BDHLNDR-52):
 *   - `base` is `/m/` because the desktop HTTP server mounts the bundle at
 *     `/m/*` (see `src/main/api/http-server.ts`).
 *   - Output goes to `<repo>/dist/pwa/` so the desktop static-serve handler
 *     can find it at `path.join(__dirname, '..', '..', 'pwa')`.
 *   - The service worker is emitted as `sw.js` at the bundle root so it can
 *     be requested at `/m/sw.js` with scope `/m/`.
 *   - Asset filenames are hashed (vite default) so the desktop's `maxAge: 1h`
 *     cache policy is safe.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

export default defineConfig({
  root: __dirname,
  base: '/m/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Emit the SW at the bundle root so it lives at /m/sw.js with /m/ scope.
      filename: 'sw.js',
      // `injectRegister: 'auto'` lets vite-plugin-pwa inject the registration
      // snippet into index.html; we don't need a custom hook for now.
      injectRegister: 'auto',
      strategies: 'generateSW',
      includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Bodhilander Mobile',
        short_name: 'Bodhilander',
        description: 'Monitor and respond to Claude Code sessions from your phone',
        theme_color: '#1a1a1a',
        background_color: '#1a1a1a',
        display: 'standalone',
        start_url: '/m/',
        scope: '/m/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Precache the app shell (everything vite emits). The runtime caches
        // below handle API responses + future hashed asset rotations.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Make sure unmatched navigations fall through to index.html so
        // client-side routing works offline once we're cached.
        navigateFallback: '/m/index.html',
        // Don't intercept navigations to /api/* — the SW should let those
        // hit the runtime cache rule below (or fall through to the network).
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Bodhilander REST API — NetworkFirst with a short timeout so the
            // PWA stays responsive on flaky links. 24h expiration is a
            // reasonable upper bound; chat-event polling will mostly hit the
            // network anyway.
            urlPattern: /\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'bodhilander-api',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24, // 24h
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Hashed bundle assets — CacheFirst is safe because vite emits
            // content-hashed filenames; new builds invalidate naturally.
            urlPattern: /\/m\/assets\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'bodhilander-assets',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Useful when running `bun run dev:pwa` against the desktop's REST API.
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: path.join(repoRoot, 'dist', 'pwa'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5174,
    // Dev-only: the desktop runs on 8443. The PWA dev server proxies
    // /api/* and /ws so we can iterate without rebuilding the bundle.
    proxy: {
      '/api': {
        target: 'http://localhost:8443',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8443',
        ws: true,
      },
    },
  },
});
