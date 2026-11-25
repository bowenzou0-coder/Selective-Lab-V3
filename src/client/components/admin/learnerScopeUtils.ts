import type { AdminLearnerSummary } from '../../api';

export const QUICK_LEARNER_PILL_LIMIT = 4;
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
 * Selects up to `maxPills` learners for 1-click switching in the top bar
 * (always prioritizing the Primary learner and the currently focused learner),
 * plus the count of remaining hidden learners for the inline "+N more" picker.
 */
export function buildQuickSwitchLearners(
  learners: readonly AdminLearnerSummary[],
  selectedLearnerId: string,
  primaryLearnerId: string | null | undefined,
  maxPills = QUICK_LEARNER_PILL_LIMIT
): { quickLearners: AdminLearnerSummary[]; hiddenCount: number } {
  if (maxPills <= 0 || learners.length === 0) {
    return { quickLearners: [], hiddenCount: learners.length };
  }

  const quickLearners: AdminLearnerSummary[] = [];
  const seen = new Set<string>();
  const pushUnique = (learner?: AdminLearnerSummary | null) => {
    if (!learner || seen.has(learner.uid) || quickLearners.length >= maxPills) return;
    seen.add(learner.uid);
    quickLearners.push(learner);
  };

  if (primaryLearnerId) {
    pushUnique(learners.find((l) => l.uid === primaryLearnerId));
  }
  if (selectedLearnerId && selectedLearnerId !== 'none') {
    pushUnique(learners.find((l) => l.uid === selectedLearnerId));
  }
  for (const learner of learners) {
    if (quickLearners.length >= maxPills) break;
    pushUnique(learner);
  }

  return {
    quickLearners,
    hiddenCount: Math.max(0, learners.length - quickLearners.length),
  };
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
