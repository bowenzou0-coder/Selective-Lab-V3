// Entrypoint. App wiring lives in src/server/app.ts; routes in src/server/routes/*.
import dotenv from 'dotenv';
import { createApp } from './src/server/app.ts';

export { createApp, type CreateAppOptions } from './src/server/app.ts';

// Keep the test runner isolated from live database and Gemini credentials.
if (!process.env.NODE_TEST_CONTEXT) dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT || 3000);
const isEntrypoint =
  !process.env.VERCEL && Boolean(process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js'));

if (isEntrypoint) {
  createApp()
    .then(({ app, repo }) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`Selective Lab server listening on http://0.0.0.0:${PORT} (${repo.backendName})`);
      });
    })
    .catch((err) => {
      console.error('Fatal server startup error:', err);
      process.exit(1);
    });
}
