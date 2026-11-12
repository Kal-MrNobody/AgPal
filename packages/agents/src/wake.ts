import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { agents, domainEvents, type Database } from '@agpal/db';

/**
 * Event wake-ups (Prompt 11): which agents to wake for domain events created after `since`. An event addressed to a
 * department wakes that department's agents; Finance also wakes for envelope and reconciliation alerts.
 */
export async function agentsToWake(
  db: Database,
  companyId: string,
  since: Date,
): Promise<{ agentId: string; eventId: string; name: string; at: Date }[]> {
  const events = await db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.companyId, companyId),
        gt(domainEvents.createdAt, since),
        isNotNull(domainEvents.department),
      ),
    );
  if (events.length === 0) return [];
  const staff = await db.select().from(agents).where(eq(agents.companyId, companyId));
  const out: { agentId: string; eventId: string; name: string; at: Date }[] = [];
  for (const e of events) {
    for (const a of staff)
      if (a.department === e.department)
        out.push({ agentId: a.id, eventId: e.id, name: e.name, at: e.createdAt });
  }
  return out;
}
