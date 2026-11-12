import { describe, expect, it } from 'vitest';
import { loadEngine, recalculate, type PlanSnapshot } from './headless.js';

/**
 * Bryntum's scheduling engine, headless in Node (no browser, no DOM). One payment milestone gates a launch; when the
 * payment slips, every downstream date moves, and settlement delay stays a dependency lag.
 */
const plan: PlanSnapshot = {
  projectStart: '2026-11-16',
  tasks: [
    {
      id: 'pay-inv-123',
      name: 'Payment received: INV-123',
      durationDays: 0,
      constraintDate: '2026-11-20',
    },
    { id: 'launch', name: 'Launch campaign', durationDays: 3 },
    { id: 'contractor', name: 'Pay contractor', durationDays: 1 },
  ],
  dependencies: [
    { id: 'd1', from: 'pay-inv-123', to: 'launch', lagDays: 2 },
    { id: 'd2', from: 'launch', to: 'contractor', lagDays: 0 },
  ],
};

describe('headless Bryntum engine', () => {
  it('schedules a payment milestone with a startnoearlierthan constraint and a settlement lag', async () => {
    const r = await recalculate(plan, []);
    const by = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(by['pay-inv-123']?.start.slice(0, 10)).toBe('2026-11-20');
    // Settlement delay of 2 days is the dependency's lag, not a padded date.
    expect(by.launch?.start.slice(0, 10)).toBe('2026-11-22');
    expect(by.contractor?.start.slice(0, 10)).toBe(by.launch?.end.slice(0, 10));
  });

  it('a slipped payment moves only its constraintDate, and the engine reschedules everything downstream', async () => {
    const before = await recalculate(plan, []);
    const after = await recalculate(plan, [
      { kind: 'shift_payment', taskId: 'pay-inv-123', newDate: '2026-11-25' },
    ]);
    const b = Object.fromEntries(before.tasks.map((t) => [t.id, t]));
    const a = Object.fromEntries(after.tasks.map((t) => [t.id, t]));
    expect(a['pay-inv-123']?.start.slice(0, 10)).toBe('2026-11-25');
    expect(a.launch?.start.slice(0, 10)).toBe('2026-11-27');
    expect(
      new Date(a.contractor?.start ?? '').getTime() - new Date(b.contractor?.start ?? '').getTime(),
    ).toBe(5 * 86_400_000);
    expect(after.changed.sort()).toEqual(['contractor', 'launch', 'pay-inv-123']);
  });

  it('a payment that lands marks its milestone done at the actual date', async () => {
    const r = await recalculate(plan, [
      { kind: 'mark_received', taskId: 'pay-inv-123', receivedAt: '2026-11-19' },
    ]);
    const p = r.tasks.find((t) => t.id === 'pay-inv-123');
    expect(p?.percentDone).toBe(100);
    expect(p?.start.slice(0, 10)).toBe('2026-11-19');
  });

  it('loads the engine in Node: gantt.node.mjs when installed, else the public package data model', async () => {
    const { source } = await loadEngine();
    expect(['gantt.node.mjs', 'gantt-enterprise/ProjectModel']).toContain(source);
  });
});
