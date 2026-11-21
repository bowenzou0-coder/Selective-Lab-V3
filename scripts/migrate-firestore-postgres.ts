import type { PoolClient } from 'pg';
import { DEFAULT_LEARNING_CONFIG } from '../src/shared/contracts.ts';
import { getOrCreatePgPool, PostgresRepository } from '../src/server/storage/postgresRepository.ts';
import { tableNames, tables } from './migrate-firestore-plan.ts';
import type { SqlRows, Table } from './migrate-firestore-plan.ts';
import { MigrationError } from './migrate-firestore-source.ts';

async function countRows(client: PoolClient, table: Table): Promise<number> {
  const { rows } = await client.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
  return Number(rows[0].count);
}

async function loadRows(client: PoolClient, rows: SqlRows) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query(`LOCK TABLE ${tableNames.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);

    // Schema initialization creates cfg_v1 even on a brand new database.
    // Only the exact bootstrapped default may be present before cutover.
    const configs = await client.query<{ is_default: boolean }>(
      `SELECT config_version_id = 'cfg_v1' AND version_number = 1
        AND notes = 'Default Selective Lab Learning Config'
        AND config = $1::jsonb AS is_default FROM admin_config_versions`,
      [JSON.stringify(DEFAULT_LEARNING_CONFIG)],
    );
    if (configs.rowCount !== 1 || configs.rows[0].is_default !== true) {
      throw new MigrationError('Target has existing learning configs. Use a fresh database or branch.');
    }
    for (const table of tableNames) {
      if (table !== 'admin_config_versions' && await countRows(client, table) !== 0) {
        throw new MigrationError(`Target table ${table} already contains rows. Use a fresh database or branch.`);
      }
    }

    const keepDefault = rows.admin_config_versions.length === 0;
    if (!keepDefault) {
      await client.query("DELETE FROM admin_config_versions WHERE config_version_id = 'cfg_v1'");
    }
    for (const table of tableNames) {
      const candidates = rows[table];
      const columns = tables[table];
      const batchSize = table === 'media_assets' ? 1 : 100;
      for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const values = batch.flat();
        const placeholders = batch.map((_, rowIndex) =>
          '(' + columns.map((_, columnIndex) => '$' + (rowIndex * columns.length + columnIndex + 1)).join(', ') + ')'
        );
        await client.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`,
          values,
        );
      }
      const expected = candidates.length + (keepDefault && table === 'admin_config_versions' ? 1 : 0);
      if (await countRows(client, table) !== expected) {
        throw new MigrationError(`Row verification failed in ${table}. The data transaction was rolled back.`);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function loadMigration(rows: SqlRows) {
  if (!process.env.DATABASE_URL?.trim()) throw new MigrationError('Load requires DATABASE_URL.');
  let pool: ReturnType<typeof getOrCreatePgPool> | undefined;
  try {
    pool = getOrCreatePgPool();
    await new PostgresRepository().ensureSchema();
    const client = await pool.connect();
    try {
      await loadRows(client, rows);
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    const code = (error as { code?: unknown; cause?: { code?: unknown } })?.code ??
      (error as { cause?: { code?: unknown } })?.cause?.code;
    const state = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (SQLSTATE ${code})` : '';
    throw new MigrationError(`Postgres load failed${state}. Check connectivity, schema access, and whether the data transaction committed before retrying.`);
  } finally {
    if (pool) await pool.end();
  }
}
