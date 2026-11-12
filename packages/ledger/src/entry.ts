import type { Attribution, Currency } from '@agpal/shared';

/**
 * Invariant 3: the ledger is double-entry and append-only. A journal entry's postings
 * sum to zero per currency; corrections are reversing entries, never edits.
 *
 * Sign convention: positive = debit, negative = credit. Full account model arrives with
 * docs/money-constitution.md (Prompt 2) and the schema in Prompt 3.
 */
export interface Posting {
  accountId: string;
  amountMinor: bigint;
  currency: Currency;
}

export interface JournalEntryDraft {
  companyId: string;
  description: string;
  postings: readonly Posting[];
  attribution?: Attribution;
  /** For reversals: the entry being reversed. */
  reverses?: string;
}

export class LedgerError extends Error {
  override name = 'LedgerError';
}

export class UnbalancedEntryError extends LedgerError {
  override name = 'UnbalancedEntryError';
}

export function assertBalanced(entry: Pick<JournalEntryDraft, 'postings'>): void {
  if (entry.postings.length < 2)
    throw new UnbalancedEntryError('An entry needs at least two postings');
  const totals = new Map<Currency, bigint>();
  for (const p of entry.postings) {
    if (typeof p.amountMinor !== 'bigint')
      throw new UnbalancedEntryError('Posting amount must be bigint minor units');
    if (p.amountMinor === 0n)
      throw new UnbalancedEntryError('Zero-amount postings are not allowed');
    totals.set(p.currency, (totals.get(p.currency) ?? 0n) + p.amountMinor);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n)
      throw new UnbalancedEntryError(`Entry does not balance in ${currency}: off by ${total}`);
  }
}

/** Build the reversing entry for a posted one. The original is never modified. */
export function reversalOf(
  entryId: string,
  original: JournalEntryDraft,
  reason: string,
): JournalEntryDraft {
  return {
    companyId: original.companyId,
    description: `Reversal of ${entryId}: ${reason}`,
    postings: original.postings.map((p) => ({ ...p, amountMinor: -p.amountMinor })),
    reverses: entryId,
    ...(original.attribution ? { attribution: original.attribution } : {}),
  };
}
