/** Shape of GET /api/boardroom (apps/api/src/routes.ts). Display amounts are dollars (number); money logic stays server-side. */
export interface BoardroomData {
  asOf: string;
  companyId: string;
  overview: {
    cash: number;
    unallocated: number;
    withheld: number;
    revenue: number;
    aiCost: number;
    approvalsWaiting: number;
    openAlerts: number;
    runwayWeeks: number | null;
  }[];
  ledger: {
    entryId: string;
    date: string;
    flow: string;
    description: string;
    account: string;
    accountType: string;
    department: string;
    amount: number;
    debit: number;
    credit: number;
    agentId: string;
    runId: string;
    paypalRef: string;
    status: string;
  }[];
  envelopes: {
    department: string;
    balance: number;
    held: number;
    available: number;
    allocated: number;
    spent: number;
  }[];
  departments: {
    department: string;
    revenue: number;
    internalRevenue: number;
    refunds: number;
    contractors: number;
    internalSpend: number;
    aiCost: number;
    fees: number;
    net: number;
  }[];
  agents: {
    agentId: string;
    title: string;
    department: string;
    status: string;
    modelTier: string;
    runs: number;
    aiCost: number;
    intents: number;
    approved: number;
    held: number;
    denied: number;
  }[];
  agentRuns: {
    runId: string;
    agentId: string;
    department: string;
    status: string;
    trigger: string;
    startedAt: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    toolCalls: number;
    summary: string;
  }[];
  intents: {
    intentId: string;
    agentId: string;
    runId: string;
    envelope: string;
    action: string;
    amount: number;
    payee: string;
    decision: string;
    rule: string;
    explanation: string;
    status: string;
    reason: string;
    createdAt: string;
  }[];
  approvals: {
    approvalId: string;
    intentId: string;
    status: string;
    action: string;
    amount: number;
    envelope: string;
    payee: string;
    agentId: string;
    reason: string;
    evidence: string;
    rule: string;
    explanation: string;
    note: string;
    createdAt: string;
  }[];
  reconciliation: {
    runId: string;
    at: string;
    status: string;
    matched: number;
    pending: number;
    missingInLedger: number;
    missingInPaypal: number;
    amountMismatches: number;
    suspense: number;
  }[];
  alerts: { alertId: string; kind: string; severity: string; message: string; at: string }[];
}

export const PAGES = [
  { id: 'overview', title: 'Overview' },
  { id: 'departments', title: 'Departments' },
  { id: 'approvals', title: 'Approvals' },
  { id: 'ledger', title: 'Ledger' },
  { id: 'agents', title: 'Agents' },
  { id: 'reconciliation', title: 'Reconciliation' },
] as const;
export type PageId = (typeof PAGES)[number]['id'];
