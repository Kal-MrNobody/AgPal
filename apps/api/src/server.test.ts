import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('api', () => {
  it('reports health', async () => {
    const app = buildServer({ logLevel: 'silent', checkDatabase: () => Promise.resolve(true) });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: true });
    await app.close();
  });

  it('reports degraded when the database check fails', async () => {
    const app = buildServer({
      logLevel: 'silent',
      checkDatabase: () => Promise.reject(new Error('down')),
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'degraded', database: false });
    await app.close();
  });
});
