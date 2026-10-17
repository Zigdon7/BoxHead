import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true
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
