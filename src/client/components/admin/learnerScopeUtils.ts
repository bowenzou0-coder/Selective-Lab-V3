import type { AdminLearnerSummary } from '../../api';

export const LEARNERS_PAGE_SIZE = 20;
export const LEARNER_PICKER_RESULT_LIMIT = 50;

export type LearnerRoleFilter = 'all' | 'student' | 'admin';
export type LearnerSortKey = 'default' | 'unseen_asc' | 'sessions_desc' | 'recent_desc' | 'name_asc';

/** Returns the human-readable account label used across Admin Studio. */
export function getLearnerDisplayName(
  learner: Pick<AdminLearnerSummary, 'displayName' | 'email' | 'uid'>
): string {
  return learner.displayName || learner.email || learner.uid;
}

function getLearnerLastActivityMs(
  learner: Pick<AdminLearnerSummary, 'lastActiveAtIso' | 'updatedAtIso'>
): number {
  return Date.parse(learner.lastActiveAtIso || learner.updatedAtIso || '') || 0;
}

function compareLearnerNames(a: AdminLearnerSummary, b: AdminLearnerSummary): number {
  return getLearnerDisplayName(a).localeCompare(getLearnerDisplayName(b));
}

/**
 * Filters and sorts learners cleanly for both the quick-switcher popover and the Learners comparison table.
 */
export function filterAndSortLearners(
  learners: readonly AdminLearnerSummary[],
  opts: { query?: string; role?: LearnerRoleFilter; sort?: LearnerSortKey } = {}
): AdminLearnerSummary[] {
  const role = opts.role ?? 'all';
  const query = (opts.query ?? '').trim().toLowerCase();
  const sort = opts.sort ?? 'default';

  const filtered = learners.filter((learner) => {
    if (role === 'student' && learner.role === 'admin') return false;
    if (role === 'admin' && learner.role !== 'admin') return false;
    if (!query) return true;
    const display = learner.displayName.toLowerCase();
    const email = (learner.email ?? '').toLowerCase();
    const uid = learner.uid.toLowerCase();
    return display.includes(query) || email.includes(query) || uid.includes(query);
  });

  if (sort === 'default') return filtered;

  return [...filtered].sort((a, b) => {
    if (sort === 'unseen_asc') {
      return (
        a.unseenLivePercent - b.unseenLivePercent ||
        a.unseenLiveCount - b.unseenLiveCount ||
        compareLearnerNames(a, b)
      );
    }
    if (sort === 'sessions_desc') {
      return (
        b.sessionsCount - a.sessionsCount ||
        b.attemptsCount - a.attemptsCount ||
        compareLearnerNames(a, b)
      );
    }
    if (sort === 'recent_desc') {
      return (
        getLearnerLastActivityMs(b) - getLearnerLastActivityMs(a) ||
        compareLearnerNames(a, b)
      );
    }
    return compareLearnerNames(a, b);
  });
}
