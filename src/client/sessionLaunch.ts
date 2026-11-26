import { api } from './api';

export const loadSessionPlayer = () => import('./components/SessionPlayerView');

/** Fetch the player code while the server selects questions for this session. */
export function createSession(payload: Parameters<typeof api.createSession>[0]) {
  void loadSessionPlayer().catch(() => undefined);
  return api.createSession(payload);
}
