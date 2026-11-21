# Firestore to Neon cutover

Run these commands from the repo root after installing dependencies. The migration exports from the legacy app's named Firestore database and loads the export into fresh Postgres app tables. Keep the export and Google identity map in a private directory outside the project.

## Export the legacy database

Pause question imports and practice in the legacy app before the final export. Have learners finish active sessions before pausing writes. Keep the new app offline until you have loaded and checked the destination.

The Firebase CLI account needs permission to list and get Firestore documents and export Firebase Auth users. Sign in with `firebase login`, or use `firebase login:add` and pass `--account <email>` to select an additional account. The CLI source can reuse the existing login without surfacing a token. This mode uses the npm package at the version below, including on machines with the standalone Firebase CLI installed. [Firebase CLI account and authorization docs](https://firebase.google.com/docs/cli)

```sh
umask 077
cutover_dir=$(mktemp -d "$HOME/.selective-lab-cutover.XXXXXX")

npm exec --yes --package=firebase-tools@15.37.0 -- ./node_modules/.bin/tsx \
  scripts/migrate-firestore.ts export --source cli --auth-cli \
  --out "$cutover_dir/firestore.json"
```

The defaults come from `firebase-applet-config.json`. Override both `--project` and `--database` if using a different legacy app. The CLI and IAM paths pin document reads to a common Firestore read time. The Auth export is a separate read. The tool extracts Google provider IDs and verified emails from a temporary private Auth export and removes the temporary files, including password hashes when the CLI account can read them. [Firestore listDocuments](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/listDocuments) · [Firebase Auth export](https://firebase.google.com/docs/cli/auth)

### Other access paths

- For a service account with document read access or local Application Default Credentials (ADC), use `export --source iam`. Use `GOOGLE_APPLICATION_CREDENTIALS`, the normal ADC setup, or an existing private `FIREBASE_SERVICE_ACCOUNT_JSON` environment value. Include `--auth-cli` if a signed-in CLI account can separately read the legacy Auth directory.
- If Starter Tier denies IAM document reads, use `export --source id-token --id-token-file <private-file>` with a fresh legacy Firebase Authentication ID token for the app's verified sole admin. Retrieve it in the signed-in legacy Firebase client with `getIdToken(currentUser, true)` using the existing app's Firebase Auth instance. Save only the ID token in a mode-0600 local file. Reads use the deployed Firestore Security Rules. The tool stops on any denied collection or expired token. This mode uses current reads, so the source needs to stay quiet for the whole scan. [Retrieving a Firebase client ID token](https://firebase.google.com/docs/auth/web/service-worker-sessions) · [Firestore REST authorization](https://firebase.google.com/docs/firestore/use-rest-api)
- If Firebase Auth directory export is denied, use repeatable `--identity-token-file <private-file>` inputs for individual learners. Each token must be freshly issued by the legacy Firebase project. The script verifies its signature, audience and expiry and reads the Google provider subject from the signed claims. The source admin token contributes its own provider link automatically in ID-token mode. Remove these short-lived credential files after export. Without a source account that can read the app's full bank and all learner collections, a complete migration is blocked. A learner dashboard export can help compare progress but contains only summaries and that learner's visible history.

## Check the dump and map identities

```sh
./node_modules/.bin/tsx scripts/migrate-firestore.ts check \
  --input "$cutover_dir/firestore.json" \
  --identity-out "$cutover_dir/google-legacy-student-ids.json"
```

The offline check validates the export checksum, expected collection paths, duplicate IDs and destination keys, learner ownership, bank stimulus references, session snapshot identity and order, Google provider mappings, and local media availability. Review the counts and compare with the legacy bank and learner views. Missing historical bank rows and incomplete immutable snapshots are reported. The tool preserves available history and makes no replacement snapshots.

Use the contents of `google-legacy-student-ids.json` as the private server-side `GOOGLE_LEGACY_STUDENT_IDS` environment value. It maps Google subjects to the existing Firebase UID, which is retained in the database with that learner's records. Google sign-in assigns admins from the app's server-side `ADMIN_EMAILS` configuration. The loader initializes stored profile roles as student until the new app verifies sign-in. With `--allow-unlinked`, an unmatched profile and its records are still loaded. That learner's first Google login starts under a new ID until a trusted provider link is configured. Private Firestore profile emails alone never establish identity.

### Media

- Bundled `/assets/...` visuals keep their paths. The check verifies that these files exist under `public/`. External image URLs are counted and need a browser check after cutover.
- For uploaded media, stage original bytes in a private directory and supply `--media-dir <directory>` to both `check` and `load`. For legacy GCS objects, use the original `objectKey` path relative to that directory. For `/assets/uploads/` records, put files at the top level under their original filename. If no directory is supplied, the tool looks for those local files in `public/assets/uploads/`.
- The tool verifies each staged file's size and SHA-256. It stores the bytes with their metadata in Postgres, remembers the legacy provider and URL, and updates matching bank and session visual URLs to `/api/media/<assetId>`. The new server reads those bytes from Postgres. Without original bytes or bundled asset files, the check and load stop. `--allow-missing-media` allows a deliberate import with metadata and unresolved links. Retain any separate media binary backup. The script never downloads, uploads, or deletes a GCS object.

## Load and point the new app at the database

Set `DATABASE_URL` privately to the intended Neon connection string with TLS. A direct connection is suitable for this one-time load. Start with a fresh database or Neon branch. App startup or a question push can seed a destination, so run the migration before either happens. The tool accepts only empty app tables and the repository's exact bootstrapped default learning config. [Connecting an application to Neon](https://neon.com/docs/connect/connect-from-any-app)

```sh
./node_modules/.bin/tsx scripts/migrate-firestore.ts load \
  --input "$cutover_dir/firestore.json" --apply
```

Reuse any media directory or explicit allow flags from the check. The loader initializes the repository schema, locks the app tables, inserts data in one transaction, and checks all table row counts before commit. A failed data transaction rolls back. The initialized schema and default config can remain. Subsequent runs against a populated target are rejected. If the connection drops during commit, inspect destination counts before choosing whether to retry.

Set the verified identity map and Google OAuth configuration on the new app before the first login. Confirm that a migrated learner sees their old sessions, attempts and mastery, the admin sees all bank versions and batch/config history, and questions with images render. The tool does not copy Firebase credentials, OAuth tokens, app cookies, admin claims, lock documents, or data in unknown collections or under missing parent documents. Quiesced active sessions are represented by their stored state and checkpoint. Keep the old app and the private export available until sign-in and bank checks pass. If restoring traffic to the old app after the new app has accepted writes, reconcile the new records before resuming legacy writes.
