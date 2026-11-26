import { randomUUID } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:3111';
// Workers inherit the same disposable signing key as this run's memory server.
process.env.E2E_SESSION_SECRET ??= randomUUID();

export default defineConfig({
  testDir: './e2e',
  workers: 1, // The PIN student is shared by all browser contexts.
  retries: 0,
  use: { browserName: 'chromium', baseURL, viewport: { width: 1365, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev:demo',
    url: baseURL + '/api/health',
    reuseExistingServer: false,
    env: {
      DISABLE_HMR: 'true', GOOGLE_LEGACY_STUDENT_IDS: '',
      PORT: '3111', NODE_ENV: 'development', DATABASE_URL: '', GEMINI_API_KEY: '', GOOGLE_CLIENT_ID: '',
      ADMIN_PASSWORD: 'admin-dev', STUDENT_PIN: '1234', SESSION_SECRET: process.env.E2E_SESSION_SECRET,
    },
  },
});
