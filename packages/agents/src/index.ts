/**
 * Agent runtime (Prompt 10). Agents never hold money tools that call PayPal:
 * money tools only create SpendIntents for @agpal/policy.
 */
export const departments = ['revenue', 'finance', 'support', 'growth'] as const;
export type Department = (typeof departments)[number];

export interface AgentDefinition {
  id: string;
  department: Department;
  title: string;
  mandate: string;
  modelTier: 'routine' | 'strong';
  heartbeatCron: string;
  envelope: string;
  tools: readonly string[];
  autonomyLevel: number;
  reportsTo: 'founder' | (string & {});
}

export function isDepartment(value: string): value is Department {
  return (departments as readonly string[]).includes(value);
}
