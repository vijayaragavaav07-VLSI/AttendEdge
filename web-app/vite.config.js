import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    open: false,
    host: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  test: {
    globals: true,
    environment: 'node'
  }
});
