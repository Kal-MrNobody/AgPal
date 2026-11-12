import type { FastifyInstance } from 'fastify';
import type { Database } from '@agpal/db';
import type { Services } from '@agpal/policy';

export interface RouteDeps {
  db: Database;
  services: Services;
  companyId?: string;
}

/** Read endpoints and gate endpoints for the boardroom (expanded in Phase 4). */
export function registerReadRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/balances', async (_req, reply) => {
    if (!deps.companyId) return reply.code(503).send({ error: 'AGPAL_COMPANY_ID not set' });
    const balances = await deps.services.ledger.balances(deps.companyId);
    return Object.fromEntries([...balances].map(([k, v]) => [k, v.toString()]));
  });
}
