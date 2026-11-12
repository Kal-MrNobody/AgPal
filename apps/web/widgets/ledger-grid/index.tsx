'use client';

import { useMemo, useRef, useSyncExternalStore } from 'react';
import {
  AllEnterpriseModule,
  ModuleRegistry,
  type ColDef,
  type ICellRendererParams,
} from 'ag-grid-enterprise';
import { AgGridReact } from 'ag-grid-react';
import { AgNoDataOverlay } from 'ag-studio-react';
import type { BoardroomData } from '../../lib/types';
import { boardroomStore } from '../store';

ModuleRegistry.registerModules([AllEnterpriseModule]);

type Row = BoardroomData['ledger'][number];

const FLOW_TONE: Record<string, string> = {
  capture: 'pill-in',
  refund: 'pill-out',
  payout_sent: 'pill-out',
  payout_accrual: 'pill-neutral',
  allocation: 'pill-neutral',
  ai_usage: 'pill-ai',
  internal_invoice_settle: 'pill-neutral',
  dispute_opened: 'pill-warn',
  dispute_won: 'pill-in',
  dispute_lost: 'pill-out',
};

function toneFor(field: string | undefined, value: string): string {
  if (field === 'status') return value === 'reversal' ? 'pill-warn' : 'pill-ok';
  if (value.startsWith('reversal')) return 'pill-warn';
  return FLOW_TONE[value] ?? 'pill-neutral';
}

function Pill(p: ICellRendererParams<Row, string>) {
  const value = p.value ?? '';
  if (!value) return null;
  return (
    <span className={`pill ${toneFor(p.colDef?.field, value)}`}>{value.split('_').join(' ')}</span>
  );
}

const money = (v: unknown) => (typeof v === 'number' && v !== 0 ? `$${v.toFixed(2)}` : '');

/** Ledger grid: AG Grid Enterprise inside a Studio widget — status pills, pinned debit/credit totals, CSV export. */
export default function LedgerGrid() {
  const data = useSyncExternalStore(
    boardroomStore.subscribe,
    boardroomStore.get,
    boardroomStore.get,
  );
  const grid = useRef<AgGridReact<Row>>(null);
  const rows = useMemo(() => data?.ledger ?? [], [data]);
  const totals = useMemo(
    () => [
      {
        description: 'Total (debits = credits)',
        debit: rows.reduce((s, r) => s + r.debit, 0),
        credit: rows.reduce((s, r) => s + r.credit, 0),
      } as Row,
    ],
    [rows],
  );
  const cols = useMemo<ColDef<Row>[]>(
    () => [
      {
        field: 'date',
        headerName: 'Date',
        width: 170,
        valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleString() : ''),
      },
      { field: 'flow', headerName: 'Flow', cellRenderer: Pill, width: 160, filter: true },
      { field: 'description', headerName: 'Description', flex: 2, minWidth: 220 },
      { field: 'account', headerName: 'Account', flex: 1, minWidth: 180, filter: true },
      { field: 'department', headerName: 'Dept', width: 100, filter: true },
      {
        field: 'debit',
        headerName: 'Debit',
        width: 110,
        type: 'rightAligned',
        valueFormatter: (p) => money(p.value),
      },
      {
        field: 'credit',
        headerName: 'Credit',
        width: 110,
        type: 'rightAligned',
        valueFormatter: (p) => money(p.value),
      },
      { field: 'agentId', headerName: 'Agent', width: 150 },
      { field: 'paypalRef', headerName: 'PayPal ref', width: 170 },
      { field: 'status', headerName: 'Status', cellRenderer: Pill, width: 110 },
    ],
    [],
  );
  if (rows.length === 0) return <AgNoDataOverlay />;
  return (
    <div className="ledger-grid">
      <div className="row">
        <span className="muted">{rows.length} postings</span>
        <button
          type="button"
          className="btn"
          onClick={() => grid.current?.api.exportDataAsCsv({ fileName: 'agpal-ledger.csv' })}
        >
          Export CSV
        </button>
      </div>
      <div className="grid-host">
        <AgGridReact<Row>
          ref={grid}
          rowData={rows}
          columnDefs={cols}
          pinnedBottomRowData={totals}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </div>
    </div>
  );
}
