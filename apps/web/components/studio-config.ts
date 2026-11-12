import type {
  AgDataSourcesDefinition,
  AgFieldDefinition,
  AgFormat,
  AgPageState,
  AgReportState,
  AgWidgetLayoutState,
} from 'ag-studio';
import type { BoardroomData, PageId } from '../lib/types';
import type { BoardroomRegistry } from '../widgets/registry';

/** Primary keys per table, so live updates can be applied as transactions (AG Studio 3.1 live data). */
export const TABLE_KEYS = {
  overview: 'id',
  ledger: 'rowId',
  envelopes: 'department',
  departments: 'department',
  agents: 'agentId',
  agentRuns: 'runId',
  intents: 'intentId',
  approvals: 'approvalId',
  reconciliation: 'runId',
  alerts: 'alertId',
} as const;
export type TableId = keyof typeof TABLE_KEYS;

type Spec = [id: string, name: string, format: AgFormat, hide?: boolean];
const f = (specs: Spec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({ id, name, format, ...(hide ? { hide } : {}) }));

/** Rows per table, keyed for transactions. */
export function rowsFor(d: BoardroomData): Record<TableId, Record<string, unknown>[]> {
  return {
    overview: d.overview.map((o) => ({ id: 'now', ...o, runwayWeeks: o.runwayWeeks ?? 0 })),
    ledger: d.ledger.map((l, i) => ({ rowId: `${l.entryId}:${l.account}:${i}`, ...l })),
    envelopes: d.envelopes,
    departments: d.departments,
    agents: d.agents,
    agentRuns: d.agentRuns,
    intents: d.intents,
    approvals: d.approvals,
    reconciliation: d.reconciliation,
    alerts: d.alerts,
  };
}

export function buildSources(d: BoardroomData): AgDataSourcesDefinition {
  const rows = rowsFor(d);
  const table = (id: TableId, description: string, fields: AgFieldDefinition[]) => ({
    id,
    description,
    data: rows[id],
    fields,
    transactions: 'all' as const,
    primaryKeyField: TABLE_KEYS[id],
  });
  return {
    description:
      'AgPal: an AI-agent-run digital goods company. Money amounts are USD. Departments: revenue, finance, support, growth. ' +
      'Ledger rows are postings of a double-entry ledger: positive = debit, negative = credit.',
    sources: [
      table(
        'overview',
        'Company snapshot',
        f([
          ['id', 'Id', 'textFormat', true],
          ['cash', 'Cash (treasury)', 'currencyFormat'],
          ['unallocated', 'Unallocated', 'currencyFormat'],
          ['withheld', 'Withheld (disputes)', 'currencyFormat'],
          ['revenue', 'Revenue', 'currencyFormat'],
          ['aiCost', 'AI cost', 'currencyFormat'],
          ['approvalsWaiting', 'Approvals waiting', 'integerFormat'],
          ['openAlerts', 'Open alerts', 'integerFormat'],
          ['runwayWeeks', 'Runway (weeks)', 'decimalFormat'],
        ]),
      ),
      table(
        'ledger',
        'Ledger postings',
        f([
          ['rowId', 'Row', 'textFormat', true],
          ['entryId', 'Entry', 'textFormat'],
          ['date', 'Date', 'dateTimeFormat'],
          ['flow', 'Flow', 'textFormat'],
          ['description', 'Description', 'textFormat'],
          ['account', 'Account', 'textFormat'],
          ['accountType', 'Account type', 'textFormat'],
          ['department', 'Department', 'textFormat'],
          ['amount', 'Amount', 'currencyFormat'],
          ['debit', 'Debit', 'currencyFormat'],
          ['credit', 'Credit', 'currencyFormat'],
          ['agentId', 'Agent', 'textFormat'],
          ['runId', 'Run', 'textFormat'],
          ['paypalRef', 'PayPal ref', 'textFormat'],
          ['status', 'Status', 'textFormat'],
        ]),
      ),
      table(
        'envelopes',
        'Department budget envelopes',
        f([
          ['department', 'Department', 'textFormat'],
          ['allocated', 'Allocated', 'currencyFormat'],
          ['spent', 'Spent', 'currencyFormat'],
          ['held', 'Held', 'currencyFormat'],
          ['available', 'Available', 'currencyFormat'],
          ['balance', 'Balance', 'currencyFormat'],
        ]),
      ),
      table(
        'departments',
        'P&L per department (income positive, costs negative)',
        f([
          ['department', 'Department', 'textFormat'],
          ['revenue', 'Revenue', 'currencyFormat'],
          ['internalRevenue', 'Internal revenue', 'currencyFormat'],
          ['refunds', 'Refunds', 'currencyFormat'],
          ['contractors', 'Contractors', 'currencyFormat'],
          ['internalSpend', 'Internal spend', 'currencyFormat'],
          ['aiCost', 'AI cost', 'currencyFormat'],
          ['fees', 'PayPal fees', 'currencyFormat'],
          ['net', 'Net', 'currencyFormat'],
        ]),
      ),
      table(
        'agents',
        'AI employees',
        f([
          ['agentId', 'Agent', 'textFormat'],
          ['title', 'Title', 'textFormat'],
          ['department', 'Department', 'textFormat'],
          ['status', 'Status', 'textFormat'],
          ['modelTier', 'Model tier', 'textFormat'],
          ['runs', 'Runs', 'integerFormat'],
          ['aiCost', 'AI cost', 'currencyFormat'],
          ['intents', 'Spend requests', 'integerFormat'],
          ['approved', 'Approved', 'integerFormat'],
          ['held', 'Held', 'integerFormat'],
          ['denied', 'Denied', 'integerFormat'],
        ]),
      ),
      table(
        'agentRuns',
        'Agent runs',
        f([
          ['runId', 'Run', 'textFormat'],
          ['agentId', 'Agent', 'textFormat'],
          ['department', 'Department', 'textFormat'],
          ['status', 'Status', 'textFormat'],
          ['trigger', 'Trigger', 'textFormat'],
          ['startedAt', 'Started', 'dateTimeFormat'],
          ['inputTokens', 'Input tokens', 'integerFormat'],
          ['outputTokens', 'Output tokens', 'integerFormat'],
          ['cost', 'Cost', 'currencyFormat'],
          ['toolCalls', 'Tool calls', 'integerFormat'],
          ['summary', 'Summary', 'textFormat'],
        ]),
      ),
      table(
        'intents',
        'Spend requests through the policy gate',
        f([
          ['intentId', 'Intent', 'textFormat'],
          ['agentId', 'Agent', 'textFormat'],
          ['runId', 'Run', 'textFormat'],
          ['envelope', 'Envelope', 'textFormat'],
          ['action', 'Action', 'textFormat'],
          ['amount', 'Amount', 'currencyFormat'],
          ['payee', 'Payee', 'textFormat'],
          ['decision', 'Decision', 'textFormat'],
          ['rule', 'Rule', 'textFormat'],
          ['explanation', 'Explanation', 'textFormat'],
          ['status', 'Status', 'textFormat'],
          ['reason', 'Reason', 'textFormat'],
          ['createdAt', 'Created', 'dateTimeFormat'],
        ]),
      ),
      table(
        'approvals',
        'Founder approvals',
        f([
          ['approvalId', 'Approval', 'textFormat'],
          ['intentId', 'Intent', 'textFormat', true],
          ['status', 'Status', 'textFormat'],
          ['action', 'Action', 'textFormat'],
          ['amount', 'Amount', 'currencyFormat'],
          ['envelope', 'Envelope', 'textFormat'],
          ['payee', 'Payee', 'textFormat'],
          ['agentId', 'Agent', 'textFormat'],
          ['reason', 'Reason', 'textFormat'],
          ['evidence', 'Evidence', 'textFormat'],
          ['rule', 'Rule', 'textFormat'],
          ['explanation', 'Explanation', 'textFormat'],
          ['note', 'Founder note', 'textFormat'],
          ['createdAt', 'Created', 'dateTimeFormat'],
        ]),
      ),
      table(
        'reconciliation',
        'Reconciliation runs (PayPal vs ledger, zero tolerance)',
        f([
          ['runId', 'Run', 'textFormat'],
          ['at', 'At', 'dateTimeFormat'],
          ['status', 'Status', 'textFormat'],
          ['matched', 'Matched', 'integerFormat'],
          ['pending', 'Pending', 'integerFormat'],
          ['missingInLedger', 'Missing in ledger', 'integerFormat'],
          ['missingInPaypal', 'Missing in PayPal', 'integerFormat'],
          ['amountMismatches', 'Amount mismatches', 'integerFormat'],
          ['suspense', 'Suspense', 'integerFormat'],
        ]),
      ),
      table(
        'alerts',
        'Open alerts',
        f([
          ['alertId', 'Alert', 'textFormat', true],
          ['kind', 'Kind', 'textFormat'],
          ['severity', 'Severity', 'textFormat'],
          ['message', 'Message', 'textFormat'],
          ['at', 'At', 'dateTimeFormat'],
        ]),
      ),
    ],
  };
}

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({
  xTrack,
  yTrack,
  xSpan,
  ySpan,
});
const title = (text: string) => ({ title: { enabled: true, text } });
const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const kpi = (text: string, field: string) => ({
  type: 'value' as const,
  dataMapping: { value: [sum(field)] },
  format: title(text),
});
const grid = (text: string, cols: string[]) => ({
  type: 'grid' as const,
  dataMapping: { cols: cols.map((id) => ({ id })) },
  format: title(text),
});

const pages: Record<PageId, AgPageState<BoardroomRegistry>> = {
  overview: {
    id: 'overview',
    widgets: {
      cash: kpi('Cash', 'overview.cash'),
      revenue: kpi('Revenue', 'overview.revenue'),
      ai: kpi('AI cost', 'overview.aiCost'),
      approvals: kpi('Approvals waiting', 'overview.approvalsWaiting'),
      alerts: kpi('Open alerts', 'overview.openAlerts'),
      runway: kpi('Runway (weeks)', 'overview.runwayWeeks'),
      revVsAi: {
        type: 'column-chart-grouped',
        dataMapping: {
          categoryKey: [{ id: 'departments.department' }],
          valueKey: [sum('departments.revenue'), sum('departments.aiCost'), sum('departments.net')],
        },
        format: title('Revenue vs AI cost and net, by department'),
      },
      alertsGrid: grid('Alerts', ['alerts.kind', 'alerts.severity', 'alerts.message', 'alerts.at']),
    },
    widgetLayout: {
      cash: at(0, 0, 4, 6),
      revenue: at(4, 0, 4, 6),
      ai: at(8, 0, 4, 6),
      approvals: at(12, 0, 4, 6),
      alerts: at(16, 0, 4, 6),
      runway: at(20, 0, 4, 6),
      revVsAi: at(0, 6, 14, 14),
      alertsGrid: at(14, 6, 10, 14),
    },
  },
  departments: {
    id: 'departments',
    widgets: {
      pnl: grid('P&L per department', [
        'departments.department',
        'departments.revenue',
        'departments.internalRevenue',
        'departments.refunds',
        'departments.contractors',
        'departments.internalSpend',
        'departments.aiCost',
        'departments.fees',
        'departments.net',
      ]),
      burn: {
        type: 'bar-chart-stacked',
        dataMapping: {
          categoryKey: [{ id: 'envelopes.department' }],
          valueKey: [sum('envelopes.spent'), sum('envelopes.held'), sum('envelopes.available')],
        },
        format: title('Envelope burn: spent, held, available'),
      },
      gauge: {
        type: 'envelopeGauge',
        dataMapping: {
          department: [{ id: 'envelopes.department' }],
          spent: [sum('envelopes.spent')],
          held: [sum('envelopes.held')],
          available: [sum('envelopes.available')],
        },
        format: title('Envelope gauge'),
      },
    },
    widgetLayout: { pnl: at(0, 0, 24, 12), burn: at(0, 12, 12, 16), gauge: at(12, 12, 12, 16) },
  },
  approvals: {
    id: 'approvals',
    widgets: {
      cards: { type: 'approvalCard', dataMapping: {}, format: title('Waiting for you') },
      byStatus: {
        type: 'donut-chart',
        dataMapping: {
          categoryKey: [{ id: 'approvals.status' }],
          valueKey: [{ id: 'approvals.approvalId', aggregation: 'count' as const }],
        },
        format: title('Approvals by status'),
      },
      decisions: {
        type: 'column-chart-stacked',
        dataMapping: {
          categoryKey: [{ id: 'intents.envelope' }, { id: 'intents.decision' }],
          valueKey: [{ id: 'intents.intentId', aggregation: 'count' as const }],
        },
        format: title('Gate decisions by envelope'),
      },
      all: grid('All approvals', [
        'approvals.createdAt',
        'approvals.status',
        'approvals.action',
        'approvals.amount',
        'approvals.envelope',
        'approvals.payee',
        'approvals.rule',
        'approvals.reason',
        'approvals.note',
      ]),
    },
    widgetLayout: {
      cards: at(0, 0, 24, 14),
      byStatus: at(0, 14, 8, 12),
      decisions: at(8, 14, 16, 12),
      all: at(0, 26, 24, 12),
    },
  },
  ledger: {
    id: 'ledger',
    widgets: {
      flows: {
        type: 'list-filter',
        dataMapping: { value: [{ id: 'ledger.flow' }] },
        format: title('Flow'),
      },
      dept: {
        type: 'list-filter',
        dataMapping: { value: [{ id: 'ledger.department' }] },
        format: title('Department'),
      },
      entries: { type: 'ledgerGrid', dataMapping: {}, format: title('Ledger postings') },
      byFlow: {
        type: 'column-chart-grouped',
        dataMapping: { categoryKey: [{ id: 'ledger.flow' }], valueKey: [sum('ledger.debit')] },
        format: title('Debits by flow'),
      },
    },
    widgetLayout: {
      flows: at(0, 0, 12, 7),
      dept: at(12, 0, 12, 7),
      byFlow: at(0, 7, 24, 10),
      entries: at(0, 17, 24, 26),
    },
  },
  agents: {
    id: 'agents',
    widgets: {
      scorecards: { type: 'agentScorecard', dataMapping: {}, format: title('Agent scorecards') },
      staff: grid('AI employees', [
        'agents.title',
        'agents.department',
        'agents.status',
        'agents.modelTier',
        'agents.runs',
        'agents.aiCost',
        'agents.approved',
        'agents.held',
        'agents.denied',
      ]),
      cost: {
        type: 'bar-chart-grouped',
        dataMapping: {
          categoryKey: [{ id: 'agentRuns.agentId' }],
          valueKey: [sum('agentRuns.cost')],
        },
        format: title('AI cost by agent'),
      },
      runs: grid('Runs', [
        'agentRuns.startedAt',
        'agentRuns.agentId',
        'agentRuns.status',
        'agentRuns.toolCalls',
        'agentRuns.cost',
        'agentRuns.summary',
      ]),
    },
    widgetLayout: {
      scorecards: at(0, 0, 24, 14),
      staff: at(0, 14, 14, 11),
      cost: at(14, 14, 10, 11),
      runs: at(0, 25, 24, 16),
    },
  },
  reconciliation: {
    id: 'reconciliation',
    widgets: {
      matched: kpi('Matched (all runs)', 'reconciliation.matched'),
      mismatches: kpi('Amount mismatches', 'reconciliation.amountMismatches'),
      missing: kpi('Missing in ledger', 'reconciliation.missingInLedger'),
      runs: grid('Reconciliation runs', [
        'reconciliation.at',
        'reconciliation.status',
        'reconciliation.matched',
        'reconciliation.pending',
        'reconciliation.missingInLedger',
        'reconciliation.missingInPaypal',
        'reconciliation.amountMismatches',
        'reconciliation.suspense',
      ]),
    },
    widgetLayout: {
      matched: at(0, 0, 8, 6),
      mismatches: at(8, 0, 8, 6),
      missing: at(16, 0, 8, 6),
      runs: at(0, 6, 24, 16),
    },
  },
};

export const initialReport = (page: PageId): AgReportState<BoardroomRegistry> => ({
  selectedPageId: page,
  pages: Object.values(pages),
});
