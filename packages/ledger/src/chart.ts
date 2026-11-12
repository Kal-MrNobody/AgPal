/** Chart of accounts per docs/money-constitution.md §1. */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type BalanceRule = 'non_negative' | 'non_positive' | 'any';

export interface AccountSpec {
  code: string;
  type: AccountType;
  rule: BalanceRule;
  departmentCode?: string;
}

export const ACC = {
  unallocated: 'cash:unallocated',
  envelope: (dept: string) => `cash:envelope:${dept}`,
  aiReserve: 'cash:reserve:ai_compute',
  withheld: 'cash:withheld:disputes',
  suspense: 'cash:suspense',
  ownerEquity: 'equity:owner',
  sales: (dept: string) => `revenue:sales:${dept}`,
  subscriptions: (dept: string) => `revenue:subscriptions:${dept}`,
  refunds: (dept: string) => `revenue:refunds:${dept}`,
  internalRevenue: (dept: string) => `revenue:internal:${dept}`,
  paypalFees: 'expense:paypal_fees',
  aiCompute: (dept: string) => `expense:ai_compute:${dept}`,
  contractors: (dept: string) => `expense:contractors:${dept}`,
  internalExpense: (dept: string) => `expense:internal:${dept}`,
  payable: (payee: string) => `liability:payable:${payee}`,
} as const;

/** Accounts whose sum must equal PayPal's available balance. */
export const isTreasuryAccount = (code: string): boolean =>
  code.startsWith('cash:') && code !== ACC.withheld;

export const isEnvelopeAccount = (code: string): boolean => code.startsWith('cash:envelope:');

export function payableSpec(payee: string): AccountSpec {
  if (!/^[a-z0-9_.@+-]+$/i.test(payee)) throw new Error(`Invalid payee key: ${payee}`);
  return { code: ACC.payable(payee), type: 'liability', rule: 'non_positive' };
}

export function chartOfAccounts(departments: readonly string[]): AccountSpec[] {
  const specs: AccountSpec[] = [
    { code: ACC.unallocated, type: 'asset', rule: 'non_negative' },
    { code: ACC.aiReserve, type: 'asset', rule: 'non_negative' },
    { code: ACC.withheld, type: 'asset', rule: 'non_negative' },
    { code: ACC.suspense, type: 'asset', rule: 'any' },
    { code: ACC.ownerEquity, type: 'equity', rule: 'non_positive' },
    { code: ACC.paypalFees, type: 'expense', rule: 'any' },
    payableSpec('ai_provider'),
  ];
  for (const d of departments) {
    specs.push(
      { code: ACC.envelope(d), type: 'asset', rule: 'non_negative', departmentCode: d },
      { code: ACC.sales(d), type: 'revenue', rule: 'any', departmentCode: d },
      { code: ACC.subscriptions(d), type: 'revenue', rule: 'any', departmentCode: d },
      { code: ACC.refunds(d), type: 'revenue', rule: 'any', departmentCode: d },
      { code: ACC.internalRevenue(d), type: 'revenue', rule: 'any', departmentCode: d },
      { code: ACC.aiCompute(d), type: 'expense', rule: 'any', departmentCode: d },
      { code: ACC.contractors(d), type: 'expense', rule: 'any', departmentCode: d },
      { code: ACC.internalExpense(d), type: 'expense', rule: 'any', departmentCode: d },
    );
  }
  return specs;
}
