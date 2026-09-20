import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  publicDir: resolve(configDir, '../../design/public'),
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4100',
    },
  },
});
