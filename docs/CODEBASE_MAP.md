# Codebase map

Vite + React 19 client, Express API (one Vercel function), Neon Postgres. Find the file here before opening anything large.

| Area | Path | Notes |
| --- | --- | --- |
| Entrypoint | `server.ts` → `src/server/app.ts` | `createApp()` wires middleware, static files, routes. `api/index.ts` is the Vercel handler. |
| Shared route state | `src/server/context.ts` | `ensureSeeded` (memory demo only), monitored-learner resolution. |
| Routes | `src/server/routes/*.ts` | `auth` (health, media, sign-in), `student` (dashboard), `sessions` (create/get/checkpoint/submit), `studentProgress` (writing eval, flags, progress, export), `studentSettings` (`/api/student/settings*` daily-plan prefs, recalibrate, onboarding flag; study-progress reset; own flags; account delete), `benchmarks` (`/api/student/benchmarks[/:sessionId[/analyze]]` saved reports + AI coaching), `adminLearners` (incl. learner delete), `adminBank` (status, questions, bulk-status, batches, calibration, import), `adminSystem` (config, flags, backup, migrate). |
| Session grading/expiry | `src/server/sessionLifecycle.ts` | Snapshots, finalize, deadline auto-submit. |
| Repository contract | `src/server/storage/repository.ts` | `AppRepository`, `QuestionMeta`, `QuestionSelectionItem`, query params. |
| Backup/restore | `src/server/storage/postgresBackup.ts`, `MemoryRepository.exportFullBackup/restoreFullBackup`, `repositoryUtils.ts` (`finalizeBackupBundle`, `validateIncomingBackupBundle`) | Canonical `v3_canonical_1.0` bundle. Per-user sections include `dailyFocusPlans`, `benchmarkReports`, `learnerPreferences` (all optional for older bundles). New tables must be added to export, restore, `LOCK TABLE`, and the Postgres backup test's `BACKUP_TABLES`. |
| Postgres | `src/server/storage/postgresRepository.ts`, `postgresQueries.ts` | SQL-level filtering, pagination, aggregates & targeted reads; schema/indexes in `runSchemaInit` (bump `SCHEMA_MARKER` when adding DDL). |
| Bank cache | `src/server/storage/questionBankCache.ts` | Fingerprint-validated slim selection/meta caches + full-bank fallback for backup/preflight; clone before mutating. |
| Filtering/paging | `src/server/storage/repositoryUtils.ts` | `filterAndPaginateQuestions`, `summarizeBatches`. |
| Memory repo | `src/server/storage/memoryRepository.ts` | `dev:demo` and API tests. |
| AI | `src/server/geminiPlanner.ts`, `geminiWriting.ts`, `geminiClient.ts`, `geminiBenchmarkCoach.ts` | Daily plans, practice order, writing feedback, benchmark-report coaching (`generateBenchmarkAiCoaching`). |
| NSW benchmark engine | `src/shared/nswBenchmark.ts` | Scaled /120 score, percentile/rank estimate, section weightings, difficulty calibration, school cutoffs. |
| Domain logic | `src/shared/engine.ts`, `mastery.ts`, `bankStatus.ts`, `contracts.ts`, `skills.ts` | Selection, grading, mastery, pool health, types, skill taxonomy. |
| Manifest validation | `src/server/manifestValidator.ts` | Server import checks (mirror of the skill's `validate_manifest.mjs`). |
| App shell / routing | `src/App.tsx` | Lazy routes; `src/main.tsx` preloads zh when saved. |
| API client | `src/client/api.ts` | Every endpoint + response types. |
| i18n | `src/client/i18n/{index.tsx,en.ts,zh.ts,messages.ts}` | Add keys to both `en.ts` and `zh.ts` (parity test). zh loads lazily. |
| Student views | `src/client/components/{HomeView,ProgressView,SessionPlayerView,PostSubmissionReview}.tsx` | |
| Benchmarks | `src/client/components/BenchmarksView.tsx` (`/benchmarks` hub), `BenchmarkReportSummaryCard.tsx` | Saved official-benchmark reports; summary card reused in review. |
| Settings & onboarding | `src/client/components/SettingsView.tsx` (`/settings`), `OnboardingTour.tsx` + `src/client/styles/onboarding.css` | Personal daily plan, reset, account delete; first-run tour (replayable from Settings). |
| Exam UI | `QuestionWorkspace.tsx`, `ReadingRenderers.tsx`, `VisualRenderer.tsx`, `FormattedText.tsx`, `WritingEditor.tsx` | |
| Session pieces | `src/client/components/session/{ExamTimer,AdminInspectorDrawer,QuestionNavigator,SubmitConfirmDialog,SectionBreakView}.tsx`, `src/client/sessionClock.ts` | Clock lives outside React state. |
| Admin | `src/client/components/AdminView.tsx`, `admin/*Panel.tsx` | Tabs are lazy. |
| Admin learners | `src/client/components/admin/LearnersPanel.tsx`, `admin/learnerScopeUtils.ts` | Condensed learners table, quick-switch pills, search/sort/paging helpers (tested in `src/client/learnerScope.test.ts`). |
| Question Bank | `src/client/components/admin/QuestionBankStudio.tsx` + `admin/bank/*` | `useBankQuery`, metrics bar, filter bar, list, inspector, simulator. |
| UI primitives | `src/client/components/ui/{Popover,Sheet,Tabs}.tsx` | Native `<dialog>` sheets portaled to `<body>`. |
| Design system | `FRONTEND_DESIGN.md`, `src/client/styles/tokens.css` | Copy to `public/docs/frontend-design.md` after edits. |
| Question skill | `docs/selective-lab-question-skill/` | `SKILL.md`, references, `scripts/{validate_manifest,merge_manifests,preview_manifest}.mjs`. |
| Bank CLI | `scripts/push-manifest.ts` | `npm run db:push -- <file> [--dry-run]`. |
| Tests | `src/**/*.test.ts` | API tests seed `src/server/__fixtures__/official-sample.json`. Postgres tests need `TEST_POSTGRES_URL`. |
| Deploy config | `vercel.json`, `vite.config.ts` | Cache headers, chunk groups. |

Commands: `npm run dev` · `npm run dev:demo` (memory DB, PIN sign-in) · `npm run lint` · `npm test` · `npm run build` · `npm run deploy`.
