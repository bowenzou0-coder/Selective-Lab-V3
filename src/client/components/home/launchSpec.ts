import type { api } from '../../api';

/** Everything the "Ready to start?" dialog shows before a session is created. */
export interface PendingLaunchSpec {
  key: string;
  title: string;
  questionCountLabel: string;
  durationLabel: string;
  isUntimed?: boolean;
  payload: Parameters<typeof api.createSession>[0];
}
