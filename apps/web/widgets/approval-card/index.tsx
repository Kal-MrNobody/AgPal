'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { AgNoDataOverlay } from 'ag-studio-react';
import type { ApprovalCardDef, BoardroomContext } from '../registry';
import { boardroomStore } from '../store';

/**
 * Approval card: each pending founder approval with the intent, the rule that fired and the agent's reason. Approve
 * and deny call the boardroom's server action (passed in Studio's `context`); the gate re-checks on the server.
 */
export default function ApprovalCard({
  context,
}: AgWidgetParams<ApprovalCardDef, BoardroomContext>) {
  const data = useSyncExternalStore(
    boardroomStore.subscribe,
    boardroomStore.get,
    boardroomStore.get,
  );
  const [pending, start] = useTransition();
  const [done, setDone] = useState<Record<string, string>>({});
  const rows = (data?.approvals ?? []).filter((a) => a.status === 'pending' || done[a.approvalId]);
  if (rows.length === 0) return <AgNoDataOverlay />;
  return (
    <div className="wcards">
      {rows.map((a) => (
        <article key={a.approvalId} className="wcard">
          <header>
            <strong>{a.action.replace('_', ' ')}</strong>
            <span>${a.amount.toFixed(2)}</span>
          </header>
          <div className="muted">
            {a.envelope} → {a.payee || '—'} · {a.agentId}
          </div>
          <p>
            <code>{a.rule}</code> {a.explanation}
          </p>
          <p className="reason">{a.reason}</p>
          {a.evidence && <p className="muted">Evidence: {a.evidence}</p>}
          {done[a.approvalId] ? (
            <p className="done">{done[a.approvalId]}</p>
          ) : (
            <div className="row">
              {(['approve', 'reject'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={d === 'approve' ? 'btn primary' : 'btn'}
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await context.decide(a.approvalId, d, '');
                      setDone((x) => ({
                        ...x,
                        [a.approvalId]: `${res.status}${res.explanation ? `: ${res.explanation}` : ''}`,
                      }));
                    })
                  }
                >
                  {d === 'approve' ? 'Approve' : 'Deny'}
                </button>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
