import { defineConfig } from 'vite';

export default defineConfig({
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
