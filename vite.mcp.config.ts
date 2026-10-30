// Bundles the MCP server (mcp/) into one plain-JavaScript file the desktop app ships, so
// players can connect AI agents with just Node.js installed: dist-mcp/project-transit-mcp.mjs
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  publicDir: false,
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'mcp/main.ts',
    outDir: 'dist-mcp',
    emptyOutDir: true,
    target: 'node18',
    minify: true,
    rollupOptions: { output: { entryFileNames: 'project-transit-mcp.mjs', format: 'es' } },
  },
});
