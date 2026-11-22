import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionClock, formatTimer } from './sessionClock.ts';

test('session clock counts elapsed time only while running and re-anchors on setElapsed', () => {
  let now = 0;
  const clock = createSessionClock(() => now);
  clock.setElapsed(30);
  now = 5_000;
  assert.equal(clock.getElapsedSec(), 30, 'paused clock does not advance');
  clock.setRunning(true);
  now = 7_500;
  assert.equal(clock.getElapsedSec(), 32);
  clock.setRunning(false);
  now = 20_000;
  assert.equal(clock.getElapsedSec(), 32);
});

test('session clock derives remaining time from the server deadline or the time limit', () => {
  let now = 0;
  const clock = createSessionClock(() => now);
  assert.equal(clock.getRemainingSec(), null, 'untimed');
  clock.setDeadline(undefined, 120);
  clock.setElapsed(100);
  assert.equal(clock.getRemainingSec(), 20);
  clock.setServerNow('2026-01-01T00:00:00.000Z');
  clock.setDeadline('2026-01-01T00:01:00.000Z', 120);
  now = 59_500;
  assert.equal(clock.getRemainingSec(), 1);
  now = 61_000;
  assert.equal(clock.getRemainingSec(), 0, 'never negative');
});

test('formatTimer pads minutes and adds hours when needed', () => {
  assert.equal(formatTimer(65), '01:05');
  assert.equal(formatTimer(3725), '1:02:05');
  assert.equal(formatTimer(-3), '00:00');
});
