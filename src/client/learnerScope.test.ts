import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdminLearnerSummary } from './api';
import { filterAndSortLearners } from './components/admin/learnerScopeUtils';

function makeLearner(index: number, overrides: Partial<AdminLearnerSummary> = {}): AdminLearnerSummary {
  const num = String(index).padStart(3, '0');
  return {
    uid: `student-${num}`,
    role: 'student',
    displayName: `Learner ${num}`,
    email: `learner${num}@example.com`,
    sessionsCount: index % 15,
    attemptsCount: (index % 15) * 12,
    unseenLiveCount: Math.max(0, 200 - index),
    doneLiveCount: index % 40,
    needsRepairLiveCount: index % 7,
    inReviewLiveCount: index % 11,
    unseenLivePercent: (index * 7) % 101,
    estimatedRunwayDays: Math.max(1, 30 - (index % 25)),
    lastActiveAtIso: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
    ...overrides,
  };
}

test('filterAndSortLearners filters by query and role and sorts accurately across 100 learners', () => {
  const mixed: AdminLearnerSummary[] = [
    makeLearner(1, { role: 'admin', displayName: 'Alex Parent', email: 'alex@parent.org', sessionsCount: 2, unseenLivePercent: 95 }),
    makeLearner(2, { role: 'student', displayName: 'Zoe Chan', email: 'zoe@school.edu', sessionsCount: 25, unseenLivePercent: 12 }),
    ...Array.from({ length: 98 }, (_, i) => makeLearner(i + 3)),
  ];

  // Role filters
  assert.equal(filterAndSortLearners(mixed, { role: 'admin' }).map((l) => l.uid).length, 1);
  assert.equal(filterAndSortLearners(mixed, { role: 'student' }).length, 99);

  // Query matches displayName, email, or uid case-insensitively
  assert.deepEqual(
    filterAndSortLearners(mixed, { query: 'ZOE@SCHOOL' }).map((l) => l.uid),
    ['student-002']
  );
  assert.deepEqual(
    filterAndSortLearners(mixed, { query: 'student-073' }).map((l) => l.uid),
    ['student-073']
  );

  // Sort checks
  const byUnseen = filterAndSortLearners(mixed, { sort: 'unseen_asc' });
  for (let i = 1; i < byUnseen.length; i++) {
    assert.ok(byUnseen[i].unseenLivePercent >= byUnseen[i - 1].unseenLivePercent);
  }

  const bySessions = filterAndSortLearners(mixed, { sort: 'sessions_desc' });
  assert.equal(bySessions[0].uid, 'student-002');
  for (let i = 1; i < bySessions.length; i++) {
    assert.ok(bySessions[i].sessionsCount <= bySessions[i - 1].sessionsCount);
  }

  const byRecent = filterAndSortLearners(mixed, { sort: 'recent_desc' });
  assert.equal(byRecent[0].uid, 'student-100');

  const byName = filterAndSortLearners(mixed, { sort: 'name_asc' });
  assert.equal(byName[0].displayName, 'Alex Parent');
  assert.equal(byName[byName.length - 1].displayName, 'Zoe Chan');
});
