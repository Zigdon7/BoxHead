import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        game: resolve(__dirname, 'src/index.html'),
        about: resolve(__dirname, 'src/about.html'),
        learn: resolve(__dirname, 'src/learn.html'),
      },
    }
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        rewriteWsOrigin: true
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/admin': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
