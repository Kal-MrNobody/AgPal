export const departments = ['revenue', 'finance', 'support', 'growth'] as const;
export type Department = (typeof departments)[number];

export function isDepartment(value: string): value is Department {
  return (departments as readonly string[]).includes(value);
}

/** An agent is an employee: a department, a mandate, a budget envelope, tools and an autonomy level. */
export interface AgentDefinition {
  id: string;
  department: Department;
  title: string;
  /** Plain-language job description and goals. */
  mandate: string;
  modelTier: 'routine' | 'strong';
  heartbeatCron: string;
  envelope: string;
  /** Tool allow-list. */
  tools: readonly string[];
  reportsTo: 'founder' | (string & {});
}

export interface AgentRecord extends AgentDefinition {
  companyId: string;
  status: string;
  inboxCursor: Date;
}

export type Trigger =
  | { kind: 'heartbeat' }
  | { kind: 'event'; eventId: string; name: string }
  | { kind: 'manual'; note?: string };
