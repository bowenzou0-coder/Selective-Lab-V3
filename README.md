# Selective Lab (V3)

Server-authoritative NSW Selective exam trainer built with React, Vite, TypeScript, Express/Node, Cloud Firestore, Firebase Auth, Cloud Storage, and server-side Gemini.

## Managed Google Setup (Primary Operating Model)

Selective Lab is designed to run directly on Google AI Studio and Google Cloud managed services:

- **Single Public Config**: `firebase-applet-config.json` provides `projectId`, `firestoreDatabaseId` (`ai-studio-nswselectiveprac-b9b787e9-30e1-483b-b6a1-760d211f0835`), `storageBucket`, and web Auth settings automatically — no repeated env vars needed.
- **Managed Cloud Run Deployment**: `server.ts` serves both the built SPA (`dist/` in production) and `/api/**` together from port `3000`.
- **Database & Auth**: Cloud Firestore (`FirestoreRepository`) is the single authoritative database; Firebase Auth ID tokens are verified server-side; bootstrapped admin email defaults to `bowenzou0@gmail.com`.
- **Managed Secrets**: Configure `SESSION_SECRET` (strong >= 16-char secret) and `GEMINI_API_KEY` through AI Studio / Cloud Run Secrets. Never expose API keys or private service account JSON to clients.
- **Runtime Diagnostics**: Signed-in admins can inspect live Firestore, Storage, attached service account identity, and Gemini readiness in **Admin Console → Runtime Diagnostics** (`/api/admin/diagnostics`).

## Verification Commands

```bash
npm ci
npm run lint         # tsc --noEmit
npm run lint:rules   # npx eslint firestore.rules
npm test             # tsx --test src/shared/*.test.ts src/server/*.test.ts src/server/storage/*.test.ts firestore.rules.test.ts
npm run build        # vite build
```

## Optional Local Development (Not Required for AI Studio)

If you want to run outside AI Studio locally:

- Copy `local-dev.env.example` for optional Firebase Emulators (`npm run emulators`, `npm run seed`, `npm run dev:emulator`) or isolated disposable preview (`npm run dev:demo`).
- Do **not** set `ALLOW_LOCAL_DEV_PIN`, `ALLOW_DEMO_MEMORY_DB`, or Firebase emulator env vars in production.

## Backup, Migration & Admin Bootstrap

- **Admin Bootstrap**: Ensure the admin email (`bowenzou0@gmail.com` or `BOOTSTRAPPED_ADMIN_EMAIL`) exists in Firebase Auth, or run `npm run admin:bootstrap -- --email=bowenzou0@gmail.com`.
- **Canonical Backup & Restore**: Download or dry-run/restore `v3_canonical_1.0` bundles from **Admin → Backup & Migration**.
- **Preflight Scan**: `npm run migrate:preflight` inspects legacy missing timestamps/snapshots and `/assets/uploads/*` media migration status without modifying existing records.
