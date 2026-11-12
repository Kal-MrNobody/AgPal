import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { and, eq } from 'drizzle-orm';
import { alerts, auditLog } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import type { Services } from '@agpal/policy';
import { newId } from '@agpal/shared';
import { registerReadRoutes } from './routes.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)('POST /api/alerts/:id/resolve', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());

  it('founder-only, needs a reason, resolves once, and is audited', async () => {
    const co = newId('co');
    const id = newId('alr');
    await t.db.insert(alerts).values({
      id,
      companyId: co,
      kind: 'webhook.suspense',
      severity: 'critical',
      message: 'Payout item X matches no intent',
    });
    const app = Fastify();
    registerReadRoutes(app, {
      db: t.db,
      services: {} as Services,
      companyId: co,
      adminToken: 'tok',
    });
    const post = (note: string, token = 'tok') =>
      app.inject({
        method: 'POST',
        url: `/api/alerts/${id}/resolve`,
        headers: { 'x-agpal-admin': token },
        payload: { note },
      });

    expect((await post('sandbox test traffic', 'wrong')).statusCode).toBe(401);
    expect((await post('ok')).statusCode).toBe(400);
    const ok = await post('Event from our own sandbox tests, not this company');
    expect(ok.json()).toEqual({ status: 'resolved', alertId: id });
    expect((await post('again, please')).statusCode).toBe(404);

    const [row] = await t.db.select().from(alerts).where(eq(alerts.id, id));
    expect(row?.resolvedAt).toBeInstanceOf(Date);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, id), eq(auditLog.action, 'alert.resolved')));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'founder', data: { kind: 'webhook.suspense' } });
    await app.close();
  });
});
