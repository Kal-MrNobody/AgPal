import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alerts, journalEntries, reconciliationRuns, type Database } from '@agpal/db';
import { ACC, isTreasuryAccount, type Ledger } from '@agpal/ledger';
import { newId, type Currency } from '@agpal/shared';
import type { PayPalInbound } from './inbound.js';

/** PayPal transaction event codes we book, and which ledger flow they match. */
const CODE_FLOWS: Record<string, string[]> = {
  T0006: ['capture'], // PayPal checkout / Orders API
  T0005: ['capture'], // direct card payment (Orders API with a card payment_source)
  T0003: ['capture'], // pre-approved payment (subscriptions)
  T0002: ['capture'], // subscription payment
  T0011: ['capture'], // mobile/card payment
  T0001: ['payout_sent'], // mass pay / Payouts
  T1107: ['refund'], // payment refund
  T1106: ['refund'], // payment reversal
};
/** Codes that are holds/releases or balance movements covered by the balance check, not separate entries. */
const INFO_CODES = new Set([
  'T1105', // release of a general account hold (e.g. after a payout is sent)
  'T1503', // hold on available balance (reserved while a payout is processed)
  'T2002', // hold on a new payment's net amount (sandbox/new-account payment hold)
  'T1110',
  'T1111',
  'T1201',
  'T1202',
  'T0400',
  'T0200',
  'T2101',
  'T2102',
]);

/** Fetch single transactions by id, to verify items still inside Transaction Search's lag window. */
export type LiveLookup = Pick<PayPalInbound, 'getCapture' | 'getRefund' | 'getPayoutItem'>;

export type MismatchKind =
  | 'missing_in_ledger'
  | 'missing_in_paypal'
  | 'amount_mismatch'
  | 'status_mismatch'
  | 'balance_mismatch'
  | 'suspense';

export interface ReconItem {
  /** `verified_live`: inside the lag window, but fetched by id from PayPal and equal to the cent. */
  kind: MismatchKind | 'matched' | 'verified_live' | 'pending' | 'info';
  transactionId?: string;
  entryId?: string;
  eventCode?: string;
  detail: string;
}

export interface ReconReport {
  runId: string;
  companyId: string;
  windowStart: Date;
  windowEnd: Date;
  /** How far PayPal's data is complete; ledger items after this are pending, not missing. */
  coverageEnd: Date;
  clean: boolean;
  counts: Record<ReconItem['kind'], number>;
  balance?: {
    asOf: string;
    ledgerTreasuryMinor: bigint;
    paypalAvailableMinor: bigint;
    ledgerWithheldMinor: bigint;
    paypalWithheldMinor: bigint;
    checked: boolean;
  };
  items: ReconItem[];
}

export interface ReconcileOptions {
  /** PayPal transactions before this time belong to someone else (e.g. before the company's opening balance). */
  notBefore?: Date;
  /** Assumed lag when PayPal does not report `last_refreshed_datetime`. Default 3h. */
  lagMs?: number;
  /** Pending ledger items older than this become mismatches. Default 24h. */
  pendingGraceMs?: number;
  now?: Date;
  currency?: Currency;
  /** Verify pending items by fetching them from PayPal by id. */
  live?: LiveLookup;
  /** Skip the balance comparison (e.g. a sandbox account shared with tests). */
  skipBalance?: boolean;
}

interface LedgerSide {
  entryId: string;
  flow: string;
  ref: string;
  /** PayPal object id (capture, refund or payout item) for lookups. */
  objectId: string;
  occurredAt: Date;
  grossMinor: bigint;
  feeMinor: bigint;
}

/**
 * Daily (and on-demand) reconciliation, constitution §5. Zero tolerance: every PayPal transaction in the window must
 * match a ledger entry on gross, fee and net, and the treasury must equal PayPal's balance at PayPal's as-of time.
 */
export class Reconciler {
  constructor(
    private readonly db: Database,
    private readonly ledger: Ledger,
    private readonly paypal: Pick<PayPalInbound, 'searchTransactions' | 'balances'>,
  ) {}

  async run(
    companyId: string,
    windowStart: Date,
    windowEnd: Date,
    opts: ReconcileOptions = {},
  ): Promise<ReconReport> {
    const now = opts.now ?? new Date();
    const currency = opts.currency ?? 'USD';
    const start = opts.notBefore && opts.notBefore > windowStart ? opts.notBefore : windowStart;
    const end = windowEnd > now ? now : windowEnd;
    const records = await this.paypal.searchTransactions(start, end);
    const coverageEnd =
      (records as { lastRefreshed?: Date }).lastRefreshed ??
      new Date(now.getTime() - (opts.lagMs ?? 3 * 3_600_000));
    const items: ReconItem[] = [];

    const ledgerSide = await this.ledgerItems(companyId, start, end);
    // A payout's ledger ref is PayPal's payout item id until settlement records its transaction id. With a live lookup,
    // resolve unsettled items to the transaction id Transaction Search reports (T0001), so they can match.
    if (opts.live) {
      const lookup = opts.live;
      await Promise.all(
        ledgerSide
          .filter((l) => l.flow === 'payout_sent' && l.ref === l.objectId)
          .map(async (l) => {
            const item = await lookup.getPayoutItem(l.objectId).catch(() => undefined);
            if (item?.transactionId) l.ref = item.transactionId;
          }),
      );
    }
    const byRef = new Map(ledgerSide.map((l) => [l.ref, l]));
    const matchedRefs = new Set<string>();

    for (const t of records) {
      if (t.currency !== currency) continue;
      const expected = CODE_FLOWS[t.eventCode];
      if (!expected) {
        items.push(
          INFO_CODES.has(t.eventCode)
            ? {
                kind: 'info',
                transactionId: t.transactionId,
                eventCode: t.eventCode,
                detail: 'Balance movement covered by the balance check',
              }
            : {
                kind: 'missing_in_ledger',
                transactionId: t.transactionId,
                eventCode: t.eventCode,
                detail: `Unhandled PayPal transaction type ${t.eventCode}`,
              },
        );
        continue;
      }
      const l = byRef.get(t.transactionId);
      if (!l) {
        items.push({
          kind: 'missing_in_ledger',
          transactionId: t.transactionId,
          eventCode: t.eventCode,
          detail: `${t.eventCode} ${fmt(t.grossMinor)} (fee ${fmt(t.feeMinor)}) has no ledger entry`,
        });
        continue;
      }
      matchedRefs.add(t.transactionId);
      if (t.status === 'P') {
        items.push({
          kind: 'pending',
          transactionId: t.transactionId,
          entryId: l.entryId,
          detail: 'PayPal still shows this transaction as pending',
        });
        continue;
      }
      if (t.status === 'D' || t.status === 'V') {
        items.push({
          kind: 'status_mismatch',
          transactionId: t.transactionId,
          entryId: l.entryId,
          detail: `PayPal status ${t.status} (denied/reversed) but the ledger booked it`,
        });
        continue;
      }
      // PayPal signs amounts from the account's point of view; compare absolute gross and fee.
      const gross = abs(t.grossMinor);
      const fee = abs(t.feeMinor);
      if (gross !== l.grossMinor || fee !== l.feeMinor || !expected.includes(l.flow)) {
        items.push({
          kind: 'amount_mismatch',
          transactionId: t.transactionId,
          entryId: l.entryId,
          detail: `PayPal gross ${fmt(gross)} fee ${fmt(fee)} vs ledger gross ${fmt(l.grossMinor)} fee ${fmt(l.feeMinor)} (${l.flow})`,
        });
        continue;
      }
      items.push({
        kind: 'matched',
        transactionId: t.transactionId,
        entryId: l.entryId,
        detail: `${t.eventCode} ${fmt(gross)}`,
      });
    }

    const grace = opts.pendingGraceMs ?? 24 * 3_600_000;
    for (const l of ledgerSide) {
      if (matchedRefs.has(l.ref)) continue;
      const ageMs = now.getTime() - l.occurredAt.getTime();
      if (l.occurredAt > coverageEnd && ageMs < grace) {
        items.push(
          opts.live
            ? await this.verifyLive(opts.live, l)
            : {
                kind: 'pending',
                entryId: l.entryId,
                transactionId: l.ref,
                detail: `Booked ${l.flow} after PayPal's data cutoff; will be checked next run`,
              },
        );
      } else {
        items.push({
          kind: 'missing_in_paypal',
          entryId: l.entryId,
          transactionId: l.ref,
          detail: `Ledger ${l.flow} ${fmt(l.grossMinor)} not found in PayPal Transaction Search`,
        });
      }
    }

    const openSuspense = await this.db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.companyId, companyId),
          eq(alerts.kind, 'webhook.suspense'),
          isNull(alerts.resolvedAt),
        ),
      );
    for (const a of openSuspense) items.push({ kind: 'suspense', detail: a.message });
    const suspenseBalance = await this.ledger.balance(companyId, ACC.suspense);
    if (suspenseBalance !== 0n)
      items.push({ kind: 'suspense', detail: `cash:suspense holds ${fmt(suspenseBalance)}` });

    const balance = opts.skipBalance
      ? undefined
      : await this.balanceCheck(companyId, currency, opts.notBefore);
    if (
      balance?.checked &&
      (balance.ledgerTreasuryMinor !== balance.paypalAvailableMinor ||
        balance.ledgerWithheldMinor !== balance.paypalWithheldMinor)
    ) {
      items.push({
        kind: 'balance_mismatch',
        detail: `At ${balance.asOf}: ledger treasury ${fmt(balance.ledgerTreasuryMinor)} vs PayPal available ${fmt(balance.paypalAvailableMinor)}; withheld ${fmt(balance.ledgerWithheldMinor)} vs ${fmt(balance.paypalWithheldMinor)}`,
      });
    }

    const counts = {
      matched: 0,
      verified_live: 0,
      pending: 0,
      info: 0,
      missing_in_ledger: 0,
      missing_in_paypal: 0,
      amount_mismatch: 0,
      status_mismatch: 0,
      balance_mismatch: 0,
      suspense: 0,
    } as ReconReport['counts'];
    for (const i of items) counts[i.kind]++;
    const problems = items.filter(
      (i) => !['matched', 'verified_live', 'pending', 'info'].includes(i.kind),
    );
    const runId = newId('rec');
    const report: ReconReport = {
      runId,
      companyId,
      windowStart: start,
      windowEnd: end,
      coverageEnd,
      clean: problems.length === 0,
      counts,
      ...(balance ? { balance } : {}),
      items,
    };

    await this.db.insert(reconciliationRuns).values({
      id: runId,
      companyId,
      windowStart: start,
      windowEnd: end,
      status: report.clean ? 'clean' : 'mismatch',
      matched: counts.matched,
      missingInLedger: counts.missing_in_ledger,
      missingInPaypal: counts.missing_in_paypal,
      pending: counts.pending,
      amountMismatches: counts.amount_mismatch + counts.status_mismatch,
      suspenseItems: counts.suspense,
      balanceDiffMinor: balance?.checked
        ? balance.ledgerTreasuryMinor - balance.paypalAvailableMinor
        : null,
      report: JSON.parse(
        JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ) as Record<string, unknown>,
    });
    // Zero tolerance: every problem is an alert for the boardroom.
    for (const p of problems) {
      await this.db.insert(alerts).values({
        id: newId('alr'),
        companyId,
        kind: `reconciliation.${p.kind}`,
        severity: 'critical',
        message: p.detail,
        data: { runId, transactionId: p.transactionId, entryId: p.entryId, eventCode: p.eventCode },
      });
    }
    return report;
  }

  private async verifyLive(live: LiveLookup, l: LedgerSide): Promise<ReconItem> {
    const base = { entryId: l.entryId, transactionId: l.ref };
    try {
      let gross: bigint;
      let fee: bigint;
      let status: string;
      if (l.flow === 'capture') {
        const c = await live.getCapture(l.objectId);
        [gross, fee, status] = [c.grossMinor, c.feeMinor, c.status];
      } else if (l.flow === 'refund') {
        const r = await live.getRefund(l.objectId);
        [gross, fee, status] = [r.grossMinor, r.feeReturnedMinor, r.status];
      } else {
        const p = await live.getPayoutItem(l.objectId);
        [gross, fee, status] = [p.amountMinor, p.feeMinor ?? -1n, p.status];
      }
      if (gross === l.grossMinor && fee === l.feeMinor) {
        return {
          kind: 'verified_live',
          ...base,
          detail: `${l.flow} ${fmt(gross)} fee ${fmt(fee)} (${status}) confirmed by id; Transaction Search will confirm after its refresh`,
        };
      }
      return {
        kind: 'amount_mismatch',
        ...base,
        detail: `PayPal (by id) gross ${fmt(gross)} fee ${fmt(fee)} vs ledger gross ${fmt(l.grossMinor)} fee ${fmt(l.feeMinor)} (${l.flow})`,
      };
    } catch (e) {
      return {
        kind: 'pending',
        ...base,
        detail: `Could not fetch ${l.flow} ${l.objectId} by id: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** Ledger entries that correspond to one PayPal transaction each, keyed by the id Transaction Search uses. */
  private async ledgerItems(companyId: string, start: Date, end: Date): Promise<LedgerSide[]> {
    const res = await this.db.execute<{
      id: string;
      flow: string;
      ref: string;
      object_id: string;
      occurred_at: Date | string;
      gross: string;
      fee: string;
    }>(sql`
      SELECT j.id, j.flow, coalesce(j.metadata->>'paypalTransactionId', j.external_ref) AS ref, j.external_ref AS object_id, j.occurred_at,
        coalesce(sum(CASE
          WHEN j.flow = 'capture' AND a.type = 'revenue' THEN -p.amount_minor
          WHEN j.flow = 'refund' AND a.code LIKE 'revenue:refunds:%' THEN p.amount_minor
          WHEN j.flow = 'payout_sent' AND a.type = 'liability' THEN p.amount_minor
          ELSE 0 END), 0) AS gross,
        coalesce(sum(CASE WHEN a.code = ${ACC.paypalFees} THEN abs(p.amount_minor) ELSE 0 END), 0) AS fee
      FROM journal_entries j
      JOIN postings p ON p.entry_id = j.id
      JOIN accounts a ON a.id = p.account_id
      WHERE j.company_id = ${companyId}
        AND j.flow IN ('capture', 'refund', 'payout_sent')
        AND j.external_ref IS NOT NULL
        AND j.occurred_at >= ${start} AND j.occurred_at <= ${end}
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = j.id)
        AND coalesce(j.metadata->>'simulated', 'false') <> 'true'
      GROUP BY j.id`);
    return res.rows.map((r) => ({
      entryId: r.id,
      flow: r.flow,
      ref: r.ref,
      objectId: r.object_id,
      occurredAt: new Date(r.occurred_at),
      grossMinor: BigInt(r.gross),
      feeMinor: BigInt(r.fee),
    }));
  }

  private async balanceCheck(
    companyId: string,
    currency: Currency,
    notBefore?: Date,
  ): Promise<ReconReport['balance']> {
    const b = await this.paypal.balances(currency);
    if (!b.asOf) return undefined;
    const asOf = new Date(b.asOf);
    const [first] = await this.db
      .select({ at: journalEntries.occurredAt })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          inArray(journalEntries.flow, ['founder_funding', 'opening_balance']),
        ),
      )
      .orderBy(journalEntries.occurredAt)
      .limit(1);
    const opened = notBefore ?? first?.at;
    const balances = await this.balancesAt(companyId, asOf);
    let treasury = 0n;
    for (const [code, v] of balances) if (isTreasuryAccount(code)) treasury += v;
    return {
      asOf: b.asOf,
      ledgerTreasuryMinor: treasury,
      paypalAvailableMinor: b.availableMinor,
      ledgerWithheldMinor: balances.get(ACC.withheld) ?? 0n,
      paypalWithheldMinor: b.withheldMinor,
      // PayPal's balance snapshot predates the company's books: nothing comparable yet.
      checked: Boolean(opened && asOf >= opened),
    };
  }

  private async balancesAt(companyId: string, at: Date): Promise<Map<string, bigint>> {
    const res = await this.db.execute<{ code: string; total: string }>(sql`
      SELECT a.code, sum(p.amount_minor) AS total
      FROM postings p JOIN accounts a ON a.id = p.account_id JOIN journal_entries j ON j.id = p.entry_id
      WHERE a.company_id = ${companyId} AND j.occurred_at <= ${at}
      GROUP BY a.code`);
    return new Map(res.rows.map((r) => [r.code, BigInt(r.total)]));
  }
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
function fmt(m: bigint): string {
  const s = abs(m).toString().padStart(3, '0');
  return `${m < 0n ? '-' : ''}$${s.slice(0, -2)}.${s.slice(-2)}`;
}
