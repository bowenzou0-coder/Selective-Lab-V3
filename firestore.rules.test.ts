import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('firestore.rules covers every collection in firebase-blueprint.json with server-authoritative zero-client-write rules', async () => {
  const [rulesRaw, blueprintRaw] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'firestore.rules'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'firebase-blueprint.json'), 'utf8'),
  ]);
  const blueprint = JSON.parse(blueprintRaw) as { firestore: Record<string, unknown> };

  assert.match(rulesRaw, /rules_version = '2';/);
  assert.match(rulesRaw, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  assert.match(rulesRaw, /request\.auth\.token\.email_verified == true/);

  // Every collection path in blueprint must have a matching rules block
  for (const collectionPath of Object.keys(blueprint.firestore)) {
    const segments = collectionPath.split('/').filter(Boolean);
    const leafCollection = segments[segments.length - 2];
    assert.ok(
      rulesRaw.includes(`match /${leafCollection}/`),
      `Missing match block in firestore.rules for collection "${collectionPath}"`
    );
  }

  // Server-authoritative invariants
  assert.match(rulesRaw, /match \/bank_questions\/\{questionId\}\s*\{\s*allow read, write: if false;/);
  assert.match(rulesRaw, /match \/snapshots\/\{snapId\}\s*\{\s*allow read, write: if false;/);
  assert.match(rulesRaw, /match \/question_evidence\/\{evidenceDocId\}/);
  assert.match(rulesRaw, /allow create, update, delete: if false;/);
});
