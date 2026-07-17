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
 *
 * BDHLNDR-49: switched from `generateSW` to `injectManifest` so the SW can
 * own its own source (`src/pwa/src/sw.ts`) — needed to add the `push` and
 * `notificationclick` event handlers for Web Push. The custom SW still
 * calls `precacheAndRoute(self.__WB_MANIFEST)` so the workbox precache +
 * runtime cache rules previously declared inline below are preserved
 * (re-expressed in TS inside sw.ts).
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
      // BDHLNDR-49: own the SW source so we can add the `push` /
      // `notificationclick` listeners. `srcDir` + `filename` together tell
      // vite-plugin-pwa where to find the input TS and what to emit as.
      strategies: 'injectManifest',
      srcDir: 'src',
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
      injectManifest: {
        // Mirrors the previous generateSW globPatterns so the precache
        // covers the full app shell. The custom SW calls
        // precacheAndRoute(self.__WB_MANIFEST) to consume this.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
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
