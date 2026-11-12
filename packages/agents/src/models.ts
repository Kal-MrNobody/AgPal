import { z } from 'zod';

/**
 * Model tiers, names and per-token prices live in config, never in code paths (Prompt 10). Prices are micro-dollars
 * per 1M tokens so cost math stays in integers (invariant 2). Override with AGPAL_MODELS_JSON.
 */
export const modelConfigSchema = z.object({
  provider: z.enum(['openai', 'scripted']).default('openai'),
  /** Any OpenAI-compatible gateway (e.g. an Anthropic or self-hosted proxy) can be swapped in here. */
  baseURL: z.string().optional(),
  tiers: z.object({
    routine: z.object({
      model: z.string(),
      maxRunCostMinor: z.number().int().positive(),
      maxSteps: z.number().int().positive(),
    }),
    strong: z.object({
      model: z.string(),
      maxRunCostMinor: z.number().int().positive(),
      maxSteps: z.number().int().positive(),
    }),
  }),
  prices: z.record(
    z.string(),
    z.object({
      inputMicrosPerMTok: z.number().int().nonnegative(),
      outputMicrosPerMTok: z.number().int().nonnegative(),
    }),
  ),
});

export type ModelConfig = z.output<typeof modelConfigSchema>;
export type ModelTier = keyof ModelConfig['tiers'];

/** Defaults. Prices are the published per-token list prices at the time of writing; check before relying on them. */
export const defaultModelConfig: ModelConfig = {
  provider: 'openai',
  tiers: {
    routine: { model: 'gpt-5-mini', maxRunCostMinor: 5, maxSteps: 6 },
    strong: { model: 'gpt-5', maxRunCostMinor: 25, maxSteps: 8 },
  },
  prices: {
    'gpt-5-mini': { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 2_000_000 },
    'gpt-5': { inputMicrosPerMTok: 1_250_000, outputMicrosPerMTok: 10_000_000 },
    scripted: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 },
  },
};

export function loadModelConfig(raw = process.env.AGPAL_MODELS_JSON): ModelConfig {
  return raw ? modelConfigSchema.parse(JSON.parse(raw)) : defaultModelConfig;
}

/** Exact cost in micro-dollars, rounded up. */
export function costMicros(
  config: ModelConfig,
  model: string,
  inputTokens: number,
  outputTokens: number,
): bigint {
  const p = config.prices[model];
  if (!p) throw new Error(`No price configured for model ${model}`);
  const total =
    BigInt(inputTokens) * BigInt(p.inputMicrosPerMTok) +
    BigInt(outputTokens) * BigInt(p.outputMicrosPerMTok);
  return (total + 999_999n) / 1_000_000n;
}

/** Micro-dollars → cents, rounded up: an envelope is never under-charged (constitution §2.8). */
export const microsToMinorCeil = (micros: bigint): bigint => (micros + 9_999n) / 10_000n;
