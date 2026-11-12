import { and, eq, gte, sql } from 'drizzle-orm';
import {
  agentControls,
  approvals,
  auditLog,
  journalEntries,
  spendIntents,
  tasks,
  internalInvoices,
  type Database,
} from '@agpal/db';

/**
 * Graduated autonomy (constitution §4). The trust score comes only from the ledger and gate record, never from the
 * model: +1 per accepted deliverable or settled internal invoice, −3 per reversal it caused, −2 per refund it caused,
 * −2 per policy denial, −3 per founder override (a held request of its that the founder rejected). Trailing 30 days.
 */
export interface TrustRecord {
  agentId: string;
  acceptedWork: number;
  reversals: number;
  refunds: number;
  denials: number;
  overrides: number;
  score: number;
  /** Days since the last policy denial (∞ if none in the window). */
  daysSinceDenial: number;
}

export const TRUST_WINDOW_DAYS = 30;

export async function trustRecord(
  db: Database,
  companyId: string,
  agentId: string,
  department: string,
  now = new Date(),
): Promise<TrustRecord> {
  const since = new Date(now.getTime() - TRUST_WINDOW_DAYS * 86_400_000);
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;

  const acceptedTasks = await count(
    db
      .select({ n })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.toDepartment, department),
          eq(tasks.status, 'accepted'),
          gte(tasks.updatedAt, since),
        ),
      ),
  );
  const settledInvoices = await count(
    db
      .select({ n })
      .from(internalInvoices)
      .where(
        and(
          eq(internalInvoices.companyId, companyId),
          eq(internalInvoices.sellerDepartment, department),
          eq(internalInvoices.status, 'settled'),
          gte(internalInvoices.updatedAt, since),
        ),
      ),
  );
  // Reversals of entries this agent caused (excluding the routine reversal of a failed payout's provider leg).
  const reversals = await count(
    db
      .select({ n })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          gte(journalEntries.createdAt, since),
          sql`${journalEntries.reversesEntryId} IN (SELECT id FROM journal_entries WHERE agent_id = ${agentId})`,
        ),
      ),
  );
  const refunds = await count(
    db
      .select({ n })
      .from(spendIntents)
      .where(
        and(
          eq(spendIntents.companyId, companyId),
          eq(spendIntents.agentId, agentId),
          eq(spendIntents.action, 'refund'),
          eq(spendIntents.status, 'executed'),
          gte(spendIntents.createdAt, since),
        ),
      ),
  );
  const denialRows = await db
    .select({ at: spendIntents.createdAt })
    .from(spendIntents)
    .where(
      and(
        eq(spendIntents.companyId, companyId),
        eq(spendIntents.agentId, agentId),
        eq(spendIntents.decision, 'deny'),
        gte(spendIntents.createdAt, since),
      ),
    );
  const overrides = await count(
    db
      .select({ n })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, 'rejected'),
          gte(approvals.createdAt, since),
          sql`${approvals.intent}->>'agentId' = ${agentId}`,
        ),
      ),
  );
  const acceptedWork = acceptedTasks + settledInvoices;
  const denials = denialRows.length;
  const lastDenial = denialRows.reduce<Date | undefined>(
    (m, r) => (!m || r.at > m ? r.at : m),
    undefined,
  );
  return {
    agentId,
    acceptedWork,
    reversals,
    refunds,
    denials,
    overrides,
    score: acceptedWork - 3 * reversals - 2 * refunds - 2 * denials - 3 * overrides,
    daysSinceDenial: lastDenial
      ? Math.floor((now.getTime() - lastDenial.getTime()) / 86_400_000)
      : Number.POSITIVE_INFINITY,
  };
}

export interface LevelChange {
  agentId: string;
  from: number;
  to: number;
  reason: string;
}

/**
 * Next level from the record (§4): promote one level when score ≥ 10 and no denial in 7 days (never to 4 without a
 * founder pin); demote one level when score < 0 or after any founder override. A pinned level never moves.
 */
export function nextLevel(
  current: number,
  pinned: number | null,
  r: TrustRecord,
  overrideSinceLastChange: boolean,
): { level: number; reason: string } {
  if (pinned !== null) return { level: pinned, reason: 'pinned by the founder' };
  if (overrideSinceLastChange && current > 0)
    return { level: current - 1, reason: 'founder override' };
  if (r.score < 0 && current > 0)
    return { level: current - 1, reason: `trust score ${r.score} < 0` };
  if (r.score >= 10 && r.daysSinceDenial >= 7 && current < 3)
    return { level: current + 1, reason: `trust score ${r.score} ≥ 10 and no denial for 7 days` };
  return { level: current, reason: 'unchanged' };
}

/**
 * Apply level changes at the UTC day boundary (run by the worker after midnight). Changes are logged in the audit log
 * and take effect for every later gate decision. Idempotent per agent per day.
 */
export async function applyDailyAutonomy(
  db: Database,
  companyId: string,
  agents: { id: string; department: string }[],
  now = new Date(),
): Promise<LevelChange[]> {
  const day = now.toISOString().slice(0, 10);
  const changes: LevelChange[] = [];
  for (const a of agents) {
    const [ctl] = await db.select().from(agentControls).where(eq(agentControls.agentId, a.id));
    const current = ctl?.autonomyLevel ?? 1;
    const [already] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectId, a.id),
          eq(auditLog.action, 'autonomy.daily'),
          sql`${auditLog.data}->>'day' = ${day}`,
        ),
      );
    if ((already?.n ?? 0) > 0) continue;
    const r = await trustRecord(db, companyId, a.id, a.department, now);
    const lastChange = ctl?.updatedAt ?? new Date(0);
    const [ov] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, 'rejected'),
          gte(approvals.decidedAt, lastChange),
          sql`${approvals.intent}->>'agentId' = ${a.id}`,
        ),
      );
    const next = nextLevel(current, ctl?.pinnedLevel ?? null, r, (ov?.n ?? 0) > 0);
    if (next.level !== current) {
      await db
        .insert(agentControls)
        .values({ companyId, agentId: a.id, autonomyLevel: next.level })
        .onConflictDoUpdate({
          target: agentControls.agentId,
          set: { autonomyLevel: next.level, updatedAt: now },
        });
      changes.push({ agentId: a.id, from: current, to: next.level, reason: next.reason });
    }
    await db.insert(auditLog).values({
      companyId,
      actor: 'system',
      action: 'autonomy.daily',
      subjectType: 'agent',
      subjectId: a.id,
      data: {
        day,
        from: current,
        to: next.level,
        reason: next.reason,
        score: r.score,
        record: {
          ...r,
          daysSinceDenial: Number.isFinite(r.daysSinceDenial) ? r.daysSinceDenial : null,
        },
      },
    });
  }
  return changes;
}

/** Founder pins (or unpins with null) an agent's level. */
export async function pinAutonomy(
  db: Database,
  companyId: string,
  agentId: string,
  level: number | null,
): Promise<void> {
  if (level !== null && (level < 0 || level > 4)) throw new Error('Level must be 0–4');
  await db
    .insert(agentControls)
    .values({
      companyId,
      agentId,
      pinnedLevel: level,
      ...(level !== null ? { autonomyLevel: level } : {}),
    })
    .onConflictDoUpdate({
      target: agentControls.agentId,
      set: {
        pinnedLevel: level,
        ...(level !== null ? { autonomyLevel: level } : {}),
        updatedAt: new Date(),
      },
    });
  await db.insert(auditLog).values({
    companyId,
    actor: 'founder',
    action: level === null ? 'autonomy.unpinned' : 'autonomy.pinned',
    subjectType: 'agent',
    subjectId: agentId,
    data: { level },
  });
}
