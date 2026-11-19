# Selective Lab V3 architecture and product decision

Update after synced commit `4bfa2fd`: the user prefers the simplest Google-managed setup. The next pass should publish frontend and API together through AI Studio's managed Cloud Run workflow, with the existing Firebase services. Separate Firebase Hosting is optional rather than required. Optional emulator/ADC/demo settings must not become a manual onboarding checklist. See `V3-next-ai-studio-prompt.md` for the current follow-up request; the original proposal below records the earlier plan.

Prepared 16 November 2026. Code inspected: `857c8f090fadbf251c1ab899096a82317598071c`. This is a plan; no application or live-service changes have been made. Recheck the code in AI Studio before applying it because that copy may have newer work.

## Recommended stack

Use Google AI Studio for the final implementation pass, GitHub as the source of truth after handover, and local development thereafter. Host the Node/Express application on Google Cloud Run. Use Firebase Hosting for the custom-domain frontend and same-origin `/api/**` rewrites to Cloud Run. Keep the existing Firebase Authentication project and Firestore database. Store uploaded media in Cloud Storage, not the Cloud Run filesystem.

This recommendation is about fit and avoiding a database migration during a substantial feature change. It is not a claim that Google offers more raw storage for free.

| Concern | ChatGPT Sites | Recommended Google stack |
| --- | --- | --- |
| Database | Managed D1, up to 10 GB per Site; that is a capacity limit, not a promise of 10 GB permanently free. | Firestore Standard free quota: 1 GiB, 50,000 document reads/day, 20,000 writes/day and 10 GiB monthly outbound transfer. Usage beyond the allowance requires billing. |
| Hosting cost | Hosting currently free through 31 December 2026. Published documentation describes shared plan allowances and proposed usage rates from January 2027. | Firebase Hosting: 10 GB hosted files and 360 MB/day transfer in its no-cost allowance. Cloud Run, builds, artifact storage and uploaded media have separate usage/billing. Production requires a billing-enabled Google project for Cloud Run. |
| Custom domain | Supported. Domain registration is separate. Proposed January 2027 hosting rates include a custom-domain charge. | Firebase Hosting supports custom domains and SSL. Domain registration is separate. |
| Source sync | Sites has its own source and publication workflow; do not assume it automatically mirrors this GitHub repository. | Current AI Studio documentation supports GitHub push/pull sync. Use explicit pull/push steps and resolve conflicts before switching editors. GitHub-to-production deployment is a separate CI workflow. |
| Cross-device progress | Requires application identity and durable database behavior; storage alone does not implement sync. | Existing Firebase Auth identities can be retained. One authoritative Firestore-backed API serves every device. |
| Fit for this repository | Current Sites runtime uses Workers and HTTP-based connections. Hosting this Express/`pg` server would need adaptation; adopting D1 also means a data migration. | Existing React/Vite and Express server fit a standard Node deployment. The main missing piece is a real server Firestore repository. |

Official references, checked on the date above:

- [ChatGPT Sites developer guide: runtime, storage and pricing](https://learn.chatgpt.com/docs/sites)
- [ChatGPT Sites: availability, storage and custom domains](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites)
- [AI Studio Build: local development, Firebase and GitHub sync](https://aistudio.google.com/docs/aistudio-build-mode)
- [Firebase pricing](https://firebase.google.com/pricing)
- [Firestore quotas](https://firebase.google.com/docs/firestore/quotas)
- [Firebase Hosting with Cloud Run](https://firebase.google.com/docs/hosting/cloud-run)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)

API-key cost and age eligibility are outside this comparison, as requested. No plan change or provider signup is required by this document.

## The persistence issue to fix first

`src/server/storage/index.ts` currently chooses PostgreSQL when all four SQL settings exist and otherwise chooses process memory. Although the repository interface mentions Firestore, no server Firestore adapter exists. The browser separately copies data into Firestore, and several calls in `src/client/api.ts` suppress failures. Login pulls browser-readable cloud data back into the server. This permits partial saves, inconsistent instances and dependence on an admin signing in to hydrate custom questions.

Implement `FirestoreRepository` behind the existing repository interface. The API must grade and persist authoritative results, using verified Firebase identity and server credentials. Keep Firestore as the single production database; avoid dual writes to PostgreSQL. Production startup must fail visibly if persistence is unavailable. Memory mode is only an explicitly selected disposable demo/test mode.

Restrict the old hydrate endpoint: learners cannot supply authoritative grades, mastery, global configurations or question overrides. Migration is a separate admin/server process. Preserve existing data and original Firebase UIDs. Keep legacy attempts as history, but do not award strict mastery when their revision/assistance evidence cannot be established.

Successful submission means the server durably stored the result. Duplicate requests must not produce duplicate attempts or advancement. Save failures must be visible and retryable. Keep a local unsent draft if useful, clearly labeled as unsaved; do not promise offline grading or cross-device offline editing in this pass. Store checkpoints with revisions and reject stale writes so a second device cannot silently erase newer work.

Code export and data export are different. GitHub contains application code and deployment configuration; it does not contain Firestore records, user accounts, runtime credentials or uploaded media. Moving the code to a new host can reuse the same Firebase services after configuration. Moving the database requires an explicit backup and tested restore.

## Product decisions

### Shared simulator and solutions workspace

Use a shared renderer in exam, review and admin-preview modes. Keep passage/question/diagram context left and active-part options right. In review, display selected and correct options in their original order, then a concise correct-answer summary and explanation immediately under the options. Longer worked reasoning and distractor details can expand below. A compact question/part navigator supports all, incorrect and unanswered filters.

Target ordinary content at 1366×768 and 1440×900: readable options, answer summary and the beginning of the explanation should be visible together. Exceptionally long content uses independent pane scrolling or adjustable splits; never crop answers or shrink text to claim that all content fits. Mobile uses a passage/question switch with a visible route back to the answer.

Add optional authored evidence references tied to stimulus revision, block/extract and validated text ranges. Clicking an explanation citation focuses the exact occurrence in the passage. Student highlights and solution evidence are separate. Preserve questions without references; do not invent citations. Missing anchors show their quote without highlighting the wrong location.

### Strict mastery

Replace the displayed EWMA “mastery” percentage with distinct measures: bank coverage, recent accuracy, and retained mastery. Keep EWMA/SM-2 for scheduling only.

An eligible item is a current, active, objectively scored question released for that learner's practice, diagnostics or released exam-bank use. Include all its parts and every eligible variant; family membership does not substitute for answering it. Exclude protected benchmark holdouts, drafts, retired/quarantined questions, writing, sandbox and admin previews. Protected holdout exam results stay separate; do not turn reserved exam content into daily practice. Exclusions must be visible rather than silently changing the denominator.

For each eligible question revision, require three complete correct unaided first-submission passes: the initial pass, a confirmation at least 24 hours later, and a final confirmation at least seven days after the second. A later wrong graded attempt resets that question's current certification cycle. Same-day retries, hints/reveals before submitting, partial correctness, or repeated easy items cannot advance it. Reviewing solutions after an already-submitted pass does not retroactively erase that pass.

Full bank mastery requires every eligible question to meet that rule. Show counts such as “420/600 correct at least once; 83/600 retained” with explicit unseen and repair counts. Zero eligible questions means “No evidence.” Speed is a separate readiness measure and respects accommodations.

Adding a question increases the denominator. Meaningful changes to a question, its answer or dependent passage create a revision that needs fresh evidence; cosmetic edits do not. Preserve dated achievements against a particular bank revision. Writing uses rubric progress and feedback, and holdouts use separate exam results. This certifies demonstrated performance on the bank, not guaranteed success on unseen exams.

### Anki-style admin browser

Use a searchable, sortable list/table beside a full simulator preview. Every record must be reachable, with current versions by default and a historical-version toggle. Include section, format, skill, pool, QC, provenance, batch, timestamps and flags. Provide visible result totals and real pagination; the existing 40-item cap must go.

The important actions are “Simulate this,” “Simulate selected,” “Simulate filtered,” and “Simulate this import batch.” They must pass exact resolved IDs and versions to an admin-only sandbox endpoint, preserving order and complete question/stimulus dependencies. No random sampling fallback. Sandbox sessions never change learner progress or mastery. Draft and holdout previews remain admin-only.

After import, show the actual new and revised IDs, “View batch,” and “Simulate batch.” Persist import metadata, rather than inferring recency from ID names. Use the existing import validator and preserve content history.

## Delivery sequence

The companion AI Studio prompt requests one coordinated implementation, completed in internally testable stages: durable persistence and migration tooling, shared workspace, complete admin browser/exact simulation, strict mastery, then export/deployment verification. This sequence prevents polished UI from hiding the persistence problem.

After AI Studio finishes, push its changes to GitHub, pull locally, review the diff, and run the documented checks. Verify on emulators/staging before production: fresh server, two independent clients, imported question launch, submit/retry, server restart, new question added, and backup restored into a clean environment. Only then deploy and connect the custom domain. Do not allow local/AI Studio edits to overwrite each other without pulling first.
