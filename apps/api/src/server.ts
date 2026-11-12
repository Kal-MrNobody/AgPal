import Fastify, { type FastifyInstance } from 'fastify';

export interface ServerOptions {
  logLevel?: string;
  /** Liveness of dependencies, injected so tests need no database. */
  checkDatabase?: () => Promise<boolean>;
}

/** Log redaction for invariant 6: auth headers and anything named like a secret never reach logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["paypal-auth-algo"]',
  'req.headers["paypal-transmission-sig"]',
  '*.secret',
  '*.password',
  '*.token',
  '*.apiKey',
];

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
  });

  app.get('/health', async () => {
    const database = opts.checkDatabase ? await opts.checkDatabase().catch(() => false) : undefined;
    return { status: database === false ? 'degraded' : 'ok', database };
  });

  return app;
}
