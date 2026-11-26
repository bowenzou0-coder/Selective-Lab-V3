import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('The public design document matches FRONTEND_DESIGN.md byte-for-byte', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url));
  assert.ok(read('../../FRONTEND_DESIGN.md').equals(read('../../public/docs/frontend-design.md')),
    'Copy FRONTEND_DESIGN.md to public/docs/frontend-design.md after editing it');
});
