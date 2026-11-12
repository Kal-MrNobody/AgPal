import { and, eq, inArray, lte, sql, sum } from 'drizzle-orm';
import {
  accounts,
  companies,
  departments as departmentsTable,
  envelopes,
  holds,
  journalEntries,
  postings,
  type Database,
  type DbOrTx,
  type Tx,
} from '@agpal/db';
import { newId, type Attribution, type Currency } from '@agpal/shared';
import { assertBalanced, LedgerError } from './entry.js';

export { LedgerError };
import { ACC, chartOfAccounts, isEnvelopeAccount, payableSpec, type AccountSpec } from './chart.js';

export class InsufficientFundsError extends LedgerError {
  override name = 'InsufficientFundsError';
}
export class UnknownAccountError extends LedgerError {
  override name = 'UnknownAccountError';
}

export interface EntryInput {
  companyId: string;
  description: string;
  /** Constitution flow name, e.g. `capture`, `allocation`, `payout_sent`. */
  flow: string;
  currency: Currency;
  postings: readonly { account: string; amountMinor: bigint }[];
  /** `founder`, `system`, or `agent`. Agent entries must carry attribution (invariant 7). */
  actor: string;
  attribution?: Attribution;
  externalRef?: string;
  idempotencyKey?: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
  reversesEntryId?: string;
}

export interface PostResult {
  entryId: string;
  /** True when an entry with the same idempotency key already existed and nothing was posted. */
  duplicate: boolean;
}

export interface EnvelopeState {
  balance: bigint;
  held: bigint;
  available: bigint;
}

export interface CompanySetup {
  id: string;
  name: string;
  currency: Currency;
  departments: readonly { code: string; name: string }[];
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && e.code === '23505';

const causeOf = (e: unknown): unknown =>
  typeof e === 'object' && e !== null && 'cause' in e ? e.cause : e;

export class Ledger {
  constructor(private readonly db: Database) {}

  /** Create a company with its departments, chart of accounts and one envelope per department. */
  async setupCompany(setup: CompanySetup): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(companies)
        .values({ id: setup.id, name: setup.name, currency: setup.currency });
      for (const d of setup.departments) {
        await tx
          .insert(departmentsTable)
          .values({ id: newId('dep'), companyId: setup.id, code: d.code, name: d.name });
      }
      for (const spec of chartOfAccounts(setup.departments.map((d) => d.code))) {
        await this.insertAccount(tx, setup.id, setup.currency, spec);
      }
      for (const d of setup.departments) {
        const [acct] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.companyId, setup.id), eq(accounts.code, ACC.envelope(d.code))));
        if (!acct) throw new LedgerError('envelope account missing');
        await tx.insert(envelopes).values({
          id: newId('env'),
          companyId: setup.id,
          departmentCode: d.code,
          accountId: acct.id,
          currency: setup.currency,
        });
      }
    });
  }

  private async insertAccount(
    tx: DbOrTx,
    companyId: string,
    currency: Currency,
    spec: AccountSpec,
  ): Promise<void> {
    await tx
      .insert(accounts)
      .values({
        id: newId('acc'),
        companyId,
        code: spec.code,
        type: spec.type,
        rule: spec.rule,
        departmentCode: spec.departmentCode ?? null,
        currency,
      })
      .onConflictDoNothing();
  }

  /** Create the payable account for an external payee if it does not exist. */
  async ensurePayable(companyId: string, payeeKey: string, currency: Currency): Promise<string> {
    const spec = payableSpec(payeeKey);
    await this.insertAccount(this.db, companyId, currency, spec);
    return spec.code;
  }

  /** Post a balanced entry. Idempotent on `idempotencyKey`. Runs in its own transaction unless given one. */
  async post(input: EntryInput, tx?: Tx): Promise<PostResult> {
    if (tx) return this.postIn(tx, input);
    try {
      return await this.db.transaction((t) => this.postIn(t, input));
    } catch (e) {
      if (input.idempotencyKey && isUniqueViolation(causeOf(e))) {
        const existing = await this.findByIdempotencyKey(
          this.db,
          input.companyId,
          input.idempotencyKey,
        );
        if (existing) return { entryId: existing, duplicate: true };
      }
      throw e;
    }
  }

  /** The entry posted with this idempotency key, if any. */
  async findEntry(companyId: string, idempotencyKey: string): Promise<string | undefined> {
    return this.findByIdempotencyKey(this.db, companyId, idempotencyKey);
  }

  /** Company and id of the first entry booking this PayPal id (capture, refund, payout item). */
  async findByExternalRef(
    externalRef: string,
  ): Promise<{ companyId: string; entryId: string; flow: string } | undefined> {
    const [row] = await this.db
      .select({
        companyId: journalEntries.companyId,
        entryId: journalEntries.id,
        flow: journalEntries.flow,
      })
      .from(journalEntries)
      .where(eq(journalEntries.externalRef, externalRef))
      .orderBy(journalEntries.createdAt)
      .limit(1);
    return row;
  }

  private async findByIdempotencyKey(
    db: DbOrTx,
    companyId: string,
    key: string,
  ): Promise<string | undefined> {
    const [row] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.idempotencyKey, key)));
    return row?.id;
  }

  private async postIn(tx: Tx, input: EntryInput, convertingHoldId?: string): Promise<PostResult> {
    if (input.actor === 'agent' && !input.attribution) {
      throw new LedgerError('Agent entries need attribution (invariant 7)');
    }
    if (input.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(tx, input.companyId, input.idempotencyKey);
      if (existing) return { entryId: existing, duplicate: true };
    }
    const postingsIn = input.postings.map((p) => ({
      accountId: p.account,
      amountMinor: p.amountMinor,
      currency: input.currency,
    }));
    assertBalanced({ postings: postingsIn });

    // Aggregate per account, then lock rows in a stable order to avoid deadlocks.
    const deltas = new Map<string, bigint>();
    for (const p of input.postings)
      deltas.set(p.account, (deltas.get(p.account) ?? 0n) + p.amountMinor);
    const codes = [...deltas.keys()].sort();
    const rows = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, input.companyId), inArray(accounts.code, codes)))
      .orderBy(accounts.id)
      .for('update');
    const byCode = new Map(rows.map((r) => [r.code, r]));
    for (const code of codes) {
      const row = byCode.get(code);
      if (!row)
        throw new UnknownAccountError(`Unknown account ${code} for company ${input.companyId}`);
      if (row.currency !== input.currency) {
        throw new LedgerError(`Account ${code} is ${row.currency}, entry is ${input.currency}`);
      }
    }

    for (const code of codes) {
      const row = byCode.get(code);
      const delta = deltas.get(code) ?? 0n;
      if (!row || delta === 0n) continue;
      const next = row.balanceMinor + delta;
      if (row.rule === 'non_negative' && next < 0n) {
        throw new InsufficientFundsError(`${code} would go negative (${next})`);
      }
      if (row.rule === 'non_positive' && next > 0n) {
        throw new LedgerError(`${code} would go positive (${next})`);
      }
      if (isEnvelopeAccount(code) && delta < 0n) {
        const held = await this.activeHolds(tx, row.id, convertingHoldId);
        if (next - held < 0n) {
          throw new InsufficientFundsError(
            `${code}: ${next} after posting is less than ${held} held`,
          );
        }
      }
    }

    const entryId = newId('je');
    await tx.insert(journalEntries).values({
      id: entryId,
      companyId: input.companyId,
      description: input.description,
      flow: input.flow,
      actor: input.actor,
      agentId: input.attribution?.agentId ?? null,
      runId: input.attribution?.runId ?? null,
      reason: input.attribution?.reason ?? null,
      externalRef: input.externalRef ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      metadata: input.metadata ?? {},
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    });
    await tx.insert(postings).values(
      input.postings.map((p) => {
        const row = byCode.get(p.account);
        if (!row) throw new UnknownAccountError(p.account);
        return { entryId, accountId: row.id, amountMinor: p.amountMinor, currency: input.currency };
      }),
    );
    for (const code of codes) {
      const row = byCode.get(code);
      const delta = deltas.get(code) ?? 0n;
      if (!row || delta === 0n) continue;
      await tx
        .update(accounts)
        .set({ balanceMinor: sql`${accounts.balanceMinor} + ${delta.toString()}::bigint` })
        .where(eq(accounts.id, row.id));
    }
    return { entryId, duplicate: false };
  }

  private async activeHolds(
    db: DbOrTx,
    accountId: string,
    excludingHoldId?: string,
  ): Promise<bigint> {
    const [row] = await db
      .select({ total: sum(holds.amountMinor) })
      .from(holds)
      .innerJoin(envelopes, eq(envelopes.id, holds.envelopeId))
      .where(
        and(
          eq(envelopes.accountId, accountId),
          eq(holds.status, 'active'),
          excludingHoldId ? sql`${holds.id} <> ${excludingHoldId}` : undefined,
        ),
      );
    return BigInt(row?.total ?? '0');
  }

  /** Post the reversing entry of `entryId`. The original is never modified. One reversal per entry. */
  async reverse(
    companyId: string,
    entryId: string,
    reason: string,
    actor: string,
    attribution?: Attribution,
    tx?: Tx,
  ): Promise<PostResult> {
    const run = async (t: Tx): Promise<PostResult> => {
      const [entry] = await t
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, companyId)));
      if (!entry) throw new LedgerError(`No entry ${entryId}`);
      if (entry.reversesEntryId) throw new LedgerError(`${entryId} is itself a reversal`);
      const lines = await t
        .select({ code: accounts.code, amount: postings.amountMinor, currency: postings.currency })
        .from(postings)
        .innerJoin(accounts, eq(accounts.id, postings.accountId))
        .where(eq(postings.entryId, entryId));
      const currency = lines[0]?.currency as Currency;
      return this.postIn(t, {
        companyId,
        description: `Reversal of ${entryId}: ${reason}`,
        flow: `reversal:${entry.flow}`,
        currency,
        postings: lines.map((l) => ({ account: l.code, amountMinor: -l.amount })),
        actor,
        ...(attribution ? { attribution } : {}),
        ...(entry.externalRef ? { externalRef: entry.externalRef } : {}),
        reversesEntryId: entryId,
        idempotencyKey: `reversal:${entryId}`,
      });
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /** Balance of an account, optionally as of a point in time (by entry occurred_at). */
  async balance(companyId: string, code: string, at?: Date): Promise<bigint> {
    if (!at) {
      const [row] = await this.db
        .select({ b: accounts.balanceMinor })
        .from(accounts)
        .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)));
      if (!row) throw new UnknownAccountError(code);
      return row.b;
    }
    const [row] = await this.db
      .select({ total: sum(postings.amountMinor) })
      .from(postings)
      .innerJoin(accounts, eq(accounts.id, postings.accountId))
      .innerJoin(journalEntries, eq(journalEntries.id, postings.entryId))
      .where(
        and(
          eq(accounts.companyId, companyId),
          eq(accounts.code, code),
          lte(journalEntries.occurredAt, at),
        ),
      );
    return BigInt(row?.total ?? '0');
  }

  /** All non-zero balances, by account code. */
  async balances(companyId: string): Promise<Map<string, bigint>> {
    const rows = await this.db
      .select({ code: accounts.code, b: accounts.balanceMinor })
      .from(accounts)
      .where(eq(accounts.companyId, companyId));
    return new Map(rows.filter((r) => r.b !== 0n).map((r) => [r.code, r.b]));
  }

  async envelope(companyId: string, dept: string): Promise<EnvelopeState> {
    const env = await this.envelopeRow(this.db, companyId, dept);
    const [acct] = await this.db
      .select({ b: accounts.balanceMinor })
      .from(accounts)
      .where(eq(accounts.id, env.accountId));
    const held = await this.activeHolds(this.db, env.accountId);
    const balance = acct?.b ?? 0n;
    return { balance, held, available: balance - held };
  }

  private async envelopeRow(db: DbOrTx, companyId: string, dept: string) {
    const [env] = await db
      .select()
      .from(envelopes)
      .where(and(eq(envelopes.companyId, companyId), eq(envelopes.departmentCode, dept)));
    if (!env) throw new UnknownAccountError(`No envelope for ${dept}`);
    return env;
  }

  /**
   * Reserve funds on an envelope while an external payment is in flight. The envelope's account row is
   * locked, so two concurrent holds cannot both pass if together they exceed the available amount.
   * Idempotent on `reference`.
   */
  async placeHold(
    companyId: string,
    dept: string,
    amountMinor: bigint,
    reference: string,
    tx?: Tx,
  ): Promise<string> {
    if (amountMinor <= 0n) throw new LedgerError('Hold amount must be positive');
    const run = async (t: Tx): Promise<string> => {
      const env = await this.envelopeRow(t, companyId, dept);
      const [existing] = await t
        .select({ id: holds.id })
        .from(holds)
        .where(and(eq(holds.companyId, companyId), eq(holds.reference, reference)));
      if (existing) return existing.id;
      const [acct] = await t
        .select()
        .from(accounts)
        .where(eq(accounts.id, env.accountId))
        .for('update');
      if (!acct) throw new UnknownAccountError(`envelope account for ${dept}`);
      const held = await this.activeHolds(t, env.accountId);
      const available = acct.balanceMinor - held;
      if (available < amountMinor) {
        throw new InsufficientFundsError(
          `Envelope ${dept} has ${available} available, needs ${amountMinor}`,
        );
      }
      const id = newId('hold');
      await t.insert(holds).values({
        id,
        companyId,
        envelopeId: env.id,
        amountMinor,
        currency: env.currency,
        reference,
      });
      return id;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  async releaseHold(holdId: string, tx?: Tx): Promise<void> {
    const db = tx ?? this.db;
    await db
      .update(holds)
      .set({ status: 'released', resolvedAt: new Date() })
      .where(and(eq(holds.id, holdId), eq(holds.status, 'active')));
  }

  /** Post the entry that settles a hold and mark the hold converted, atomically. */
  async convertHold(holdId: string, input: EntryInput, tx?: Tx): Promise<PostResult> {
    const run = async (t: Tx): Promise<PostResult> => {
      const [hold] = await t.select().from(holds).where(eq(holds.id, holdId)).for('update');
      if (!hold) throw new LedgerError(`No hold ${holdId}`);
      if (hold.status === 'converted' && hold.convertedEntryId) {
        return { entryId: hold.convertedEntryId, duplicate: true };
      }
      if (hold.status !== 'active') throw new LedgerError(`Hold ${holdId} is ${hold.status}`);
      const result = await this.postIn(t, input, holdId);
      await t
        .update(holds)
        .set({ status: 'converted', convertedEntryId: result.entryId, resolvedAt: new Date() })
        .where(eq(holds.id, holdId));
      return result;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  get database(): Database {
    return this.db;
  }
}
