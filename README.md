# Selective Lab (V3)

Server-authoritative NSW Selective exam trainer built with React, Vite, TypeScript, Express/Node, and Cloud Firestore + Firebase Auth + Cloud Storage.

## Architecture Overview

- **Frontend**: React 19 SPA compiled to `dist/`, served from Firebase Hosting in production (with `/api/**` rewritten same-origin to Cloud Run) and Vite middleware in dev.
- **API & Grading Engine**: Express/Node (`server.ts`) acts as the sole authoritative reader/writer/grader for the question bank, immutable session question snapshots, part attempts, skill scheduling states, and certified 3-stage mastery evidence (`v3_3stage_24h_7d`).
- **Database**: Cloud Firestore (`inductive-setting-553bd` / database ID `ai-studio-nswselectiveprac-b9b787e9-30e1-483b-b6a1-760d211f0835`) via `FirestoreRepository`. Disposable `MemoryRepository` is strictly restricted to `ALLOW_DEMO_MEMORY_DB=true` or `NODE_ENV=test` and displays a warning banner in the UI.
- **Media Storage**: Uploaded question visuals are validated (extension + MIME + 5 MB cap + SVG sanitization) and stored in Cloud Storage (`inductive-setting-553bd.firebasestorage.app`) under `question-media/<questionId>/<hash>.<ext>`, streamed at `/api/media/:assetId`. Bundled official assets live under `public/assets/official/*`.

## Local Development

### Option A: Local Firebase Emulators (Recommended)
Requires Java + Firebase CLI:
```bash
npm ci
cp .env.example .env
npm run emulators
# In a second terminal:
npm run seed
npm run dev:emulator
```

### Option B: Opt-In Local Access to Live Cloud Project (via ADC)
Never commit service account JSON keys into the repository. Authenticate with Application Default Credentials:
```bash
gcloud auth application-default login
USE_FIRESTORE_DB=true FIREBASE_USE_ADC=true npm run seed
USE_FIRESTORE_DB=true FIREBASE_USE_ADC=true npm run dev
```

### Option C: Disposable In-Memory Preview (No Java / No Emulator)
```bash
npm run dev:demo
```

## Verification Commands

```bash
npm run lint         # tsc --noEmit
npm run lint:rules   # npx eslint firestore.rules
npm test             # tsx --test src/**/*.test.ts firestore.rules.test.ts
npm run build        # vite build
```

## Admin Bootstrap

Ensure the bootstrapped admin email (`bowenzou0@gmail.com` or `BOOTSTRAPPED_ADMIN_EMAIL`) has signed in once or exists in Firebase Auth, then run:
```bash
npm run admin:bootstrap -- --email=bowenzou0@gmail.com
```
This assigns custom claim `{ role: "admin", admin: true }` and sets `users/{uid}.role = "admin"` in Firestore.

## Backup, Restore & Migration Runbook

- **Full Export**: Download canonical bundle (`v3_canonical_1.0`) from Admin → Backup & Migration (`/api/admin/backup`).
- **Dry-Run & Restore**: Upload/paste a canonical backup in Admin → Backup & Migration and run **Dry-Run Restore** before **Apply Restore**, or run via CLI:
  ```bash
  npx tsx scripts/migrate-preflight.ts --apply=backup.json
  npx tsx scripts/migrate-preflight.ts --apply=backup.json --apply-write
  ```
- **Media & Timestamp Preflight**: Run `npm run migrate:preflight` or click **Run Preflight Scan** in Admin → Backup & Migration to inspect legacy missing timestamps and detect any `/assets/uploads/*` files awaiting Cloud Storage upload without deleting originals.

## Deployment Target (Cloud Run + Firebase Hosting)

Do **not** expose `ALLOW_LOCAL_DEV_PIN` or `ALLOW_DEMO_MEMORY_DB` in production.

1. Set production Cloud Run environment variables / secrets:
   - `NODE_ENV=production`
   - `SESSION_SECRET` (strong random secret from Secret Manager)
   - `GEMINI_API_KEY` (from Secret Manager)
   - `FIREBASE_USE_ADC=true`
   - `USE_FIRESTORE_DB=true`
   - `FIREBASE_PROJECT_ID=inductive-setting-553bd`
   - `FIREBASE_DATABASE_ID=ai-studio-nswselectiveprac-b9b787e9-30e1-483b-b6a1-760d211f0835`
   - `FIREBASE_STORAGE_BUCKET=inductive-setting-553bd.firebasestorage.app`
   - `BOOTSTRAPPED_ADMIN_EMAIL=bowenzou0@gmail.com`
2. Deploy API container to Cloud Run (`selective-lab-api`, `australia-southeast1`).
3. Build `dist/` (`npm run build`) and deploy Firebase Hosting + Firestore rules/indexes + Storage rules (`firebase deploy --project inductive-setting-553bd`).
