'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { AgNoDataOverlay } from 'ag-studio-react';
import type { AlertCardDef, BoardroomContext } from '../registry';
import { boardroomStore } from '../store';

/**
 * Alert cards: every open alert. A suspense alert means PayPal reported money AgPal cannot attribute; it is never
 * booked automatically. The founder can resolve one with a written reason (server-side, audited, moves no money).
 */
export default function AlertCard(params: AgWidgetParams<AlertCardDef>) {
  const context = params.context as BoardroomContext;
  const data = useSyncExternalStore(
    boardroomStore.subscribe,
    boardroomStore.get,
    boardroomStore.get,
  );
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const rows = data?.alerts ?? [];
  if (rows.length === 0 && Object.keys(done).length === 0) return <AgNoDataOverlay />;
  return (
    <div className="wcards">
      {rows.map((a) => {
        const note = notes[a.alertId] ?? '';
        return (
          <article key={a.alertId} className={`wcard alert ${a.severity}`}>
            <header>
              <strong>{a.kind}</strong>
              <span className="pill">{a.severity}</span>
            </header>
            <p>{a.message}</p>
            <div className="muted">{new Date(a.at).toLocaleString()}</div>
            <div className="row">
              <input
                aria-label="Reason for resolving"
                placeholder="Reason (required, kept in the audit log)"
                value={note}
                onChange={(e) => {
                  setNotes((x) => ({ ...x, [a.alertId]: e.target.value }));
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={pending || note.trim().length < 5}
                onClick={() => {
                  start(async () => {
                    const r = await context.resolveAlert(a.alertId, note);
                    setDone((x) => ({ ...x, [a.alertId]: `${a.kind}: ${r.status}` }));
                  });
                }}
              >
                Resolve
              </button>
            </div>
          </article>
        );
      })}
      {Object.entries(done).map(([id, text]) => (
        <p key={id} className="done">
          {text}
        </p>
      ))}
    </div>
  );
}
