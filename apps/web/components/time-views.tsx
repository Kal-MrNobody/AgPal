'use client';

import { useMemo, useRef, useState } from 'react';
import { BryntumGantt } from '@bryntum/gantt-react-enterprise';
import { BryntumScheduler } from '@bryntum/scheduler-react-enterprise';
import '@bryntum/gantt-enterprise/gantt.css';
import '@bryntum/gantt-enterprise/svalbard-light.css';
import type { BoardroomData } from '../lib/types';

interface GanttRef {
  instance?: { project: { load: () => Promise<unknown> } };
}

const HOUR = 3_600_000;

/**
 * Bryntum 8 time views (trial mode, no licence key).
 * - Gantt: the company plan. Dates are computed on the server by the headless engine; the browser only displays them
 *   (CrudManager load from /api/schedule, tasks manually scheduled, read-only). Edits go to the server and reload.
 * - Scheduler: one row per agent; events are runs, assigned tasks and dispute work blocks; disputes whose response
 *   deadline has no work allocated are highlighted; subscription renewals and expected payouts are markers.
 */
export function TimeViews({
  data,
  payments,
}: {
  data: BoardroomData;
  payments: { id: string; name: string; constraintDate?: string }[];
}) {
  const gantt = useRef<GanttRef>(null);
  const [taskId, setTaskId] = useState(payments[0]?.id ?? '');
  const [date, setDate] = useState('');
  const [status, setStatus] = useState('');

  const ganttConfig = useMemo(
    () => ({
      readOnly: true,
      project: { loadUrl: '/api/schedule', autoLoad: true, validateResponse: false },
      columns: [
        { type: 'name', width: 300 },
        { type: 'startdate' },
        { type: 'percentdone', width: 90 },
      ],
      viewPreset: 'weekAndDayLetter',
      barMargin: 8,
    }),
    [],
  );

  const scheduler = useMemo(() => {
    const now = Date.now();
    const resources = data.agents.map((a) => ({
      id: a.agentId,
      name: `${a.title} (${a.department})`,
    }));
    const byDept = (d: string) => data.agents.find((a) => a.department === d)?.agentId;
    const events = [
      ...data.agentRuns.map((r) => ({
        id: r.runId,
        resourceId: r.agentId,
        name: `Run ($${r.cost.toFixed(3)})`,
        startDate: r.startedAt,
        endDate: new Date(
          new Date(r.startedAt).getTime() + Math.max(0.5 * HOUR, r.toolCalls * 0.25 * HOUR),
        ).toISOString(),
        eventColor: 'blue',
      })),
      ...data.tasks
        .filter((t) => t.status === 'open' || t.status === 'delivered')
        .map((t) => ({
          id: t.taskId,
          resourceId: byDept(t.from.includes('@') ? 'growth' : t.from) ?? '',
          name: `Task: ${t.title}`,
          startDate: t.createdAt,
          endDate:
            t.deadline || new Date(new Date(t.createdAt).getTime() + 24 * HOUR).toISOString(),
          eventColor: 'green',
        })),
      ...data.disputes.map((d) => ({
        id: `dispute-${d.disputeId}`,
        resourceId: byDept('support') ?? '',
        name: d.worked
          ? `Dispute ${d.disputeId}: evidence work`
          : `⚠ Dispute ${d.disputeId}: no work allocated before deadline`,
        startDate: d.openedAt,
        endDate:
          d.dueDate || new Date(new Date(d.openedAt).getTime() + 7 * 24 * HOUR).toISOString(),
        eventColor: d.worked ? 'orange' : 'red',
        cls: d.worked ? '' : 'unstaffed',
      })),
    ];
    const timeRanges = [
      ...data.approvals
        .filter((a) => a.action === 'payout' && a.status === 'pending')
        .map((a) => ({
          id: `po-${a.approvalId}`,
          name: `Expected payout $${a.amount.toFixed(2)} (awaiting founder)`,
          startDate: new Date(now + 24 * HOUR).toISOString(),
        })),
      ...data.intents
        .filter((i) => i.action === 'payout' && i.status === 'pending')
        .map((i) => ({
          id: `pp-${i.intentId}`,
          name: `Payout settling $${i.amount.toFixed(2)}`,
          startDate: new Date(now + 2 * HOUR).toISOString(),
        })),
      {
        id: 'renewal',
        name: 'Subscription renewals',
        startDate: new Date(now + 30 * 24 * HOUR).toISOString(),
      },
    ];
    const times = [...events.map((e) => new Date(e.startDate).getTime()), now];
    return {
      resources,
      events,
      timeRanges,
      startDate: new Date(Math.min(...times) - 12 * HOUR),
      endDate: new Date(now + 7 * 24 * HOUR),
      viewPreset: 'dayAndWeek',
      columns: [{ text: 'Agent', field: 'name', width: 260 }],
      rowHeight: 44,
      barMargin: 6,
      features: { timeRanges: { showCurrentTimeLine: true } },
      readOnly: true,
    };
  }, [data]);

  const submit = async (kind: 'shift' | 'received') => {
    setStatus('Recalculating on the server…');
    const res = await fetch('/api/schedule/change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        kind === 'shift' ? { taskId, constraintDate: date } : { taskId, receivedOn: date },
      ),
    });
    if (!res.ok) {
      setStatus(`Rejected: ${((await res.json()) as { error?: string }).error ?? res.status}`);
      return;
    }
    await gantt.current?.instance?.project.load();
    setStatus(
      'Done: the engine rescheduled every dependent milestone on the server; the Gantt shows its dates.',
    );
  };

  return (
    <div className="timeviews">
      <section>
        <h2>Plan (payments gate milestones)</h2>
        <div className="row schedule-form">
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (expected {p.constraintDate?.slice(0, 10)})
              </option>
            ))}
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button
            type="button"
            className="btn"
            disabled={!date}
            onClick={() => void submit('shift')}
          >
            Payment slips to this date
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!date}
            onClick={() => void submit('received')}
          >
            Payment received on this date
          </button>
          <span className="muted">{status}</span>
        </div>
        <div className="bryntum-host">
          <BryntumGantt ref={gantt as never} {...ganttConfig} />
        </div>
      </section>
      <section>
        <h2>Agents over time</h2>
        <div className="bryntum-host">
          <BryntumScheduler {...scheduler} />
        </div>
      </section>
    </div>
  );
}
