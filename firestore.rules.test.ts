import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('firestore.rules covers every collection declared in firebase-blueprint.json with zero-trust defaults', async () => {
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

  // Dirty Dozen structural assertions in rules
  assert.match(rulesRaw, /existing\(\)\.status == 'in_progress'/); // Terminal state lock on submitted sessions
  assert.match(rulesRaw, /allow get: if isValidId\(questionId\) && isAdmin\(\);/); // Answer keys locked to admin
  assert.match(rulesRaw, /incoming\(\)\.role == 'student'/); // Prevents self-assigned admin role escalation
});
