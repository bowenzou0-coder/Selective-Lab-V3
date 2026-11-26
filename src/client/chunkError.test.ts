import assert from 'node:assert/strict';
import test from 'node:test';
import { isStaleChunkError } from './chunkError.ts';

test('isStaleChunkError recognizes Vite, webpack, Safari, and Firefox dynamic-import failures', () => {
  const chunkNamed = new Error('Loading failed');
  chunkNamed.name = 'ChunkLoadError';
  assert.equal(isStaleChunkError(chunkNamed), true);

  assert.equal(
    isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://app.example/assets/SettingsView-abc123.js')),
    true
  );
  assert.equal(
    isStaleChunkError(new Error('Importing a module script failed.')),
    true
  );
  assert.equal(
    isStaleChunkError(new Error('error loading dynamically imported module: /assets/ProgressView-xyz.js')),
    true
  );
  assert.equal(
    isStaleChunkError(new Error('Loading chunk 42 failed. (missing: https://app.example/assets/chunk.js)')),
    true
  );
  assert.equal(
    isStaleChunkError(new Error('Loading CSS chunk styles-9f2a failed.')),
    true
  );
  assert.equal(
    isStaleChunkError(new Error('Unable to preload CSS for /assets/AdminView-123.css')),
    true
  );
  assert.equal(
    isStaleChunkError('Failed to load module script: Expected a JavaScript module script'),
    true
  );

  // Nested cause chain
  const wrapped = new Error('Route failed to mount', {
    cause: new TypeError('Failed to fetch dynamically imported module: /assets/BenchmarksView.js'),
  });
  assert.equal(isStaleChunkError(wrapped), true);
});

test('isStaleChunkError returns false for unrelated runtime and network errors', () => {
  assert.equal(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(isStaleChunkError(new ReferenceError('foo is not defined')), false);
  assert.equal(isStaleChunkError(new Error('Network request failed (500)')), false);
  assert.equal(isStaleChunkError(null), false);
  assert.equal(isStaleChunkError(undefined), false);
  assert.equal(isStaleChunkError(42), false);
  assert.equal(isStaleChunkError({}), false);
});
