import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointSaveQueue } from './checkpointQueue';

interface DummyCheckpoint {
  step: number;
  answer: string;
}

function deferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('CheckpointSaveQueue serializes overlapping saves and prevents false 409 conflicts', async () => {
  let serverRev = 17;
  let state: DummyCheckpoint = { step: 1, answer: 'A' };
  let activeRequests = 0;
  let maxConcurrent = 0;
  const sentExpectedRevs: number[] = [];
  const savedStatuses: boolean[] = [];
  const conflicts: number[] = [];

  const firstGate = deferred<{ checkpointRevision: number }>();
  let callCount = 0;

  const queue = new CheckpointSaveQueue<DummyCheckpoint>({
    initialRevision: serverRev,
    getPayload: () => ({ ...state }),
    canSave: () => true,
    saveFn: async (_payload, expectedRevision) => {
      callCount += 1;
      sentExpectedRevs.push(expectedRevision);
      activeRequests += 1;
      maxConcurrent = Math.max(maxConcurrent, activeRequests);
      try {
        if (callCount === 1) {
          const out = await firstGate.promise;
          if (expectedRevision !== serverRev) {
            throw { status: 409, currentRevision: serverRev, serverCheckpoint: state };
          }
          serverRev = out.checkpointRevision;
          return out;
        }
        if (expectedRevision !== serverRev) {
          throw { status: 409, currentRevision: serverRev, serverCheckpoint: state };
        }
        serverRev += 1;
        return { checkpointRevision: serverRev };
      } finally {
        activeRequests -= 1;
      }
    },
    onSaved: (_res, stillDirty) => savedStatuses.push(stillDirty),
    onConflict: (c) => conflicts.push(c.currentRevision),
  });

  // 1st mutation + flush starts while network is slow
  queue.markDirty();
  const p1 = queue.flush();

  // While 1st save is still in flight, student edits again and periodic/debounced flushes fire
  state = { step: 2, answer: 'B' };
  queue.markDirty();
  const p2 = queue.flush();
  state = { step: 3, answer: 'C' };
  queue.markDirty();
  const p3 = queue.flush();

  assert.equal(activeRequests, 1, 'must never issue overlapping saves');

  firstGate.resolve({ checkpointRevision: 18 });
  await Promise.all([p1, p2, p3]);

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(sentExpectedRevs, [17, 18]);
  assert.deepEqual(savedStatuses, [true, false]);
  assert.deepEqual(conflicts, []);
  assert.equal(queue.getRevision(), 19);
  assert.equal(queue.isDirty(), false);
});

test('CheckpointSaveQueue surfaces genuine external 409 conflicts and resumes after override', async () => {
  let serverRev = 5;
  const externalCheckpoint: DummyCheckpoint = { step: 9, answer: 'D' };
  const localState: DummyCheckpoint = { step: 4, answer: 'B' };
  let conflictSeen: number | null = null;
  let calls = 0;

  const queue = new CheckpointSaveQueue<DummyCheckpoint>({
    initialRevision: 4, // behind serverRev=5 (another device really saved)
    getPayload: () => ({ ...localState }),
    canSave: () => true,
    saveFn: async (_payload, expectedRevision) => {
      calls += 1;
      if (expectedRevision !== serverRev) {
        throw {
          status: 409,
          currentRevision: serverRev,
          serverCheckpoint: externalCheckpoint,
        };
      }
      serverRev += 1;
      return { checkpointRevision: serverRev };
    },
    onConflict: (c) => {
      conflictSeen = c.currentRevision;
    },
  });

  queue.markDirty();
  await queue.flush();
  assert.equal(conflictSeen, 5);
  assert.equal(queue.hasActiveConflict(), true);

  // Subsequent auto-flush while conflict is unresolved is suppressed
  await queue.flush();
  assert.equal(calls, 1);

  // User clicks "Keep this device's answers" with overrideExpectedRevision=5
  await queue.flush(5);
  assert.equal(calls, 2);
  assert.equal(queue.hasActiveConflict(), false);
  assert.equal(queue.getRevision(), 6);
});
