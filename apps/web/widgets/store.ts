import type { BoardroomData } from '../lib/types';

/** The boardroom's latest data for custom widgets that need whole rows (approval cards, scorecards, ledger grid). */
let current: BoardroomData | undefined;
const listeners = new Set<() => void>();

const set = (d: BoardroomData): void => {
  current = d;
  for (const l of listeners) l();
};
const get = (): BoardroomData | undefined => current;
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const boardroomStore = { set, get, subscribe } as const;
