import type {
  AgBaseRegistry,
  AgBaseWidgetDefinition,
  AgCoreDefaultRegistry,
  AgWidgetDataFormat,
  AgWidgetFieldReference,
} from 'ag-studio';

export interface EnvelopeGaugeDef {
  type: 'envelopeGauge';
  dataMapping: {
    department: AgWidgetFieldReference[];
    spent: AgWidgetFieldReference[];
    held: AgWidgetFieldReference[];
    available: AgWidgetFieldReference[];
  };
  format?: AgWidgetDataFormat<object>;
}
export interface ApprovalCardDef {
  type: 'approvalCard';
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<object>;
}
export interface LedgerGridDef {
  type: 'ledgerGrid';
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<object>;
}
export interface AlertCardDef {
  type: 'alertCard';
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<object>;
}
export interface MoneyFlowDef {
  type: 'moneyFlow';
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<object>;
}
export interface AgentScorecardDef {
  type: 'agentScorecard';
  dataMapping: Record<string, never>;
  format?: AgWidgetDataFormat<object>;
}

/** Studio's built-in widgets plus the boardroom's custom ones. */
export interface BoardroomRegistry extends AgBaseRegistry {
  widgets: readonly (
    | AgCoreDefaultRegistry['widgets'][number]
    | AgBaseWidgetDefinition<'envelopeGauge', EnvelopeGaugeDef>
    | AgBaseWidgetDefinition<'approvalCard', ApprovalCardDef>
    | AgBaseWidgetDefinition<'agentScorecard', AgentScorecardDef>
    | AgBaseWidgetDefinition<'ledgerGrid', LedgerGridDef>
    | AgBaseWidgetDefinition<'moneyFlow', MoneyFlowDef>
    | AgBaseWidgetDefinition<'alertCard', AlertCardDef>
  )[];
}

/** Passed to widgets through Studio's `context`: server actions only, no keys. */
export interface BoardroomContext {
  decide: (
    approvalId: string,
    decision: 'approve' | 'reject',
    note: string,
  ) => Promise<{ status: string; explanation?: string }>;
  resolveAlert: (alertId: string, note: string) => Promise<{ status: string }>;
}
