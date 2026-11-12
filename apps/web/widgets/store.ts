import type { BoardroomData } from '../lib/types';

/** The boardroom's latest data for custom widgets that need whole rows (approval cards, scorecards). */
let current: BoardroomData | undefined;
const listeners = new Set<() => void>();

export const boardroomStore = {
  set(d: BoardroomData) {
    current = d;
    for (const l of listeners) l();
  },
  get: () => current,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
