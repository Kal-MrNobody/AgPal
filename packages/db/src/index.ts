import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Secret } from '@agpal/shared';
import * as schema from './schema.js';

// int8 (bigint) columns come back as strings from pg; drizzle converts them for mode: 'bigint'.

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

/** Create a pooled client. Does not connect until the first query. */
export function createDb(databaseUrl: Secret, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl.reveal(), max: options.max ?? 10 });
  return drizzle(pool, { schema });
}

export { schema };
export * from './schema.js';
export { runMigrations, MIGRATIONS_FOLDER } from './migrate.js';
