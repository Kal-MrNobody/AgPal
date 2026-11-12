import { z } from 'zod';
import { Secret } from './secret.js';

const secret = z
  .string()
  .min(1)
  .transform((v) => new Secret(v));

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v ? new Secret(v) : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url().transform((v) => new Secret(v)),
  PAYPAL_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: secret,
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  OPENAI_API_KEY: optionalSecret,
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Legacy names some hosted environments already use. Canonical names win when both are set.
 * Only names are mapped here; values are never logged.
 */
const ALIASES: Record<string, string> = {
  Client_ID: 'PAYPAL_CLIENT_ID',
  Secret_key_1: 'PAYPAL_CLIENT_SECRET',
};

export class EnvError extends Error {
  override name = 'EnvError';
}

/** Validate env once at startup. Errors name the variables but never echo their values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const input: Record<string, string | undefined> = { ...source };
  for (const [legacy, canonical] of Object.entries(ALIASES)) {
    if (!input[canonical] && input[legacy]) input[canonical] = input[legacy];
  }
  for (const [k, v] of Object.entries(input)) if (v === '') input[k] = undefined;

  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new EnvError(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
