import { isIP } from 'node:net';
import type { PoolConfig } from 'pg';

export function isPostgresConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.DATABASE_URL?.trim() ||
      (env.SQL_HOST && env.SQL_USER && env.SQL_PASSWORD && env.SQL_DB_NAME)
  );
}

export function getPostgresPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = env.DATABASE_URL?.trim();
  const poolOptions = {
    max: env.VERCEL ? 3 : 10,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  };

  if (!connectionString) {
    return {
      ...poolOptions,
      host: env.SQL_HOST,
      user: env.SQL_USER,
      password: env.SQL_PASSWORD,
      database: env.SQL_DB_NAME,
    };
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Invalid DATABASE_URL. Expected a PostgreSQL connection URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Invalid DATABASE_URL. Expected a PostgreSQL connection URL.');
  }

  const params = Object.fromEntries(url.searchParams);
  const hostname = (params.host || url.hostname || env.PGHOST || 'localhost').toLowerCase();
  const local = hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.')) || hostname.startsWith('/') || hostname.startsWith('%2f');
  if (!local && (
    ['disable', 'allow', 'no-verify'].includes(params.sslmode) ||
    ['0', 'false', 'no-verify'].includes(params.ssl)
  )) {
    throw new Error('Remote DATABASE_URL requires verified TLS. Set sslmode=verify-full.');
  }

  // node-postgres applies URL TLS settings over the pool option. Normalize weaker
  // modes for remote URLs so hostname verification is independent of driver defaults.
  const explicitTls = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert']
    .some((key) => url.searchParams.has(key));
  if (!local && explicitTls && params.sslmode !== 'verify-full') {
    url.searchParams.set('sslmode', 'verify-full');
  }

  return {
    ...poolOptions,
    connectionString: url.href,
    ssl: explicitTls ? undefined : !local || params.sslnegotiation === 'direct',
  };
}
