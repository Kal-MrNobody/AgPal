import { describe, expect, it } from 'vitest';
import { Secret } from '@agpal/shared';
import { createDb } from './index.js';

describe('createDb', () => {
  it('builds a client lazily without connecting', async () => {
    const db = createDb(new Secret('postgres://nobody:nothing@127.0.0.1:1/none'), { max: 1 });
    expect(db.$client).toBeDefined();
    await db.$client.end();
  });

  it.runIf(process.env.DATABASE_URL)('reaches Postgres when DATABASE_URL is set', async () => {
    const db = createDb(new Secret(process.env.DATABASE_URL ?? ''), { max: 1 });
    const res = await db.$client.query<{ ok: number }>('select 1 as ok');
    expect(res.rows[0]?.ok).toBe(1);
    await db.$client.end();
  });
});
