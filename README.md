# Selective Lab

NSW Selective exam practice with a Vite frontend and an Express API. Vercel Hobby serves the app and Neon Free stores the question bank, learner history, configuration and uploaded media. The API and database run in Sydney. Open [the live app](https://selective-lab-v3.vercel.app).

## Run locally

Use Node.js 24 and install dependencies with `npm ci`. The configured checkout reads its ignored `.env`. On a fresh checkout, copy `.env.example` to `.env` and configure the following.

| Setting | Value |
| --- | --- |
| `DATABASE_URL` | Pooled connection URL from Neon, with `sslmode=verify-full`. A local Postgres instance also works. |
| `GOOGLE_CLIENT_ID` | Web application client ID from Google Auth Platform. Add `http://localhost:3000` and the exact production origin to its authorized JavaScript origins. |
| `SESSION_SECRET` | Generate a private signing secret with `openssl rand -hex 48`. All production instances share it. |
| `ADMIN_EMAILS` | Comma-separated verified addresses. Defaults to `bowenzou0@gmail.com,yolandayue0319@gmail.com`. |
| `GOOGLE_LEGACY_STUDENT_IDS` | Optional mapping produced during Firestore cutover. It links existing progress to a returning Google account. |
| `GEMINI_API_KEY` | Optional server-side key for AI features. Its quota and billing belong to the Google project. |

Start the app with `npm run dev` and open `http://localhost:3000`. Pointing `DATABASE_URL` at production gives the local app access to live data. Use a separate database for experiments.

## Publish questions

```sh
npm run db:push -- batches/ready-to-import.json
```

The CLI validates the manifest and imports the questions directly into the configured database in a transaction. It reports the import result locally. The website reads the updated bank on its next request. See [the agent playbook](AGENTS.md) for authoring and strict calibration checks.

## Deploy the application

The Vercel project is `selective-lab-v3`. On a new machine, use `npx vercel login` and `npx vercel link` to select that project in the Hobby workspace. Set the server environment variables above in the project's Production environment, then run:

```sh
npm run deploy
```

Vercel serves `dist/` as static files and routes `/api/*` to one Node function running Express. Sign-in exchanges a Google ID token for the app's `selective_lab_session` cookie. Uploaded images have a 3 MiB limit to fit the platform's base64 JSON request limit. For large bank manifests use the direct CLI.

## Verify

```sh
npm run lint
npm test
npm run build
```

The [cutover guide](docs/firestore-postgres-cutover.md) documents exports, identity links and restore checks, and `src/shared/firestoreCodec.test.ts` keeps the cutover decoder covered.
