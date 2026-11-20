const NESTED_ARRAY_KEY = 'fsNestedArray_v1';
const LEGACY_NESTED_ARRAY_KEY = '__fsNestedArray__';
const RESERVED_FIRESTORE_FIELD_RE = /^__.*__$/;

function isFirestoreSentinel(val: unknown): boolean {
  if (!val || typeof val !== 'object') return false;
  if ('_methodName' in (val as Record<string, unknown>)) return true;
  const proto = Object.getPrototypeOf(val);
  return proto !== Object.prototype && proto !== null;
}

/**
 * Recursively sanitizes any JS object for Cloud Firestore storage:
 * - Drops `undefined` object properties (replaces `undefined` array entries with `null`).
 * - Leaves Firestore FieldValue sentinels (e.g. `serverTimestamp()`) and non-plain objects untouched.
 * - Encodes nested arrays (arrays directly inside arrays, such as `VisualSpec.tableData.rows`)
 *   as `{ fsNestedArray_v1: [...] }` because Cloud Firestore forbids both nested arrays and
 *   field names that begin and end with `__`.
 */
export function encodeForFirestore<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined) return null;
      if (Array.isArray(item)) {
        return { [NESTED_ARRAY_KEY]: encodeForFirestore(item) };
      }
      return encodeForFirestore(item);
    }) as unknown as T;
  }
  if (typeof value === 'object') {
    if (isFirestoreSentinel(value)) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = encodeForFirestore(v);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Recursively restores any `{ fsNestedArray_v1: [...] }` (or legacy `{ __fsNestedArray__: [...] }`)
 * markers back into native JS arrays after reading documents from Cloud Firestore.
 * Backwards-compatible with plain unencoded docs.
 */
export function decodeFromFirestore<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => decodeFromFirestore(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    if (isFirestoreSentinel(value)) {
      return value;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (
      entries.length === 1 &&
      (entries[0][0] === NESTED_ARRAY_KEY ||
        entries[0][0] === LEGACY_NESTED_ARRAY_KEY) &&
      Array.isArray(entries[0][1])
    ) {
      return decodeFromFirestore(entries[0][1]) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = decodeFromFirestore(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Returns true if any array directly contains another array anywhere in `value`.
 */
export function containsNestedArray(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) || containsNestedArray(item)) return true;
    }
    return false;
  }
  if (value && typeof value === 'object') {
    if (isFirestoreSentinel(value)) return false;
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (containsNestedArray(v)) return true;
    }
  }
  return false;
}

/**
 * Returns true if any plain object anywhere in `value` contains a key beginning and ending with `__`
 * (which Cloud Firestore rejects on document writes).
 */
export function containsReservedFirestoreFieldName(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsReservedFirestoreFieldName(item));
  }
  if (value && typeof value === 'object') {
    if (isFirestoreSentinel(value)) return false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RESERVED_FIRESTORE_FIELD_RE.test(k)) return true;
      if (containsReservedFirestoreFieldName(v)) return true;
    }
  }
  return false;
}
