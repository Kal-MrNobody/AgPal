import { createWidgets } from 'ag-studio-react';
import AgentScorecard from './agent-scorecard';
import ApprovalCard from './approval-card';
import EnvelopeGauge from './envelope-gauge';
import LedgerGrid from './ledger-grid';
import AlertCard from './alert-card';
import MoneyFlow from './money-flow';
import type { BoardroomRegistry } from './registry';

/** Custom boardroom widgets, added to Studio's widget menu under "AgPal". */
export const boardroomWidgets = () =>
  createWidgets<BoardroomRegistry>({
    additionalTypes: [
      {
        id: 'moneyFlow',
        label: 'Money flow',
        form: (params) => params.createDefaults({ dataMappingItems: [] }),
        comp: MoneyFlow,
        defaultSize: { width: 1100, height: 460 },
        minSize: { width: 480, height: 280 },
        ai: {
          description:
            "Signature Sankey of the company's money from the ledger: customers and founder → treasury → department envelopes → payees, with PayPal fees, AI cost, refunds and internal invoices as their own flows.",
        },
      },
      {
        id: 'envelopeGauge',
        label: 'Envelope gauge',
        dataMapping: {
          department: {
            type: 'field',
            supportedRoles: ['category'],
            intent: 'category',
            required: true,
          },
          spent: { type: 'field', supportedRoles: ['numeric'], intent: 'value', required: true },
          held: { type: 'field', supportedRoles: ['numeric'], intent: 'value', required: true },
          available: {
            type: 'field',
            supportedRoles: ['numeric'],
            intent: 'value',
            required: true,
          },
        },
        form: (params) =>
          params.createDefaults({
            dataMappingItems: [
              { key: 'department', label: 'Department' },
              { key: 'spent', label: 'Spent' },
              { key: 'held', label: 'Held' },
              { key: 'available', label: 'Available' },
            ],
          }),
        comp: EnvelopeGauge,
        defaultSize: { width: 420, height: 320 },
        minSize: { width: 240, height: 160 },
        ai: {
          description:
            'Per-department budget envelope: spent, held (reserved for in-flight payments) and available.',
        },
      },
      {
        id: 'alertCard',
        label: 'Alert cards',
        form: (params) => params.createDefaults({ dataMappingItems: [] }),
        comp: AlertCard,
        defaultSize: { width: 520, height: 320 },
        minSize: { width: 280, height: 180 },
        ai: {
          description:
            'Open alerts (suspense, reconciliation, failed payouts). The founder can resolve one with a written, audited reason.',
        },
      },
      {
        id: 'approvalCard',
        label: 'Approval cards',
        form: (params) => params.createDefaults({ dataMappingItems: [] }),
        comp: ApprovalCard,
        defaultSize: { width: 520, height: 360 },
        minSize: { width: 280, height: 200 },
        ai: { description: 'Pending founder approvals with approve and deny buttons.' },
      },
      {
        id: 'agentScorecard',
        label: 'Agent scorecard',
        form: (params) => params.createDefaults({ dataMappingItems: [] }),
        comp: AgentScorecard,
        defaultSize: { width: 520, height: 360 },
        minSize: { width: 280, height: 200 },
        ai: {
          description:
            'Each AI employee: autonomy level, trust score, accepted work, reversals and policy record.',
        },
      },
      {
        id: 'ledgerGrid',
        label: 'Ledger grid',
        form: (params) => params.createDefaults({ dataMappingItems: [] }),
        comp: LedgerGrid,
        defaultSize: { width: 900, height: 480 },
        minSize: { width: 400, height: 240 },
        ai: {
          description:
            'Every ledger posting with flow and status pills, pinned debit/credit totals and CSV export.',
        },
      },
    ],
    menu: [
      {
        label: 'AgPal',
        widgetIds: [
          'moneyFlow',
          'alertCard',
          'envelopeGauge',
          'approvalCard',
          'agentScorecard',
          'ledgerGrid',
        ],
      },
    ],
  });
