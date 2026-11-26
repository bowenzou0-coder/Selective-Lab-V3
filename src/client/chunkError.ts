const STALE_CHUNK_PATTERNS: readonly RegExp[] = [
  /ChunkLoadError/i,
  /Loading chunk [\w-]+ failed/i,
  /Loading CSS chunk [\w-]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Unable to preload CSS for/i,
  /Failed to load module script/i,
  /dynamically imported module/i,
];

function extractErrorDetails(error: unknown): { name: string; message: string; cause?: unknown } | null {
  if (typeof error === 'string') {
    return { name: '', message: error };
  }
  if (!error || typeof error !== 'object') {
    return null;
  }
  const record = error as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message : '';
  return { name, message, cause: record.cause };
}

/**
 * Detect hashed asset / lazy-chunk load errors that happen when a user keeps a tab
 * open across a new Vercel deployment and navigates to a lazy-loaded route.
 */
export function isStaleChunkError(error: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  const details = extractErrorDetails(error);
  if (!details) return false;

  if (details.name === 'ChunkLoadError') return true;
  const combined = `${details.name} ${details.message}`.trim();
  if (combined && STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(combined))) {
    return true;
  }
  if (details.cause !== undefined && details.cause !== error) {
    return isStaleChunkError(details.cause, depth + 1);
  }
  return false;
}
