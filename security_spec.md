# Selective Lab Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Strict Account Isolation**: Every user document (`/users/{userId}` and subcollections `sessions`, `attempts`, `skill_states`, `question_memory`, `writing_submissions`) belongs strictly to the authenticated verified user whose `request.auth.uid == userId`, unless `isAdmin()`.
2. **No Self-Assigned Admin Escalation**: Users creating `/users/{userId}` may only set `role: "student"` and cannot elevate `role` or write `/admins/{uid}`.
3. **PII Isolation**: Email addresses live exclusively under `/users/{userId}/private/info` readable only by the owner or verified admin.
4. **Master Gate Relational Sync**: Subcollections under `/users/{userId}/...` verify parent `/users/{userId}` existence on `get`, `create`, and `update` (and enforce `resource.data.userId == request.auth.uid` on `list` without `get()`/`exists()` reads).
5. **Exam Integrity (Zero Answer-Key Leakage)**: Custom bank items with `correctAnswerKey` (`/bank_questions` and `/bank_stimuli`) are readable/writable strictly by verified admins (`isAdmin()`). Students cannot read `correctAnswerKey` from Firestore.
6. **Terminal State Lock on Submitted Sessions**: Once `/users/{userId}/sessions/{sessionId}` transitions `status: "in_progress" -> "submitted"`, no subsequent student update can reopen or mutate scores or answers.
7. **Server Timestamps & Strict Keys**: Every `create` requires `hasAll` + `hasOnly` with `createdAt == request.time`; every `update` uses `affectedKeys().hasOnly(...)`, preserves immutable IDs/`createdAt`, and sets `updatedAt == request.time`.

## 2. The "Dirty Dozen" Adversarial Payloads (Expected: PERMISSION_DENIED)
1. **Unverified email token** creating `/users/{uid}` -> denied by `request.auth.token.email_verified == true`.
2. **Self-assigned privilege escalation** creating `/users/{uid}` with `{ role: "admin" }` -> denied by `data.role == 'student'`.
3. **Shadow ghost field injection** creating session with `{ extraAdminFlag: true }` -> denied by `keys().hasOnly([...])`.
4. **Cross-user session read/list** querying `/users/otherUid/sessions` -> denied by `resource.data.userId == request.auth.uid`.
5. **Cross-user PII read** fetching `/users/otherUid/private/info` -> denied by `isOwner(userId)`.
6. **Student reading answer keys** querying `/bank_questions` -> denied by `isAdmin()`.
7. **Submitted session tampering** updating `/users/{uid}/sessions/{id}` when `existing().status == 'submitted'` -> denied by terminal state lock.
8. **Score forgery during checkpoint** updating `correctSlots` during an `in_progress` checkpoint save -> denied by action `affectedKeys().hasOnly(['checkpoint', 'updatedAt'])`.
9. **Spoofed timestamp** creating `/users/{uid}/attempts/{id}` with backdated `createdAt` (`!= request.time`) -> denied by temporal integrity rule.
10. **ID poisoning** creating document with `sessionId` containing `../` or length > 128 chars -> denied by `isValidId()`.
11. **Oversized essay / Denial-of-Wallet payload** writing `responseText.size() > 30000` -> denied by string boundary guard.
12. **Student modifying LearningConfig or QC status** updating `/admin_configs/{id}` or `/bank_question_overrides/{id}` -> denied by `isAdmin()`.
