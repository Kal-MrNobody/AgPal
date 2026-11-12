import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Secret } from '@agpal/shared';
import { createDb, type Database } from './index.js';
import { runMigrations } from './migrate.js';

export interface TestDatabase {
  db: Database;
  url: string;
  drop: () => Promise<void>;
}

/** The admin URL tests use to create throwaway databases. */
export const testDatabaseUrl = (): string | undefined => process.env.DATABASE_URL;

/**
 * Create an isolated, migrated database for one test file. Requires DATABASE_URL pointing at a
 * Postgres where the user may CREATE DATABASE (docker compose provides one).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = testDatabaseUrl();
  if (!admin) throw new Error('DATABASE_URL is required for database tests');
  const name = `agpal_test_${randomBytes(6).toString('hex')}`;
  const adminClient = new pg.Client({ connectionString: admin });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE ${name}`);
  await adminClient.end();

  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = createDb(new Secret(url.toString()), { max: 20 });
  await runMigrations(db);

  return {
    db,
    url: url.toString(),
    drop: async () => {
      await db.$client.end();
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
