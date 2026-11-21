import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import legacyConfig from '../firebase-applet-config.json' with { type: 'json' };
import {
  assertOutputAvailable, checksum, exportFirestore, MigrationError, privateWrite, readDump,
} from './migrate-firestore-source.ts';

const usage = `Usage:
  tsx scripts/migrate-firestore.ts export --out <private.json> [--source cli|iam|id-token]
    [--project <id>] [--database <id>] [--account <email>] [--auth-cli]
    [--id-token-file <file>] [--identity-token-file <file> ...]
  tsx scripts/migrate-firestore.ts check --input <private.json>
    [--identity-out <private.json>] [--media-dir <directory>] [--allow-unlinked] [--allow-missing-media]
  tsx scripts/migrate-firestore.ts load --input <private.json> --apply
    [--media-dir <directory>] [--allow-unlinked] [--allow-missing-media]

Check is offline. Export reads Firestore and writes a local artifact. Load uses DATABASE_URL.
See docs/firestore-postgres-cutover.md for access, identity, and media instructions.`;

async function main() {
  dotenv.config({ quiet: true });
  const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      source: { type: 'string' },
      project: { type: 'string' },
      database: { type: 'string' },
      account: { type: 'string' },
      out: { type: 'string' },
      'auth-cli': { type: 'boolean' },
      'id-token-file': { type: 'string' },
      'identity-token-file': { type: 'string', multiple: true },
      input: { type: 'string' },
      'identity-out': { type: 'string' },
      'media-dir': { type: 'string' },
      'allow-unlinked': { type: 'boolean' },
      'allow-missing-media': { type: 'boolean' },
      apply: { type: 'boolean' },
    },
  });
  if (flags.help) {
    console.log(usage);
    return;
  }
  const [command] = positionals;
  const exportFlags = ['source', 'project', 'database', 'account', 'out', 'auth-cli', 'id-token-file', 'identity-token-file'];
  const checkFlags = ['input', 'identity-out', 'media-dir', 'allow-unlinked', 'allow-missing-media'];
  const allowed = command === 'export' ? exportFlags
    : command === 'check' ? checkFlags
      : command === 'load' ? [...checkFlags.filter((flag) => flag !== 'identity-out'), 'apply'] : [];
  if (positionals.length !== 1 || !allowed.length || Object.keys(flags).some((flag) => !allowed.includes(flag))) {
    throw new MigrationError(usage);
  }
  if (command === 'export') {
    const access = flags.source ?? 'cli';
    const project = flags.project ?? legacyConfig.projectId;
    const database = flags.database ?? legacyConfig.firestoreDatabaseId;
    if (!flags.out || !['cli', 'iam', 'id-token'].includes(access) || !/^[a-z0-9-]+$/.test(project) ||
      !/^(?:[a-z0-9-]+|\(default\))$/.test(database)) {
      throw new MigrationError('Export needs --out, a valid source type and the correct Firebase project and database IDs.');
    }
    if (access !== 'id-token' && flags['id-token-file']) {
      throw new MigrationError('--id-token-file is only for --source id-token. Use --identity-token-file for an identity proof.');
    }
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new MigrationError('Unset FIREBASE_AUTH_EMULATOR_HOST before exporting live data.');
    }
    await assertOutputAvailable(flags.out);
    const snapshot = await exportFirestore({
      project,
      database,
      access: access as 'cli' | 'iam' | 'id-token',
      account: flags.account,
      idTokenFile: flags['id-token-file'],
      identityTokenFiles: flags['identity-token-file'] ?? [],
      authCli: Boolean(flags['auth-cli']),
    });
    const sha256 = checksum(JSON.stringify(snapshot));
    await privateWrite(flags.out, { sha256, snapshot });
    console.log(JSON.stringify({
      status: 'exported', project, database, readTime: snapshot.readTime, sha256,
      rootCounts: Object.fromEntries(Object.entries(snapshot.collections)
        .filter(([name]) => !name.includes('/')).map(([name, docs]) => [name, docs.length])),
      identityLinks: snapshot.links.length,
    }, null, 2));
    return;
  }
  if (!flags.input || (command === 'load' && !flags.apply)) {
    throw new MigrationError('Check needs --input. Load needs --input and --apply.');
  }
  const { planMigration } = await import('./migrate-firestore-plan.ts');
  const snapshot = await readDump(flags.input);
  const plan = await planMigration(snapshot, flags['media-dir']);
  const report = {
    source: { project: snapshot.project, database: snapshot.database, readTime: snapshot.readTime },
    ...plan.report,
  };
  console.log(JSON.stringify(report, null, 2));
  if (plan.report.unlinkedProfiles && !flags['allow-unlinked']) {
    throw new MigrationError('One or more profiles lack a verified Google identity link. See the guide before using --allow-unlinked.');
  }
  if (plan.report.unavailableMedia && !flags['allow-missing-media']) {
    throw new MigrationError('One or more media assets need their original bytes. See the guide before using --allow-missing-media.');
  }
  if (flags['identity-out']) await privateWrite(flags['identity-out'], plan.identityMap);
  if (command === 'check') return;
  const { loadMigration } = await import('./migrate-firestore-postgres.ts');
  await loadMigration(plan.rows);
  console.log(JSON.stringify({ status: 'loaded', verifiedRows: plan.report.rows }, null, 2));
}

main().catch((error) => {
  // Provider, parser and driver errors can embed connection strings or records.
  const safeMessage = error instanceof MigrationError ? error.message
    : 'Migration failed. Check file access, the input format and the credentials for the selected command.';
  console.error(safeMessage);
  process.exitCode = 1;
});
