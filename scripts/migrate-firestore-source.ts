import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, stat, access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { applicationDefault, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { decodeFromFirestore } from '../src/shared/firestoreCodec.ts';

const runFile = promisify(execFile);
const require = createRequire(import.meta.url);
export const rootCollections = [
  'bank_stimuli', 'bank_questions', 'bank_question_overrides', 'import_batches',
  'admin_configs', 'media_assets', 'question_flags', 'users',
] as const;
export const learnerCollections = [
  'sessions', 'attempts', 'skill_states', 'question_memory', 'question_evidence',
  'writing_submissions', 'daily_plans',
] as const;

export class MigrationError extends Error {}
export type RecordData = Record<string, unknown>;
export type SourceDocument = { id: string; data: RecordData; createdAt: string; updatedAt: string };
type ProviderLink = { uid: string; googleSub: string; verifiedEmail?: string };
export type SourceDump = {
  format: 'selective-lab-firestore-cutover-v1';
  project: string;
  database: string;
  capturedAt: string;
  readTime: string | null;
  collections: Record<string, SourceDocument[]>;
  links: ProviderLink[];
};

export function record(value: unknown, field: string): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MigrationError(`Expected an object for ${field}.`);
  }
  return value as RecordData;
}

export function checksum(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function privateRead(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new MigrationError('Input must be a private regular file. Set its permissions to 0600.');
  }
  return readFile(file, 'utf8');
}

export async function privateWrite(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function readDump(file: string): Promise<SourceDump> {
  const { sha256, snapshot } = record(JSON.parse(await privateRead(file)), 'source export');
  if (sha256 !== checksum(JSON.stringify(snapshot))) {
    throw new MigrationError('Source export checksum mismatch.');
  }
  const dump = record(snapshot, 'source snapshot');
  if (dump.format !== 'selective-lab-firestore-cutover-v1' || !Array.isArray(dump.links)) {
    throw new MigrationError('Unsupported source export format.');
  }
  record(dump.collections, 'source collections');
  return dump as unknown as SourceDump;
}

async function cliAccessToken(account?: string): Promise<{ token: string; account: string }> {
  // Reuse the signed-in CLI's own refresh implementation. The standalone binary
  // does not expose it, so this mode uses the npm-installed CLI (see the guide).
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const executable = path.join(dir, 'firebase');
    const real = await realpath(executable).catch(() => '');
    if (!real.endsWith('/firebase-tools/lib/bin/firebase.js')) continue;
    try {
      const cliAuth = require(path.resolve(path.dirname(real), '../auth.js'));
      const selected = account
        ? cliAuth.getAllAccounts().find((candidate: { user: { email: string } }) => candidate.user.email === account)
        : cliAuth.getProjectDefaultAccount(process.cwd());
      if (!selected?.tokens?.refresh_token) break;
      const credentials = await cliAuth.getAccessToken(selected.tokens.refresh_token, [
        'https://www.googleapis.com/auth/cloud-platform',
      ]);
      if (typeof credentials.access_token === 'string' && credentials.access_token) {
        return { token: credentials.access_token, account: selected.user.email };
      }
    } catch {
      break;
    }
  }
  throw new MigrationError('Firebase CLI authorization unavailable. Use the npm-installed CLI and firebase login, or select another source method.');
}

async function cliProviderLinks(project: string, account?: string): Promise<ProviderLink[]> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'selective-lab-auth-'));
  const file = path.join(scratch, 'auth.json');
  try {
    const env = { ...process.env };
    delete env.FIREBASE_TOKEN;
    delete env.FIREBASE_AUTH_EMULATOR_HOST;
    await runFile('firebase', [
      'auth:export', file, '--format=json', '--project', project, '--non-interactive',
      ...(account ? ['--account', account] : []),
    ], { cwd: scratch, env, timeout: 120_000, maxBuffer: 1024 * 1024 });
    const { users } = record(JSON.parse(await readFile(file, 'utf8')), 'Firebase Auth export');
    if (!Array.isArray(users)) throw new MigrationError('Firebase Auth export lacks a user list.');
    return users.flatMap((value) => {
      const user = record(value, 'Firebase Auth user');
      if (user.disabled || typeof user.localId !== 'string') return [];
      const provider = Array.isArray(user.providerUserInfo)
        ? user.providerUserInfo.find((item) => item?.providerId === 'google.com')
        : undefined;
      if (typeof provider?.rawId !== 'string' || !provider.rawId) return [];
      return [{
        uid: user.localId,
        googleSub: provider.rawId,
        verifiedEmail: user.emailVerified === true && typeof user.email === 'string' ? user.email : undefined,
      }];
    });
  } catch {
    throw new MigrationError('Firebase Auth CLI export unavailable. Check access for the source project or supply individual Firebase ID token files.');
  } finally {
    // The CLI may produce a debug log or password hashes. Keep all temporary
    // outputs in the private directory and discard them after extracting links.
    await rm(scratch, { recursive: true, force: true });
  }
}

function decodeValue(value: unknown): unknown {
  const obj = record(value, 'Firestore value');
  const [kind, raw] = Object.entries(obj)[0] ?? [];
  switch (kind) {
    case 'nullValue': return null;
    case 'stringValue':
    case 'booleanValue':
    case 'timestampValue': return raw;
    case 'integerValue': {
      const n = Number(raw);
      if (Number.isSafeInteger(n)) return n;
      break;
    }
    case 'doubleValue':
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      break;
    case 'mapValue': return decodeFields(record(raw, 'Firestore map').fields);
    case 'arrayValue': {
      const values = record(raw, 'Firestore array').values ?? [];
      if (Array.isArray(values)) return values.map(decodeValue);
      break;
    }
  }
  throw new MigrationError('Unsupported Firestore value type or number outside JSON safe range.');
}

function decodeFields(fields: unknown): RecordData {
  return Object.fromEntries(Object.entries(record(fields ?? {}, 'Firestore document fields'))
    .map(([key, value]) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new MigrationError('Firestore document has an unsupported field name.');
      }
      return [key, decodeValue(value)];
    }));
}

function parseDocument(raw: unknown, parent: string): SourceDocument {
  const { name, fields, createTime, updateTime } = record(raw, 'Firestore document');
  const id = typeof name === 'string' && name.startsWith(parent + '/') ? name.slice(parent.length + 1) : '';
  if (!id || id.includes('/') || typeof createTime !== 'string' || typeof updateTime !== 'string') {
    throw new MigrationError('Unexpected document path or missing Firestore document timestamps.');
  }
  return { id, data: decodeFromFirestore(decodeFields(fields)), createdAt: createTime, updatedAt: updateTime };
}

export async function exportFirestore(settings: {
  project: string;
  database: string;
  access: 'cli' | 'iam' | 'id-token';
  idTokenFile?: string;
  identityTokenFiles: string[];
  authCli: boolean;
  account?: string;
}): Promise<SourceDump> {
  const { project, database } = settings;
  const prefix = `projects/${project}/databases/${database}/documents`;
  const iam = settings.access !== 'id-token';
  const credential = settings.access === 'iam' && process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
    ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
    : applicationDefault();
  const app = initializeApp({ projectId: project, credential }, 'migration-identity');
  try {
    let token: string;
    let account = settings.account;
    if (settings.access === 'cli') {
      ({ token, account } = await cliAccessToken(account));
    } else if (settings.access === 'iam') {
      token = (await credential.getAccessToken()).access_token;
    } else {
      if (!settings.idTokenFile) throw new MigrationError('--id-token-file is required for the id-token source.');
      token = (await privateRead(settings.idTokenFile)).trim();
    }

    const links: ProviderLink[] = settings.authCli ? await cliProviderLinks(project, account) : [];
    for (const file of new Set([
      ...settings.identityTokenFiles,
      ...(settings.idTokenFile && settings.access === 'id-token' ? [settings.idTokenFile] : []),
    ])) {
      const verified = await getAuth(app).verifyIdToken((await privateRead(file)).trim());
      const subs = verified.firebase.identities['google.com'];
      if (Array.isArray(subs) && subs.length === 1 && typeof subs[0] === 'string') {
        links.push({
          uid: verified.uid,
          googleSub: subs[0],
          verifiedEmail: verified.email_verified ? verified.email : undefined,
        });
      }
    }

    // A single read time gives all IAM pages and subcollections the same view.
    // Security-rules access uses current reads and requires a quiet source.
    const capturedAt = new Date().toISOString();
    const readTime = iam ? capturedAt : null;
    const collections: Record<string, SourceDocument[]> = Object.create(null);

    async function get(resource: string, collection: string, pageToken?: string) {
      const url = new URL('https://firestore.googleapis.com/v1/' + resource.split('/').map(encodeURIComponent).join('/'));
      if (readTime) url.searchParams.set('readTime', readTime);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      if (collection !== 'private/info') url.searchParams.set('pageSize', '200');
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404 && collection === 'private/info') return undefined;
      if (!response.ok) {
        throw new MigrationError(`Firestore ${collection} read failed (HTTP ${response.status}). Check the source database, authorization and quota.`);
      }
      return record(await response.json(), 'Firestore REST result');
    }

    async function scan(collection: string) {
      const resource = `${prefix}/${collection}`;
      const label = collection.split('/').at(-1)!;
      const docs: SourceDocument[] = [];
      const pages = new Set<string>();
      let next: string | undefined;
      do {
        const page = await get(resource, label, next);
        const documents = page?.documents ?? [];
        if (!Array.isArray(documents)) throw new MigrationError('Invalid Firestore documents page.');
        for (const raw of documents) docs.push(parseDocument(raw, resource));
        next = typeof page?.nextPageToken === 'string' ? page.nextPageToken : undefined;
        if (next && pages.has(next)) throw new MigrationError('Firestore repeated a pagination token.');
        if (next) pages.add(next);
      } while (next);
      collections[collection] = docs;
      return docs;
    }

    for (const collection of rootCollections) await scan(collection);
    for (const user of collections.users) {
      const userPath = `users/${user.id}`;
      const privateInfo = await get(`${prefix}/${userPath}/private/info`, 'private/info');
      collections[`${userPath}/private`] = privateInfo ? [parseDocument(privateInfo, `${prefix}/${userPath}/private`)] : [];
      for (const collection of learnerCollections) await scan(`${userPath}/${collection}`);
      for (const session of collections[`${userPath}/sessions`]) {
        await scan(`${userPath}/sessions/${session.id}/snapshots`);
      }
    }
    return { format: 'selective-lab-firestore-cutover-v1', project, database, capturedAt, readTime, collections, links };
  } finally {
    await deleteApp(app);
  }
}

export async function assertOutputAvailable(file: string) {
  const exists = await access(file, constants.F_OK).then(() => true, () => false);
  if (exists) throw new MigrationError('Output already exists. Choose a new path.');
}
