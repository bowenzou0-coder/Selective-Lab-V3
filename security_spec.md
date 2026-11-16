# Selective Lab Firestore & API Security Specification (V3)

## 1. Server-Authoritative Architecture
- **Node/Express API as Sole Writer & Grader**: All mutations to bank content, `import_batches`, `media_assets`, `sessions`, `snapshots`, `attempts`, `skill_states`, `question_memory`, `question_evidence`, `writing_submissions`, `admin_configs`, and `question_flags` are performed exclusively by the authenticated Express server via Firebase Admin SDK.
- **Zero Client Writes in `firestore.rules` & `storage.rules`**: Direct Firestore SDK and Cloud Storage SDK client writes (`create`, `update`, `delete`) are explicitly denied (`if false`).
- **Pre-Submission Answer-Key Isolation**: `/bank_questions`, `/bank_stimuli`, `/import_batches`, `/media_assets`, and `/users/{uid}/sessions/{sessionId}/snapshots` have `allow read, write: if false;` on Firestore client rules. Students receive strictly stripped `StudentQuestionView` payloads during active exams and `MarkingResult` payloads only after authorized submission.

## 2. API Handler Authorization Invariants
1. **Verified Identity & Trusted Role Derivation**: `/api/auth/firebase-login` verifies the Firebase ID token server-side (`getAdminAuth().verifyIdToken(..., true)`) and derives `role` strictly from `/admins/{uid}` or `BOOTSTRAPPED_ADMIN_EMAIL`.
2. **Strict Session Ownership**: Every `/api/student/sessions/:id*` and `/api/student/writing/:submissionId/evaluate` endpoint verifies `ownerId === req.auth.studentId`, returning `403 Forbidden` on mismatch.
3. **Immutable Snapshots & Optimistic Concurrency**: `PATCH /api/student/sessions/:id/checkpoint` requires matching `checkpointRevision`, returning `409 Conflict` with authoritative server state when a stale device saves.
4. **Idempotent Atomic Finalization**: `POST /api/student/sessions/:id/submit` executes transactionally via `finalizeSessionAtomically` with deterministic attempt/writing IDs so retries return the original `submissionSummary` without double-counting mastery or memory.
5. **Retired Browser Hydration**: `/api/sync/hydrate` returns `410 Gone`; legacy/canonical migrations run only via privileged admin tooling (`/api/admin/migrate/preflight`, `/api/admin/migrate/apply`, `/api/admin/restore`).
