import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server.ts';

let initializing: ReturnType<typeof createApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  initializing ??= createApp({ skipVite: true }).catch((error: unknown) => {
    initializing = undefined;
    throw error;
  });
  const { app } = await initializing;
  app(req, res);
}
