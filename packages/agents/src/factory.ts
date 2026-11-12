import type { Database } from '@agpal/db';
import type { Services } from '@agpal/policy';
import { Coordination, coordinationTools } from './coordination.js';
import { loadModelConfig, type ModelConfig } from './models.js';
import { OpenAIProvider, type ModelProvider } from './provider.js';
import { AgentRuntime, type RuntimeDeps } from './runtime.js';
import { coreTools, type Tool } from './tools.js';

/** Build the runtime from config: model provider and tiers from AGPAL_MODELS_JSON, tools from the registry. */
export function createAgentRuntime(
  db: Database,
  services: Services,
  opts: {
    provider?: ModelProvider;
    models?: ModelConfig;
    extraTools?: Tool[];
    extraServices?: Record<string, unknown>;
    extras?: Partial<RuntimeDeps>;
    openaiApiKey?: string;
  } = {},
): { runtime: AgentRuntime; coordination: Coordination } {
  const models = opts.models ?? loadModelConfig();
  const provider =
    opts.provider ??
    new OpenAIProvider({
      ...(opts.openaiApiKey ? { apiKey: opts.openaiApiKey } : {}),
      ...(models.baseURL ? { baseURL: models.baseURL } : {}),
    });
  const coordination = new Coordination(db, services.gate);
  const tools = new Map(
    [...coreTools, ...coordinationTools, ...(opts.extraTools ?? [])].map((t) => [t.name, t]),
  );
  const runtime = new AgentRuntime({
    db,
    ledger: services.ledger,
    gate: services.gate,
    provider,
    models,
    tools,
    services: {
      commerce: services.commerce,
      inbound: services.inbound,
      coordination,
      ...opts.extraServices,
    },
    inboxSources: [coordination.inboxSource],
    ...opts.extras,
  });
  return { runtime, coordination };
}
