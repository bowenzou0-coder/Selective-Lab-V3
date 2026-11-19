# Paste into the existing Selective Lab V3 project in Google AI Studio

Historical initial V3 brief. For the current follow-up use `V3-next-ai-studio-prompt.md`. The app's current contract is authoritative: adapt `selective-lab-question-skill` and its generated JSON to the app, not the app's schema or dependencies to the skill. The skill's authoring preferences are not application constraints.

Implement this coordinated V3 completion pass in the existing application. Inspect the current project first; the handover inspected GitHub commit `857c8f090fadbf251c1ab899096a82317598071c`, but this AI Studio copy may be newer. Preserve existing working behavior and current content. Complete the implementation and verification, rather than responding with only a plan or mock UI. Work through the stages below in order within this request and report any genuine blockers precisely.

## 1. Fixed architecture decisions

- Keep React, Vite, TypeScript and the Express/Node server. Do not change frameworks or rebuild the app from a starter.
- Keep the existing Firebase project, Firebase Auth identities/UIDs and exact Firestore database ID. Use Firestore as the single authoritative production database. Preserve current records and imported question banks. Do not provision a replacement Firebase project or silently select a default database instead of the configured database.
- Target Cloud Run for the Node API, Firebase Hosting for built frontend files and custom-domain HTTPS, with same-origin `/api/**` rewrites to Cloud Run. Prepare the configuration and deployment instructions; do not deploy to production, modify live DNS, delete cloud resources or apply a destructive migration as part of this prompt.
- Retain the existing repository abstraction. Implement a real server `FirestoreRepository`; do not leave Firestore as a browser-mediated backup. Preserve other adapters for explicit compatibility if needed, but never dual-write multiple production databases.
- At the inspected commit, `src/server/storage/index.ts` falls back to `MemoryRepository` without SQL settings, and `src/client/api.ts` suppresses errors from browser Firestore mirroring. Recheck and fix the underlying behavior. Production must fail clearly when durable storage/auth configuration is missing. Memory is allowed only in explicit disposable demo/test mode and must be labeled.
- Keep Firebase Auth on the client for sign-in. Verify identity on the server and derive roles from trusted server/admin data. Every session/checkpoint/submission/review/export route must enforce ownership or an explicit admin permission. Never trust client-supplied user IDs, scores, mastery or admin flags.
- Make the server the sole authoritative writer/grader for bank content, sessions, attempts, writing records, derived progress and mastery. Restrict Firestore client rules accordingly; any direct client read must be narrowly scoped. Firebase Admin bypasses rules, so enforce authorization in API handlers as well. Preserve a documented way to bootstrap the existing admin securely.
- Remove normal-login dependence on `/api/sync/hydrate`. Learners must not hydrate global configuration, question overrides, grades or mastery from the browser. Move legacy migration to validated, privileged tooling with a dry run.
- Use application-default credentials/service identity in Cloud Run, and emulators by default locally. Document any opt-in local access to an existing cloud project. Never put private server credentials into client code or committed files. Public Firebase project settings must be configurable and validated consistently on client and server.
- Upload new media to Cloud Storage using stable object keys and validated uploads; runtime local files are temporary. Preserve bundled seed assets. Provide a migration manifest for old `/assets/uploads` files, with missing-file detection, without deleting originals.

## 2. Make persistence and sync dependable

Inventory all existing collections and repository operations before implementing the adapter. Persist questions, all relevant revisions, stimuli, import batches, configuration versions, users' sessions/checkpoints, attempts, memory/scheduling state, writing/evaluations, flags and mastery evidence. Do not store the whole bank or an unbounded history in a single document. Use bounded paginated queries and commit required Firestore indexes/rules with the code.

A successful submit response must mean durable persistence has completed. Grade on the server against the immutable question/stimulus/answer snapshot attached to the session. Record question revision, option order, selected answers, assistance and timestamps. A later bank edit must not change grading or review of an older session. Student exam payloads must never expose answer keys, explanations, distractor rationale, evidence references that reveal answers, or decoy markers before authorized submission.

Make submit/finalization idempotent: retrying the same session submission must return its original result without duplicate attempts, mastery advances or scheduling changes. Protect concurrent submissions. Persist attempts and derived state consistently with session completion, using a bounded transaction or staged writes with an atomic completion marker when transaction limits require it. Do not leave partially finalized sessions treated as submitted. Include meaningful failure/retry tests.

Save checkpoint revisions with optimistic concurrency checks. A stale second-device save must not overwrite newer work silently. Show Saving/Saved/Save failed in the interface, with a retry path and recoverable unsent local draft where appropriate. Distinguish an unsent draft from cloud-saved work. Full offline grading/edit merging is not required. Two devices must retrieve the same saved authoritative state without an administrator logging in first, after server restart and across multiple server instances.

## 3. One question workspace for exam, review and admin preview

Refactor the existing simulator renderers into shared components with explicit exam/review/adminPreview modes. Reuse the current styles and established exam interactions; this is a consistency and usability refactor.

Desktop layout:

- Left: passage/extracts, question context and relevant diagram/table/visual. Preserve the reading layout and the relevant question stem.
- Right: active question/part prompt as needed, all original options in their original order, then the solution directly below the options in review mode. The correct-answer summary and first useful explanation paragraph should be visible for ordinary questions without scrolling past a separate page of results.
- Preserve option labels, spacing, selection geometry, images and shared option-pool behavior across exam, review and preview. In review, options are read-only and show both the student's selection and correct option using text/icons as well as color. Explicitly identify unanswered parts.
- Show one active question/part with compact question and part navigation, Previous/Next, and review filters All/Incorrect/Unanswered. Preserve multipart questions, cloze, gapped text and multiple-match behavior. Do not turn the review into a giant stacked answer list.
- Keep a concise answer/explanation area under options and allow longer reasoning/distractor detail to expand. Use adjustable or independently scrollable panes when content is genuinely long. Maintain readable font sizes; do not clip options, force tiny type, or promise zero scrolling for arbitrarily long content.
- At 1366×768 and 1440×900, verify ordinary reading, maths and thinking questions show context, options and answer summary together. On mobile, use an accessible Passage / Question & Solution switch or equivalent with clear jump controls; no horizontal overflow or inaccessible fixed-height panels. Preserve keyboard navigation, focus visibility, zoom, and semantic reading order.
- Keep writing's editor and review suited to writing, while sharing relevant context/navigation components.

At the inspected commit, `PostSubmissionReview.tsx` renders explanations without the original passage/options/visuals, while `SessionPlayerView.tsx` already has the useful split layout. Recheck and replace that divergence with shared renderers, avoiding a second implementation of each question format.

## 4. Reliable reading evidence and highlights

Preserve students' existing highlights. Add optional authored evidence references to worked solutions, using a stable reference ID, stimulus revision, extract/block ID, validated text range and quote (or an equivalently robust anchored model). Clicking a citation in a solution must open the correct extract and focus/highlight the exact occurrence within the left pane. Repeated phrases must not highlight every occurrence.

Keep student marks distinct from authored solution evidence, with a visible legend/label and more than color alone. Store evidence as versioned question content and validate anchors during import/edit. If an anchor is stale, display its quoted citation without marking unrelated text. Existing questions without references must continue working. Do not fabricate evidence or regenerate the entire question bank to add it. Never send authored answer evidence during an unsubmitted exam.

## 5. Anki-style admin question browser and exact simulation

Replace the limited admin question list with a functional browser: searchable/sortable list or table on the left, full shared question workspace preview on the right. Keep import/configuration tools accessible without crowding the browsing task.

Requirements:

- Every question must be reachable. Remove the inspected `filteredQuestions.slice(0,40)` cap. Use stable pagination and, if useful, virtualization. Display matching totals and the current range. Default to current versions; provide a clear historical-version toggle. Preserve immutable old content referenced by past sessions.
- Search globally across the bank rather than only the visible page: exact IDs, question/passage text, option/explanation text, skills, tags, source and batch. Implement a documented approach appropriate to the bank size; Firestore does not provide arbitrary native full-text search. Use a bounded server-side catalog/index strategy or clearly specified token/prefix semantics, rather than pretending a current-page filter is global search. Avoid a new paid search dependency for this pass unless indispensable and explicitly reported.
- Filters: section, format, skill, pool, QC status, source, import batch, recently added/updated, flags and missing required content/visuals. Show columns such as ID, preview snippet, section, format, skills, pool, QC, source/batch, version, timestamps and flag count. Hide less-used columns responsively. Unknown legacy timestamps must be labeled unknown, not invented.
- Provide keyboard navigation, row selection, full preview of every part/stimulus/extract/option/visual/explanation, deep links by ID/version, and preserved search/selection when returning from preview/simulation.
- Row action: Simulate this. Multi-select action: Simulate selected. Filter action: Simulate filtered. Import-batch action: Simulate this batch.
- Implement an admin-only server API accepting explicit ordered question IDs/revisions. Validate missing IDs, duplicates, permissions and dependencies; give actionable errors. Launch exactly that selection in the shared simulator. Do not silently substitute random or first-N questions. Resolve filtered selections server-side and show the count/order before launch; large sets can be chunked explicitly with no omitted records.
- Sandbox must be the default and enforced server-side. Admin previews and sandbox sessions must never change learner attempts, progress, SM-2 state or mastery. Permit draft/quarantined/holdout preview only for authorized admins and label status clearly. Preserve student holdout exclusion rules.
- Make import batches durable. Import commit must return resolved new/revised/skipped question IDs and batch identity, rather than counts alone. After import, show View this batch and Simulate this batch immediately. Persist created/updated/imported timestamps and source/batch membership for new content. Do not infer a batch from question naming patterns.
- Reuse the existing schema/dry-run validator, detect duplicates and preserve version history. Content edits use the same validation path. Prefer status retirement to destructive deletion of referenced questions.

## 6. Replace inflated mastery with evidence over the whole available bank

The current inspected engine starts skill mastery at 0.5 and advances an EWMA, including a speed bonus. Repetition of a narrow set can approach 99%. Keep any useful estimate for scheduling, rename it Recent accuracy estimate, and stop presenting it as proof of mastery.

Implement these deterministic definitions:

1. Eligible bank: every current, active, objectively scored question released to the learner for practice, diagnostics or released exam-bank use. Include all parts and distinct eligible variants, not just one representative per family or only the practice pool. Exclude protected benchmark holdouts, drafts, quarantine, retired items, writing, admin previews and sandbox attempts. Define which released official-calibration/exam items are eligible using the actual catalog rules; show the included/excluded counts. Protected holdout exam performance stays separate. Do not expose reserved holdouts to meet a coverage target.
2. Correct once coverage: eligible question revisions with a full, correct, unaided first-submission pass on every part in the same attempt, divided by total eligible question revisions. Partial correctness does not qualify. Another family member does not substitute.
3. Retained mastery: each eligible question revision needs three full clean passes: initial pass, a second at least 24 hours later, and a third at least seven days after the second. Use server timestamps. Repeated attempts sooner may be recorded as practice but cannot advance the certification cycle. Hints/answer reveals before submitting disqualify that attempt. Viewing the solution after submitting does not retroactively invalidate a clean pass already earned.
4. Any later server-graded, non-sandbox submitted attempt containing that question with at least one wrong or unanswered scored part invalidates that revision's current certification and resets its certification cycle; preserve the history and show Needs repair. Assistance never advances certification. Do not punish the learner for admin sandbox activity. Assistance is tracked by the server where the app can observe it; do not claim external help can be detected.
5. Full bank mastery is possible only when every eligible question revision has retained mastery. Overall and skill-level summaries must show the actual denominators, unseen items, correct-once count, awaiting-review count, retained count and needs-repair count. A zero denominator is No evidence, not 100%. Round display carefully so 99.96% cannot appear as completed mastery. Show explicit counts alongside percentages.
6. Adding eligible questions increases the denominator immediately. Answer-bearing question/stimulus changes create a new evidence revision and require fresh qualification only for affected items. Cosmetic changes must not reset learning evidence. Preserve dated achievements for completed bank revisions, distinguish them from current mastery, and record the mastery-policy version.
7. Keep objective bank mastery, benchmark exam results, writing rubric progress and speed/readiness separate. Speed cannot create correctness or mastery; respect time accommodations. Legacy attempts without reliable revision/assistance evidence remain historical progress with a clear legacy label, not automatically certified mastery.
8. Schedule unseen/needs-repair/due-confirmation work so students can deliberately work toward complete coverage. Keep family-based spacing for scheduling, but track evidence per question revision. Update family exposure once per question encounter rather than once per part.

Persist raw evidence and derive/rebuild summaries reproducibly. Students must not be able to submit arbitrary mastery percentages. Make policy thresholds named constants/configuration with versioned semantics and transparent UI explanations, rather than magic values scattered through components.

## 7. Export, migration and local portability

Provide an explicit, canonical versioned backup format and tested restore path. A question manifest importer alone is not full recovery.

- Export all pages, without the current inspected 5,000-attempt/500-session truncation. Include relevant bank revisions/stimuli, configurations, import metadata, sessions and snapshots, attempts, writing/evaluations, flags, scheduling/memory and mastery evidence, with original ownership IDs and timestamps.
- Include a manifest with schema version, export consistency information, counts, checksums and asset references. Stream/chunk large exports. Reject incomplete or incompatible restores clearly.
- Provide restore dry run, validation and idempotent merge into a clean emulator/staging environment. Detect conflicting IDs/revisions rather than overwriting newer data silently. Include rollback instructions. Keep restores privileged and out of learner-accessible endpoints.
- Provide an explicit preflight migration report for existing Firestore/Postgres-shaped/browser-mirror data. Read existing field mappings, preserve IDs and history, identify inconsistent or untrusted legacy evidence and avoid silent data loss. Do not run a production migration in this prompt. Preserve old data until staged validation passes.
- A JSON database export does not contain Firebase Auth accounts/credentials or external asset bytes. Document separate Auth account handling and include downloadable media or a verified object manifest with a migration command. Do not claim changing a Firebase project preserves logins automatically.
- Document code export versus data export: running exported code against the same Firebase project reuses existing cloud data; ZIP/GitHub alone does not copy it. Record authorized-domain/OAuth settings, exact database ID, storage bucket, service-account/IAM setup, cookies and Hosting rewrites required for localhost/staging/production.
- Use a clean-clone workflow: install from the lockfile, copy `.env.example`, start emulators with seed fixtures, run the app, test, build, start production. Supply missing scripts/configuration and commit the lockfile. Keep local defaults pointed at emulators; no production writes just because a developer runs `npm run dev`.
- Add a normal production build/start path, Cloud Run container/source-build configuration, Firebase Hosting/rules/index configuration and a deployment runbook. Keep relative `/api` requests and correct SPA/deep-link routing. Prepare a GitHub deployment workflow with documented environment/identity setup; do not activate production deployment or publish credentials.

## 8. Verification and completion criteria

Run the existing type checks/build and relevant tests. Add meaningful tests for the changed persistence, authorization, marking, mastery and restore behavior, using emulators/test fixtures without live student data. Verify the rendered UI when preview access is available and distinguish executed checks from manual checks still needed.

Demonstrate these scenarios:

- A question beyond result 40 can be found, fully previewed and launched.
- Importing a new multi-part reading question produces a batch link and launches exactly its resolved ID, with every extract/option/visual present.
- Selecting three arbitrary questions launches exactly those three in order, including dependencies, with no student progress mutation.
- Reading/maths/thinking review matches the simulator workspace, retains original options and shows selected/correct states plus the solution under options. A long-content and mobile case remains usable.
- An evidence citation chooses the correct occurrence of repeated text. Missing/legacy evidence degrades cleanly. Active exam responses contain no solution fields.
- Fresh API instances can serve imported questions and retrieve saved progress before any admin signs in. Restart does not lose sessions or media. Independent clients see the same saved state; a stale checkpoint is rejected visibly.
- Submission retries/concurrent requests do not duplicate evidence. A simulated persistence failure never shows a false Saved/Submitted state. Unauthorized users cannot read/change another session or supply trusted mastery/global data through hydration.
- Repeating one question cannot master another; one incorrect part fails the whole question; early repeats do not advance delayed confirmation; later error resets only the affected certification; sandbox never advances it; zero eligible items shows No evidence; adding a question or changing answer-bearing content updates the denominator correctly; cosmetic edits preserve evidence; legacy history does not fabricate certification.
- Full backup restores into a clean emulator with matching counts, relationships, media verification and recomputable mastery. Running restore twice is safe. Unsupported/incomplete backups fail with actionable messages.
- A clean GitHub checkout runs locally with documented commands and builds for the prepared production deployment, including API/deep links and Firebase configuration.

Finish with a concise change summary, migration/configuration steps still needing real environment setup, commands run and their actual results, UI verification performed, and any unresolved blockers. Do not call V3 complete if durable saving, exact simulation, bank-wide mastery, or backup recovery is still mocked or unverified. Preserve unrelated files and system services.
