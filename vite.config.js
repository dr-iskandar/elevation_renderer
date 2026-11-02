import { defineConfig } from 'vite';

export default defineConfig({
  worker: {
    // Mapbox GL's ESM worker is code-split, so Vite must emit an ES module
    // worker. The default IIFE format cannot contain multiple chunks.
    format: 'es',
  },
  server: {
    proxy: {
      '/nodeodm': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nodeodm/, ''),
      },
    },
  },
});
