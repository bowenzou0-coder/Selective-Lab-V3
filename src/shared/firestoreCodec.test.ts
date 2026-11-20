import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  containsNestedArray,
  containsReservedFirestoreFieldName,
  decodeFromFirestore,
  encodeForFirestore,
} from './firestoreCodec.ts';

test('encodeForFirestore eliminates nested arrays without reserved field names and decodeFromFirestore restores them losslessly', () => {
  const sentinel = { _methodName: 'serverTimestamp' };
  const sample = {
    questionId: 'q_table_1',
    plannedQuestionIds: ['q1', 'q2'],
    visual: {
      visualType: 'structured_table',
      altText: 'Pool passes table',
      tableData: {
        caption: 'Pool Pass Prices',
        headers: ['Pass', 'Price'],
        rows: [
          ['Single', '$6'],
          ['5-visit', '$23'],
          ['10-visit', 40],
        ],
      },
    },
    optionalField: undefined,
    createdAt: sentinel,
  };

  assert.equal(containsNestedArray(sample), true);

  const encoded = encodeForFirestore(sample);
  assert.equal(containsNestedArray(encoded), false);
  assert.equal(containsReservedFirestoreFieldName(encoded), false);
  assert.deepEqual(encoded.plannedQuestionIds, ['q1', 'q2']);
  assert.equal('optionalField' in encoded, false);
  assert.equal(encoded.createdAt, sentinel);

  const decoded = decodeFromFirestore(encoded);
  assert.deepEqual(decoded.visual.tableData.rows, [
    ['Single', '$6'],
    ['5-visit', '$23'],
    ['10-visit', 40],
  ]);
  assert.deepEqual(decoded.visual.tableData.headers, ['Pass', 'Price']);
  assert.equal(decoded.createdAt, sentinel);
});

test('decodeFromFirestore remains backwards-compatible with legacy __fsNestedArray__ markers', () => {
  const legacyEncoded = {
    rows: [
      { __fsNestedArray__: ['A', '1'] },
      { __fsNestedArray__: ['B', '2'] },
    ],
  };
  assert.equal(containsReservedFirestoreFieldName(legacyEncoded), true);
  assert.deepEqual(decodeFromFirestore(legacyEncoded), {
    rows: [
      ['A', '1'],
      ['B', '2'],
    ],
  });
});

test('encodeForFirestore strips all nested arrays and produces zero reserved Firestore keys across all bundled seed manifests', async () => {
  const seedFiles = [
    'golden-smoke-pack.json',
    'official-doe-pt1-2.json',
    'official-doe-pt3-holdout.json',
  ];

  for (const file of seedFiles) {
    const raw = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'seed', file), 'utf8')
    );
    const encoded = encodeForFirestore(raw);
    assert.equal(
      containsNestedArray(encoded),
      false,
      `Expected zero nested arrays after encoding ${file}`
    );
    assert.equal(
      containsReservedFirestoreFieldName(encoded),
      false,
      `Expected zero reserved __...__ Firestore keys after encoding ${file}`
    );
    const decoded = decodeFromFirestore(encoded);
    assert.deepEqual(decoded, raw, `Round-trip mismatch on ${file}`);
  }
});
