import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { createServices } from '@agpal/policy';
import { loadEnv } from '@agpal/shared';
import { defaultModelConfig } from './models.js';
import { ScriptedProvider } from './provider.js';
import { simulateWeek } from './sim.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)('simulated week, dry mode', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());

  it('runs a full week without a single real HTTP call, and without invariant violations', async () => {
    // Any real network call fails the test: fetch, and Node's http/https used by the PayPal SDK (axios).
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('real HTTP call in dry mode')));
    // The CommonJS module objects (what axios and the PayPal SDK call into) are patchable; ESM namespaces are not.
    const require = createRequire(import.meta.url);
    const http = require('node:http') as typeof import('node:http');
    const https = require('node:https') as typeof import('node:https');
    const httpSpy = vi.spyOn(http, 'request').mockImplementation(() => {
      throw new Error('real HTTP call in dry mode');
    });
    const httpsSpy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('real HTTP call in dry mode');
    });
    try {
      const env = loadEnv({
        DATABASE_URL: process.env.DATABASE_URL,
        PAYPAL_CLIENT_ID: 'dry',
        PAYPAL_CLIENT_SECRET: 'dry',
      });
      const services = createServices(t.db, env, { dry: true });
      // A quiet scripted model: every run checks its envelope and stops.
      const provider = new ScriptedProvider(
        Array.from({ length: 400 }, (_, i) =>
          i % 2 === 0
            ? { toolCalls: [{ callId: `c${i}`, name: 'get_envelope', arguments: '{}' }] }
            : { text: 'SUMMARY: checked budget' },
        ),
      );
      const report = await simulateWeek({
        db: t.db,
        services,
        provider,
        models: defaultModelConfig,
        days: 7,
        ordersPerDay: 2,
      });

      expect(report.paypalAttemptsInDryMode).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
      expect(report.invariantViolations).toEqual([]);
      expect(report.runs.filter((r) => r.status === 'completed').length).toBeGreaterThanOrEqual(28);
      // 14 card sales + 3 simulated subscription payments (2 on day 1, 1 on day 4) landed as revenue.
      expect(report.pnl.revenue?.['revenue:sales']).toBeGreaterThan(0n);
      expect(report.pnl.revenue?.['revenue:subscriptions']).toBe(2_700n);
      // The simulated dispute opened and was released.
      expect(report.envelopes.growth?.balance).toBeGreaterThan(0n);
    } finally {
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
    }
  }, 120_000);
});
