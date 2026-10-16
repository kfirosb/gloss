import { defineConfig } from '@playwright/test';

// Fail on a busy port instead of silently testing another worktree's server.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid PLAYWRIGHT_PORT');
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: 'tests/ui',
  testMatch: '**/*.spec.ts',
  use: { baseURL },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
