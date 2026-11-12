'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  enableStudioDevValidations,
  type AgDataSourcesDefinition,
  type AgDataTransaction,
  type AgStudioApi,
  type AgStudioMode,
} from 'ag-studio';
import { AgStudio } from 'ag-studio-react';
import { decideApproval, refreshData } from '../app/actions';
import { boardroomWidgets } from '../widgets';
import type { BoardroomContext, BoardroomRegistry } from '../widgets/registry';
import { boardroomStore } from '../widgets/store';
import { boardroomTheme } from './theme';
import type { BoardroomData, PageId } from '../lib/types';
import { buildSources, initialReport, rowsFor, TABLE_KEYS, type TableId } from './studio-config';

if (process.env.NODE_ENV !== 'production') enableStudioDevValidations();

/**
 * The boardroom: one AG Studio instance (AG Grid + AG Charts Enterprise, no licence key — watermark expected).
 * Data comes from apps/api through server actions. Live updates are applied as AG Studio transactions (3.1 live data)
 * instead of remounting the component.
 */
export function Boardroom({ data, page }: { data: BoardroomData; page: PageId }) {
  const apiRef = useRef<AgStudioApi | null>(null);
  const lastRows = useRef(rowsFor(data));
  const [mode, setMode] = useState<AgStudioMode>('view');
  const [ready, setReady] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(data.asOf);
  // Studio reads `data` and `initialState` once; later changes go through transactions and setState.
  // Built against the default registry; the boardroom registry adds the custom widget types.
  const sources = useMemo(
    () => buildSources(data) as unknown as AgDataSourcesDefinition<BoardroomRegistry>,
    [],
  );
  const initialState = useMemo(() => initialReport(page), []);
  const widgets = useMemo(() => boardroomWidgets(), []);
  const context = useMemo<BoardroomContext>(
    () => ({
      decide: async (id, decision, note) => {
        const r = await decideApproval(id, decision, note);
        boardroomStore.set(await refreshData());
        return r;
      },
    }),
    [],
  );
  if (!boardroomStore.get()) boardroomStore.set(data);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !ready) return;
    api.setState({ ...api.getState(), selectedPageId: page });
  }, [page, ready]);

  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      void refreshData().then(async (fresh) => {
        const engine = apiRef.current?.getDataEngine();
        if (!engine?.applyTransaction) return;
        const next = rowsFor(fresh);
        const txs = (Object.keys(TABLE_KEYS) as TableId[]).map((tableId) =>
          diff(tableId, lastRows.current[tableId], next[tableId]),
        );
        await engine.applyTransaction(
          txs.filter(
            (t) => t.add.length || t.update.length || t.remove.length,
          ) as unknown as AgDataTransaction[],
        );
        lastRows.current = next;
        boardroomStore.set(fresh);
        setUpdatedAt(fresh.asOf);
      });
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
  }, [ready]);

  return (
    <div className="studio-wrap">
      <div className="studio-toolbar">
        <span className="muted">Live · updated {new Date(updatedAt).toLocaleTimeString()}</span>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const next = mode === 'view' ? 'edit' : 'view';
            setMode(next);
          }}
        >
          {mode === 'view' ? 'Edit dashboard' : 'Done editing'}
        </button>
      </div>
      <div className="studio">
        {/* While Studio loads, render an empty sized container (never null). */}
        <AgStudio<BoardroomRegistry>
          style={{ height: '100%', width: '100%' }}
          theme={boardroomTheme}
          widgets={widgets}
          context={context}
          data={sources}
          initialState={initialState}
          mode={mode}
          onStudioReady={(e: { api: AgStudioApi }) => {
            apiRef.current = e.api;
            setReady(true);
          }}
        />
      </div>
    </div>
  );
}

function diff(
  tableId: TableId,
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
) {
  const key = TABLE_KEYS[tableId];
  const prev = new Map(before.map((r) => [String(r[key]), r]));
  const next = new Map(after.map((r) => [String(r[key]), r]));
  const add: Record<string, unknown>[] = [];
  const update: Record<string, unknown>[] = [];
  const remove: unknown[] = [];
  for (const [k, r] of next) {
    const p = prev.get(k);
    if (!p) add.push(r);
    else if (JSON.stringify(p) !== JSON.stringify(r)) update.push(r);
  }
  for (const [k, r] of prev) if (!next.has(k)) remove.push(r[key]);
  return { tableId, add, update, remove };
}
