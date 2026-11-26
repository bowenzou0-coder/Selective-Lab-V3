# Codebase map

Vite + React 19 client, Express API (one Vercel function), Neon Postgres. Find the file here before opening anything large.

| Area | Path | Notes |
| --- | --- | --- |
| Entrypoint | `server.ts` → `src/server/app.ts` | `createApp()` wires middleware, static files, routes. `api/index.ts` is the Vercel handler. |
| Shared route state | `src/server/context.ts`, `src/server/rateLimit.ts` | `ensureSeeded` (memory demo only), monitored-learner resolution, auth revocation & account-delete cleanup, per-user AI sliding-window rate limiter (`SlidingWindowRateLimiter`). |
| Routes | `src/server/routes/*.ts` | `auth` (health, media, sign-in), `student` (dashboard), `sessions` (get/checkpoint/section/submit; `POST /api/sessions` creation lives in `sessionCreate.ts`), `studentProgress` (writing eval, flags, progress, export), `studentSettings` (`/api/student/settings*` daily-plan prefs, recalibrate, onboarding flag; study-progress reset; own flags; account delete), `benchmarks` (`/api/student/benchmarks[/:sessionId[/analyze]]` saved reports + AI coaching), `adminLearners` (incl. learner delete), `adminBank` (status, questions, bulk-status, batches, calibration, import), `adminSystem` (config, flags, backup, migrate). |
| Session grading/expiry | `src/server/sessionLifecycle.ts` | Snapshots, finalize, deadline auto-submit. |
| Repository contract | `src/server/storage/repository.ts` | `AppRepository`, `QuestionMeta`, `QuestionSelectionItem`, query params. |
| Backup/restore | `src/server/storage/postgresBackup.ts`, `MemoryRepository.exportFullBackup/restoreFullBackup`, `repositoryUtils.ts` (`finalizeBackupBundle`, `validateIncomingBackupBundle`) | Canonical `v3_canonical_1.0` bundle. Per-user sections include `dailyFocusPlans`, `benchmarkReports`, `learnerPreferences` (all optional for older bundles). New tables must be added to export, restore, `LOCK TABLE`, and the Postgres backup test's `BACKUP_TABLES`. |
| Postgres | `src/server/storage/postgresRepository.ts`, `postgresQueries.ts`, `postgresAccountQueries.ts` | Account SQL (users, learner preferences, question flags, progress reset, account delete) lives in `postgresAccountQueries.ts`. SQL-level filtering, pagination, aggregates & targeted reads (e.g. `listSessionSummaries` slim projection for the dashboard); schema/indexes in `runSchemaInit` (bump `SCHEMA_MARKER` when adding DDL). `getActiveConfig()` is cached per pool for 45s and cleared by `saveConfigVersion`/`restoreFullBackup`/`hydrateSyncData`. |
| Bank cache | `src/server/storage/questionBankCache.ts` | Fingerprint-validated slim selection/meta caches + full-bank fallback for backup/preflight; clone before mutating. |
| Filtering/paging | `src/server/storage/repositoryUtils.ts` | `filterAndPaginateQuestions`, `summarizeBatches`. |
| Memory repo | `src/server/storage/memoryRepository.ts` | `dev:demo` and API tests. |
| AI | `src/server/geminiPlanner.ts`, `dailyPlanAllocator.ts`, `geminiWriting.ts`, `geminiClient.ts`, `geminiBenchmarkCoach.ts` | Daily plans (pure deterministic ranking/allocation in `dailyPlanAllocator.ts`, re-exported from `geminiPlanner.ts`; Gemini prompts/parsing stay in `geminiPlanner.ts`), practice order, writing feedback, benchmark-report coaching (`generateBenchmarkAiCoaching`). |
| NSW benchmark engine | `src/shared/nswBenchmark.ts` | Scaled /120 score, percentile/rank estimate, section weightings, difficulty calibration, school cutoffs. |
| Domain logic | `src/shared/engine.ts`, `mastery.ts`, `bankStatus.ts`, `contracts.ts`, `skills.ts` | Selection, grading, mastery, pool health, types, skill taxonomy. |
| Manifest validation | `src/server/manifestValidator.ts` | Server import checks (mirror of the skill's `validate_manifest.mjs`). |
| App shell / routing | `src/App.tsx`, `src/client/components/ErrorBoundary.tsx`, `src/client/chunkError.ts` | Lazy routes wrapped in `ErrorBoundary` with stale-chunk deployment recovery; `src/main.tsx` preloads zh when saved. |
| API client | `src/client/api.ts` | Every endpoint + response types. In-memory SWR cache for the four student tabs (`dashboard`/`benchmarks`/`progress`/`settings`): account-scoped (`setApiCacheScope`), in-flight dedupe, `peekCachedResource`, `invalidateApiCache`/`patchCachedResource` on mutations, `clearApiCache` for tests (`src/client/apiCache.test.ts`). Views read it via `src/client/useCachedResource.ts`; `App.tsx` prefetches on nav hover/focus. |
| i18n | `src/client/i18n/{index.tsx,en.ts,zh.ts,messages.ts}` | Add keys to both `en.ts` and `zh.ts` (parity test). zh loads lazily. |
| Student views | `src/client/components/{HomeView,ProgressView,SessionPlayerView,PostSubmissionReview}.tsx` | |
| Home pieces | `src/client/components/home/{MockSimulatorCard,PracticeDrillsList}.tsx`, `home/launchSpec.ts` | Mock simulator card; section drills list + drill sizing/launch-spec helpers. |
| Review pieces | `src/client/components/review/{WritingReviewSection,ObjectiveReviewList,FlagQuestionModal}.tsx`, `review/{useWritingEvaluation,reviewUtils}.ts` | Writing critique/exemplar/prompt views (memoized highlights), item pills/filter tabs/status chip/prev-next, report-issue form + state, reload-resilient rubric marking. `PostSubmissionReview` stays lazy-loaded from `SessionPlayerView`. |
| Benchmarks | `src/client/components/BenchmarksView.tsx` (`/benchmarks` hub), `BenchmarkReportSummaryCard.tsx` | Saved official-benchmark reports; summary card reused in review. |
| Settings & onboarding | `src/client/components/SettingsView.tsx` (`/settings`), `OnboardingTour.tsx` + `src/client/styles/onboarding.css` | Personal daily plan, reset, account delete; first-run tour (replayable from Settings). |
| Exam UI | `QuestionWorkspace.tsx`, `ReadingRenderers.tsx`, `VisualRenderer.tsx`, `FormattedText.tsx`, `WritingEditor.tsx` | |
| Session pieces | `src/client/components/session/{ExamTimer,AdminInspectorDrawer,QuestionNavigator,SessionNavigatorDrawer,SessionHeaderBar,DraftRecoveryBanner,SubmitConfirmDialog,SectionBreakView}.tsx`, `session/localDraft.ts`, `src/client/sessionClock.ts` | Clock lives outside React state. `DraftRecoveryBanner.tsx` also exports the checkpoint-conflict banner; `localDraft.ts` holds the device-draft storage helpers. |
| Admin | `src/client/components/AdminView.tsx`, `admin/*Panel.tsx` | Tabs are lazy. `AutoCalibrateConfigPanel.tsx` composes `admin/PlatformDefaultsSection.tsx` and `admin/LearnerOverrideCard.tsx`. |
| Admin learners | `src/client/components/admin/LearnersPanel.tsx`, `admin/learnerScopeUtils.ts` | Condensed learners table, search/sort/paging helpers (tested in `src/client/learnerScope.test.ts`). |
| Question Bank | `src/client/components/admin/QuestionBankStudio.tsx` + `admin/bank/*` | `useBankQuery`, metrics bar, filter bar, list, inspector, simulator. |
| UI primitives | `src/client/components/ui/{Popover,Sheet,Tabs,Skeleton,ConfirmDialog,NumericInput,Toast,StatusBanner}.tsx` | Native `<dialog>` sheets portaled to `<body>`. `ConfirmDialog`: every confirmation modal (focus trap, Escape/backdrop, focus restore, reduced-motion transitions). `NumericInput`: clamped number field with optional range hint and `−`/`+` steppers. `Toast`: auto-dismissing `role="status"` notice (no layout shift); `StatusBanner`: persistent inline notice/error. `Skeleton`/`SkeletonRegion` + `.skeleton` in `tokens.css` for layout-matched loading states (reduced-motion safe). |
| Design system | `FRONTEND_DESIGN.md`, `src/client/styles/tokens.css` | Copy to `public/docs/frontend-design.md` after edits. |
| Question skill | `docs/selective-lab-question-skill/` | `SKILL.md`, references, `scripts/{validate_manifest,merge_manifests,preview_manifest}.mjs`. |
| Bank CLI | `scripts/push-manifest.ts` | `npm run db:push -- <file> [--dry-run]`. |
| Tests | `src/**/*.test.ts` | API tests seed `src/server/__fixtures__/official-sample.json`. Postgres tests need `TEST_POSTGRES_URL`. |
| Deploy config | `vercel.json`, `vite.config.ts` | Cache headers, chunk groups. |

Commands: `npm run dev` · `npm run dev:demo` (memory DB, PIN sign-in) · `npm run lint` · `npm test` · `npm run build` · `npm run deploy`.
