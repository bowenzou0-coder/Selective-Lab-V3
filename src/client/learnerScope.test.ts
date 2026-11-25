import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdminLearnerSummary } from './api';
import {
  QUICK_LEARNER_PILL_LIMIT,
  buildQuickSwitchLearners,
  filterAndSortLearners,
} from './components/admin/learnerScopeUtils';

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

test('buildQuickSwitchLearners caps pills at 4 for 10 and 100 learners while keeping Primary and selected visible', () => {
  const ten = Array.from({ length: 10 }, (_, i) => makeLearner(i + 1));
  const res10 = buildQuickSwitchLearners(ten, 'student-008', 'student-001');
  assert.equal(res10.quickLearners.length, QUICK_LEARNER_PILL_LIMIT);
  assert.equal(res10.hiddenCount, 6);
  assert.deepEqual(
    res10.quickLearners.map((l) => l.uid),
    ['student-001', 'student-008', 'student-002', 'student-003']
  );

  const hundred = Array.from({ length: 100 }, (_, i) => makeLearner(i + 1));
  const res100 = buildQuickSwitchLearners(hundred, 'student-073', 'student-001');
  assert.equal(res100.quickLearners.length, QUICK_LEARNER_PILL_LIMIT);
  assert.equal(res100.hiddenCount, 96);
  assert.deepEqual(
    res100.quickLearners.map((l) => l.uid),
    ['student-001', 'student-073', 'student-002', 'student-003']
  );
});

test('buildQuickSwitchLearners handles catalog mode and small lists cleanly', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => makeLearner(i + 1));
  const catalogRes = buildQuickSwitchLearners(hundred, 'none', 'student-005');
  assert.equal(catalogRes.quickLearners.length, 4);
  assert.equal(catalogRes.hiddenCount, 96);
  assert.equal(catalogRes.quickLearners[0].uid, 'student-005');

  const three = Array.from({ length: 3 }, (_, i) => makeLearner(i + 1));
  const smallRes = buildQuickSwitchLearners(three, 'student-002', 'student-003');
  assert.equal(smallRes.quickLearners.length, 3);
  assert.equal(smallRes.hiddenCount, 0);
  assert.deepEqual(
    smallRes.quickLearners.map((l) => l.uid),
    ['student-003', 'student-002', 'student-001']
  );
});

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
