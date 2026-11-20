import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('firestore.rules covers every collection in firebase-blueprint.json with sole-admin and hardened validation rules', async () => {
  const [rulesRaw, blueprintRaw] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'firestore.rules'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'firebase-blueprint.json'), 'utf8'),
  ]);
  const blueprint = JSON.parse(blueprintRaw) as { firestore: Record<string, unknown> };

  assert.match(rulesRaw, /rules_version = '2';/);
  assert.match(rulesRaw, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  assert.match(rulesRaw, /request\.auth\.token\.email_verified == true/);

  // Sole admin enforcement: ONLY verified bowenzou0@gmail.com (no /admins doc escalation)
  assert.match(
    rulesRaw,
    /function isAdmin\(\) \{\s*return isVerifiedUser\(\) &&[\s\S]*?request\.auth\.token\.email\.lower\(\) == 'bowenzou0@gmail\.com';\s*\}/
  );
  assert.doesNotMatch(rulesRaw, /exists\(\/databases\/\$\(database\)\/documents\/admins\//);
  assert.doesNotMatch(rulesRaw, /allow list:.*resource\.data\.[a-zA-Z0-9_]+ is string/);

  // Every collection path in blueprint must have a matching rules block
  for (const collectionPath of Object.keys(blueprint.firestore)) {
    const segments = collectionPath.split('/').filter(Boolean);
    const leafCollection = segments[segments.length - 2];
    assert.ok(
      rulesRaw.includes(`match /${leafCollection}/`),
      `Missing match block in firestore.rules for collection "${collectionPath}"`
    );
  }

  // Validation blueprints & anti-privilege-escalation checks
  assert.match(rulesRaw, /isValidUserProfile\(incoming\(\)\)/);
  assert.match(rulesRaw, /incoming\(\)\.role == 'student'/);
  assert.match(rulesRaw, /existing\(\)\.status == 'in_progress'/);
  assert.match(rulesRaw, /incoming\(\)\.createdAt == request\.time/);
  assert.match(rulesRaw, /incoming\(\)\.updatedAt == request\.time/);
});
