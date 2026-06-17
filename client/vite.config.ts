import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  resolve: {
    alias: {
      shared: resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  optimizeDeps: {
    exclude: ['shared'],
  },
});
