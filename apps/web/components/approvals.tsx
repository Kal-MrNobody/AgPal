'use client';

import { useState, useTransition } from 'react';
import { batchApprove, decideApproval } from '../app/actions';
import type { BoardroomData } from '../lib/types';

type Item = BoardroomData['approvals'][number];

/** Approval cards: the intent, the rule that fired, the agent's reason and evidence; approve or deny with a note. */
export function Approvals({ items }: { items: Item[] }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (items.length === 0) return <p className="muted">No approvals waiting.</p>;
  return (
    <>
      {items.filter((a) => a.amount <= 25 && !a.intentId.startsWith('prop_')).length > 1 && (
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await batchApprove(25);
                setDone((d) => ({
                  ...d,
                  ...Object.fromEntries(
                    r.approved.map((x) => [x.approvalId, `${x.status} (batch)`]),
                  ),
                }));
              })
            }
          >
            Batch-approve small items (up to $25)
          </button>
        </div>
      )}
      <div className="cards">
        {items.map((a) => (
          <article key={a.approvalId} className="card">
            <div className="card-head">
              <strong>{a.action.replace('_', ' ')}</strong>
              <span className="amount">${a.amount.toFixed(2)}</span>
            </div>
            <div className="muted">
              {a.envelope}
              {a.payee ? ` → ${a.payee}` : ''} · {a.agentId}
            </div>
            <p className="rule">
              <code>{a.rule}</code> {a.explanation}
            </p>
            <p>{a.reason}</p>
            {a.evidence && <p className="muted">Evidence: {a.evidence}</p>}
            {done[a.approvalId] ? (
              <p className="done">{done[a.approvalId]}</p>
            ) : (
              <div className="actions">
                <input
                  placeholder="Note (optional)"
                  value={notes[a.approvalId] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [a.approvalId]: e.target.value })}
                />
                {(['approve', 'reject'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={d === 'approve' ? 'btn primary' : 'btn'}
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await decideApproval(a.approvalId, d, notes[a.approvalId] ?? '');
                        setDone({
                          ...done,
                          [a.approvalId]: `${r.status}${r.explanation ? `: ${r.explanation}` : ''}`,
                        });
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
    </>
  );
}
