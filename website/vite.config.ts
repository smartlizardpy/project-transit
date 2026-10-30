import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this repository's site at https://smartlizardpy.github.io/project-transit/.
// For a custom domain or a root Pages site, build with BASE_PATH=/ and SITE_URL=https://example.org/.
const base = process.env.BASE_PATH ?? '/project-transit/';
const siteUrl = (process.env.SITE_URL ?? `https://smartlizardpy.github.io${base}`).replace(/\/?$/, '/');

/** Absolute URLs for the canonical link and social cards. */
const siteUrlInHtml = (): Plugin => ({
  name: 'site-url',
  transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', siteUrl),
});

export default defineConfig({
  base,
  plugins: [react(), siteUrlInHtml()],
  // The fleet illustrations are the game's own components (../src/ui/BusArt.tsx).
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 5180, strictPort: true, host: '127.0.0.1', fs: { allow: ['..'] } },
  preview: { port: 4180, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
