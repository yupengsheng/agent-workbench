import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  use: { baseURL: 'http://127.0.0.1:5175' },
  webServer: {
    command: 'npm run dev --workspace @agent-workbench/web -- --port 5175 --strictPort',
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: false,
  },
});
