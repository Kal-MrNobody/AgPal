'use client';

import { useSyncExternalStore } from 'react';
import { AgNoDataOverlay } from 'ag-studio-react';
import { boardroomStore } from '../store';

/** Agent scorecard: autonomy level, trust score and the record behind it (accepted work, reversals, policy breaches). */
export default function AgentScorecard() {
  const data = useSyncExternalStore(
    boardroomStore.subscribe,
    boardroomStore.get,
    boardroomStore.get,
  );
  const rows = data?.agents ?? [];
  if (rows.length === 0) return <AgNoDataOverlay />;
  return (
    <div className="wcards">
      {rows.map((a) => (
        <article key={a.agentId} className="wcard score">
          <header>
            <strong>{a.title}</strong>
            <span
              className="level"
              title={a.pinned ? 'Pinned by the founder' : 'Earned from the record'}
            >
              L{a.autonomyLevel}
              {a.pinned ? ' 📌' : ''}
            </span>
          </header>
          <div className="muted">
            {a.department} · {a.status} · AI ${a.aiCost.toFixed(2)} · {a.runs} runs
          </div>
          <div className="stats">
            <span>trust {a.trustScore}</span>
            <span>accepted {a.acceptedWork}</span>
            <span>reversals {a.reversals}</span>
            <span>approved {a.approved}</span>
            <span>held {a.held}</span>
            <span>denied {a.denied}</span>
          </div>
        </article>
      ))}
    </div>
  );
}
