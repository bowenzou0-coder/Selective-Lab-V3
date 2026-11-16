import assert from 'node:assert/strict';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import type { BankImportManifest, SessionQuestionSnapshot, SessionRecord } from '../../shared/contracts.ts';
import { computeEvidenceRevision } from '../../shared/mastery.ts';
import { FirestoreRepository } from './firestoreRepository.ts';
import { RevisionConflictError } from './repository.ts';

/**
 * Behavioral in-memory Firestore double supporting collections, nested subcollections,
 * where/orderBy/startAfter/limit queries, DocumentId ordering, WriteBatch, and runTransaction.
 */
class FakeFirestore {
  private docs = new Map<string, Record<string, unknown>>();

  collection(path: string): FakeCollectionRef {
    return new FakeCollectionRef(this, path);
  }

  _getDoc(path: string): Record<string, unknown> | undefined {
    const val = this.docs.get(path);
    return val ? structuredClone(val) : undefined;
  }

  _setDoc(path: string, data: Record<string, unknown>, merge = false): void {
    const prev = merge ? this.docs.get(path) || {} : {};
    this.docs.set(path, { ...structuredClone(prev), ...structuredClone(data) });
  }

  _updateDoc(path: string, data: Record<string, unknown>): void {
    const prev = this.docs.get(path);
    if (!prev) {
      throw new Error(`NOT_FOUND: No document to update at ${path}`);
    }
    this.docs.set(path, { ...structuredClone(prev), ...structuredClone(data) });
  }

  _listDirectChildren(collectionPath: string): { id: string; path: string; data: Record<string, unknown> }[] {
    const prefix = `${collectionPath}/`;
    const items: { id: string; path: string; data: Record<string, unknown> }[] = [];
    for (const [docPath, data] of this.docs.entries()) {
      if (!docPath.startsWith(prefix)) continue;
      const remainder = docPath.slice(prefix.length);
      if (remainder.includes('/')) continue;
      items.push({ id: remainder, path: docPath, data: structuredClone(data) });
    }
    return items;
  }

  batch(): FakeWriteBatch {
    return new FakeWriteBatch(this);
  }

  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx = new FakeTransaction(this);
    const res = await fn(tx);
    tx.commit();
    return res;
  }
}

class FakeDocRef {
  readonly id: string;
  readonly path: string;
  private db: FakeFirestore;

  constructor(db: FakeFirestore, path: string) {
    this.db = db;
    this.path = path;
    const parts = path.split('/');
    this.id = parts[parts.length - 1];
  }

  collection(sub: string): FakeCollectionRef {
    return new FakeCollectionRef(this.db, `${this.path}/${sub}`);
  }

  async get(): Promise<{ exists: boolean; id: string; data: () => Record<string, unknown> | undefined }> {
    const d = this.db._getDoc(this.path);
    return {
      exists: d !== undefined,
      id: this.id,
      data: () => (d ? structuredClone(d) : undefined),
    };
  }

  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    this.db._setDoc(this.path, data, Boolean(opts?.merge));
  }

  async update(data: Record<string, unknown>): Promise<void> {
    this.db._updateDoc(this.path, data);
  }
}

class FakeQuery {
  protected db: FakeFirestore;
  protected collectionPath: string;
  protected filters: Array<{ field: string; value: unknown }> = [];
  protected orderField?: string;
  protected orderDir: 'asc' | 'desc' = 'asc';
  protected limitNum?: number;
  protected cursorId?: string;

  constructor(
    db: FakeFirestore,
    collectionPath: string,
    opts?: {
      filters?: Array<{ field: string; value: unknown }>;
      orderField?: string;
      orderDir?: 'asc' | 'desc';
      limitNum?: number;
      cursorId?: string;
    }
  ) {
    this.db = db;
    this.collectionPath = collectionPath;
    this.filters = opts?.filters || [];
    this.orderField = opts?.orderField;
    this.orderDir = opts?.orderDir || 'asc';
    this.limitNum = opts?.limitNum;
    this.cursorId = opts?.cursorId;
  }

  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, {
      filters: [...this.filters, { field, value }],
      orderField: this.orderField,
      orderDir: this.orderDir,
      limitNum: this.limitNum,
      cursorId: this.cursorId,
    });
  }

  orderBy(field: unknown, dir: 'asc' | 'desc' = 'asc'): FakeQuery {
    const f = typeof field === 'string' ? field : '__name__';
    return new FakeQuery(this.db, this.collectionPath, {
      filters: this.filters,
      orderField: f,
      orderDir: dir,
      limitNum: this.limitNum,
      cursorId: this.cursorId,
    });
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, {
      filters: this.filters,
      orderField: this.orderField,
      orderDir: this.orderDir,
      limitNum: n,
      cursorId: this.cursorId,
    });
  }

  startAfter(docSnap: { id: string }): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, {
      filters: this.filters,
      orderField: this.orderField,
      orderDir: this.orderDir,
      limitNum: this.limitNum,
      cursorId: docSnap.id,
    });
  }

  async get() {
    let rows = this.db._listDirectChildren(this.collectionPath).filter((row) =>
      this.filters.every((f) => row.data[f.field] === f.value)
    );

    if (this.orderField) {
      const f = this.orderField;
      const mult = this.orderDir === 'desc' ? -1 : 1;
      rows = rows.sort((a, b) => {
        const va = f === '__name__' ? a.id : a.data[f];
        const vb = f === '__name__' ? b.id : b.data[f];
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
        return String(va ?? '').localeCompare(String(vb ?? '')) * mult;
      });
    }

    if (this.cursorId) {
      const idx = rows.findIndex((r) => r.id === this.cursorId);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    if (this.limitNum !== undefined) {
      rows = rows.slice(0, this.limitNum);
    }

    const docs = rows.map((r) => ({
      id: r.id,
      exists: true,
      data: () => structuredClone(r.data),
    }));
    return { empty: docs.length === 0, docs };
  }
}

class FakeCollectionRef extends FakeQuery {
  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.collectionPath}/${id}`);
  }
}

class FakeWriteBatch {
  private db: FakeFirestore;
  private ops: Array<() => void> = [];

  constructor(db: FakeFirestore) {
    this.db = db;
  }

  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): void {
    this.ops.push(() => this.db._setDoc(ref.path, data, Boolean(opts?.merge)));
  }

  update(ref: FakeDocRef, data: Record<string, unknown>): void {
    this.ops.push(() => this.db._updateDoc(ref.path, data));
  }

  async commit(): Promise<void> {
    for (const op of this.ops) op();
    this.ops = [];
  }
}

class FakeTransaction {
  private db: FakeFirestore;
  private ops: Array<() => void> = [];

  constructor(db: FakeFirestore) {
    this.db = db;
  }

  async get(ref: FakeDocRef) {
    return ref.get();
  }

  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): void {
    this.ops.push(() => this.db._setDoc(ref.path, data, Boolean(opts?.merge)));
  }

  update(ref: FakeDocRef, data: Record<string, unknown>): void {
    this.ops.push(() => this.db._updateDoc(ref.path, data));
  }

  commit(): void {
    for (const op of this.ops) op();
  }
}

function createRepo(): FirestoreRepository {
  const fake = new FakeFirestore();
  return new FirestoreRepository({
    db: fake as unknown as Firestore,
    serverTimestamp: () => new Date().toISOString(),
    documentIdField: () => '__name__',
  });
}

function sampleManifest(label = 'Batch 1', version = 1): BankImportManifest {
  return {
    manifestVersion: '1.0',
    batchLabel: label,
    defaultPoolType: 'practice',
    defaultQcStatus: 'active',
    stimuli: [],
    questions: [
      {
        questionId: `q_fs_1_v${version}`,
        questionFamilyId: 'q_fs_1',
        version,
        section: 'MATH',
        formatType: 'MATH_MCQ_5',
        poolType: 'practice',
        qcStatus: 'active',
        parts: [
          {
            partId: `q_fs_1_v${version}_p1`,
            partIndex: 0,
            promptText: version === 1 ? '2 + 3 = ?' : '2 + 4 = ?',
            skillId: 'MATH.NUM.NUMBER_SEQUENCES',
            difficultyInitial: 1.5,
            targetTimeSec: 60,
            cognitiveDemand: 'apply_procedural',
            options: [
              { key: 'A', text: '5' },
              { key: 'B', text: '6' },
            ],
            correctAnswerKey: version === 1 ? 'A' : 'B',
            workedExplanation: 'Arithmetic sum.',
          },
        ],
        provenance: {
          sourceType: 'human_authored',
          verifierAgreed: true,
          auditorReviewed: true,
        },
      },
    ],
  };
}

test('FirestoreRepository seeds defaults, bumps question versions cleanly, and paginates queries', async () => {
  const repo = createRepo();
  await repo.initAndSeedIfEmpty(sampleManifest('Seed V1', 1));

  const cfg = await repo.getActiveConfig();
  assert.equal(cfg.versionNumber, 1);
  assert.equal(cfg.config.sessionDefaults.sectionDrillQuestionCount, 10);

  const page1 = await repo.listQuestionsPaginated({ page: 1, pageSize: 10 });
  assert.equal(page1.totalMatching, 1);
  assert.equal(page1.questions[0].questionId, 'q_fs_1_v1');

  // Bump version via new manifest import
  const importRes = await repo.importManifest(sampleManifest('Batch V2', 2), 'admin@test');
  assert.equal(importRes.versionBumped, 1);

  const versions = await repo.listQuestionVersions('q_fs_1');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].question.version, 2);
  assert.equal(versions[1].question.version, 1);

  const batches = await repo.listImportBatches();
  assert.equal(batches.length, 2);
});

test('FirestoreRepository enforces optimistic checkpoint concurrency and atomic idempotent submission', async () => {
  const repo = createRepo();
  await repo.initAndSeedIfEmpty(sampleManifest('Seed', 1));

  const q = (await repo.listQuestions())[0];
  const rev = q.evidenceRevision || computeEvidenceRevision(q);
  const snapshots: SessionQuestionSnapshot[] = [
    {
      questionId: q.questionId,
      snapshotIndex: 0,
      evidenceRevision: rev,
      question: q,
    },
  ];
  const session: SessionRecord = {
    sessionId: 'sess_fs_1',
    studentId: 'user_abc',
    configVersionId: 'cfg_v1',
    mode: 'section_drill',
    status: 'in_progress',
    plannedQuestionIds: [q.questionId],
    checkpointRevision: 1,
    checkpoint: {
      currentIndex: 0,
      elapsedSec: 0,
      answersByPartId: {},
      flaggedQuestionIds: [],
    },
    totalSlots: 1,
    correctSlots: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
  };

  await repo.createSession(session, snapshots);

  // Matching expectedRevision succeeds and bumps revision to 2
  const cpSave = await repo.saveSessionCheckpoint(
    session.sessionId,
    'user_abc',
    {
      currentIndex: 0,
      elapsedSec: 20,
      answersByPartId: { [q.parts[0].partId]: 'A' },
      flaggedQuestionIds: [],
    },
    1
  );
  assert.equal(cpSave.checkpointRevision, 2);

  // Stale expectedRevision throws RevisionConflictError with server state
  await assert.rejects(
    () =>
      repo.saveSessionCheckpoint(
        session.sessionId,
        'user_abc',
        {
          currentIndex: 0,
          elapsedSec: 5,
          answersByPartId: { [q.parts[0].partId]: 'B' },
          flaggedQuestionIds: [],
        },
        1
      ),
    (err: unknown) => err instanceof RevisionConflictError && err.currentRevision === 2
  );

  // Atomic finalize + idempotent retry
  const finInput = {
    sessionId: session.sessionId,
    studentId: 'user_abc',
    checkpoint: {
      currentIndex: 0,
      elapsedSec: 25,
      answersByPartId: { [q.parts[0].partId]: 'A' },
      flaggedQuestionIds: [],
    },
    correctSlots: 1,
    totalSlots: 1,
    completedAtIso: '2026-01-01T00:01:00.000Z',
    submissionSummary: {
      ok: true as const,
      correctSlots: 1,
      totalSlots: 1,
      completedAt: '2026-01-01T00:01:00.000Z',
      checkpoint: {
        currentIndex: 0,
        elapsedSec: 25,
        answersByPartId: { [q.parts[0].partId]: 'A' },
        flaggedQuestionIds: [],
      },
      attempts: [],
      skillStates: [],
      questionMemory: [],
      reviewResults: {},
      writingReview: [],
    },
    attempts: [
      {
        attemptId: `att_${session.sessionId}_${q.parts[0].partId}`,
        studentId: 'user_abc',
        sessionId: session.sessionId,
        questionId: q.questionId,
        questionFamilyId: q.questionFamilyId,
        questionVersion: q.version,
        evidenceRevision: rev,
        partId: q.parts[0].partId,
        skillId: q.parts[0].skillId,
        difficultyAtAttempt: 1.5,
        selectedAnswer: 'A',
        isCorrect: true,
        timeSpentSec: 25,
        isSpacedReview: false,
        createdAt: '2026-01-01T00:01:00.000Z',
      },
    ],
    skillStates: [],
    questionMemory: [
      {
        questionFamilyId: q.questionFamilyId,
        timesSeen: 1,
        lastSeenAt: '2026-01-01T00:01:00.000Z',
        lastAllCorrect: true,
        nextDueAt: '2026-01-02T00:01:00.000Z',
        intervalDays: 1,
        lapseCount: 0,
      },
    ],
    evidenceUpdates: [
      {
        evidenceKey: `${q.questionFamilyId}__${rev}`,
        questionFamilyId: q.questionFamilyId,
        questionId: q.questionId,
        evidenceRevision: rev,
        section: q.section,
        status: 'correct_once' as const,
        cleanPassesCount: 1,
        passTimestampsIso: ['2026-01-01T00:01:00.000Z'],
        everCleanPassed: true,
        firstSubmissionCleanPass: true,
        attemptsCount: 1,
        resetCount: 0,
        lastAttemptAtIso: '2026-01-01T00:01:00.000Z',
        lastAllCorrect: true,
        policyVersion: 'v3_3stage_24h_7d',
        updatedAtIso: '2026-01-01T00:01:00.000Z',
      },
    ],
    writingSubmissions: [],
  };

  const first = await repo.finalizeSessionAtomically(finInput);
  assert.equal(first.alreadySubmitted, false);

  const retry = await repo.finalizeSessionAtomically(finInput);
  assert.equal(retry.alreadySubmitted, true);

  const attemptsAfter = await repo.listPartAttempts(100, 'user_abc');
  assert.equal(attemptsAfter.length, 1);
  const evidenceAfter = await repo.getQuestionEvidence('user_abc');
  assert.equal(Object.keys(evidenceAfter).length, 1);

  // Backup export + dry-run/apply restore into a fresh Firestore instance + preflight
  const backup = await repo.exportFullBackup();
  assert.equal(backup.schemaVersion, 'v3_canonical_1.0');
  assert.equal(backup.users.length, 1);

  const targetRepo = createRepo();
  const dry = await targetRepo.restoreFullBackup(backup, { dryRun: true });
  assert.equal(dry.valid, true);
  assert.equal(dry.checksumVerified, true);
  assert.equal(dry.wouldCreate.questions, 1);
  assert.equal((await targetRepo.listQuestions()).length, 0);

  const applied = await targetRepo.restoreFullBackup(backup, { dryRun: false });
  assert.equal(applied.valid, true);
  assert.equal(applied.applied.sessions, 1);
  assert.equal(applied.applied.attempts, 1);
  assert.equal((await targetRepo.listQuestions()).length, 1);

  const preflight = await targetRepo.runMigrationPreflight();
  assert.equal(preflight.totalSessions, 1);
  assert.equal(preflight.sessionsMissingSnapshots, 0);
});
