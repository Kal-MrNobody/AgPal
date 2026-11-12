import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Secret } from '@agpal/shared';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** Create a pooled client. Does not connect until the first query. */
export function createDb(databaseUrl: Secret, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl.reveal(), max: options.max ?? 10 });
  return drizzle(pool, { schema });
}

export { schema };
