import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import { handleExtract } from './api/_handler.js';

/**
 * Serves POST /api/extract during `npm run dev` using the same handler the
 * deployed serverless function uses, so the API key stays server-side in
 * development too and there is nothing extra to run alongside Vite.
 */
function devExtractionApi(env) {
  return {
    name: 'doctrack-dev-extraction-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/extract', async (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.method !== 'POST') return next();

        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const { status, body } = await handleExtract(payload, {
            apiKey: env.ANTHROPIC_API_KEY,
          });
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error?.message ?? 'Bad request.' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Loaded without the VITE_ prefix filter, then used only inside the dev
  // middleware — the key never reaches the client bundle.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      devExtractionApi(env),
      // `npm run dev:https` — a secure context, which is what Chrome requires
      // before it will register a service worker or offer "Add to Home Screen"
      // on a phone hitting your laptop over the LAN.
      ...(env.DOCTRACK_HTTPS === '1' ? [basicSsl()] : []),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.js',
        registerType: 'autoUpdate',
        injectRegister: null, // registered by hand in src/main.jsx
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
          // The OCR engine is ~15 MB and only some users ever trigger it, so it
          // is fetched on first read and cached by the browser rather than
          // forced onto every install as part of the app shell.
          globIgnores: ['**/tesseract/**'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          // Classic, not ES module: module service workers still are not
          // universal (Firefox in particular), and nothing here needs to be a
          // module once bundled.
          rollupFormat: 'iife',
        },
        devOptions: {
          enabled: true,
          type: 'module',
          navigateFallback: 'index.html',
        },
        manifest: {
          name: 'DocTrack — Family Documents',
          short_name: 'DocTrack',
          description:
            'Track Emirates IDs, licences, passports, visas and insurance expiries for the whole family. Everything stays on this device.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#0f172a',
          theme_color: '#0f172a',
          categories: ['productivity', 'utilities'],
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icons/maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
          shortcuts: [
            { name: 'Add a document', short_name: 'Add', url: '/#/documents/new' },
          ],
        },
      }),
    ],
    server: {
      host: true,
      port: 5173,
    },
    preview: {
      port: 4173,
    },
  };
});
