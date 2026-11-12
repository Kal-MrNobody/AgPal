import type { FastifyInstance } from 'fastify';

export interface WebhookDeps {
  /** Verify with PayPal (fails closed). Receives the exact raw body. */
  verify: (headers: Record<string, string | undefined>, rawBody: string) => Promise<boolean>;
  /** Store the raw event; returns false if this event id was already stored (duplicate). */
  store: (
    event: {
      id: string;
      event_type: string;
      resource_type?: string;
      resource?: Record<string, unknown>;
    },
    verified: boolean,
  ) => Promise<boolean>;
  /** Enqueue processing. */
  enqueue: (eventId: string) => Promise<void>;
}

/**
 * POST /webhooks/paypal: verify the signature against the raw body, store the raw event (dedupe by PayPal event
 * id), enqueue, return 200 fast. Processing happens in apps/worker.
 */
export function registerPayPalWebhook(app: FastifyInstance, deps: WebhookDeps): void {
  void app.register((scope, _opts, done) => {
    // Keep the exact bytes: re-serialized JSON breaks PayPal's signature.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 1_048_576 },
      (_req, body, next) => {
        next(null, body);
      },
    );
    scope.post('/webhooks/paypal', async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      let event: {
        id?: unknown;
        event_type?: unknown;
        resource_type?: unknown;
        resource?: unknown;
      };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return reply.code(400).send({ error: 'invalid JSON' });
      }
      if (typeof event.id !== 'string' || typeof event.event_type !== 'string') {
        return reply.code(400).send({ error: 'not a PayPal event' });
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]),
      );
      const verified = await deps.verify(headers, raw).catch(() => false);
      if (!verified) {
        req.log.warn(
          { eventId: event.id, eventType: event.event_type },
          'webhook signature verification failed',
        );
        return reply.code(400).send({ error: 'signature verification failed' });
      }
      const isNew = await deps.store(
        {
          id: event.id,
          event_type: event.event_type,
          ...(typeof event.resource_type === 'string'
            ? { resource_type: event.resource_type }
            : {}),
          ...(typeof event.resource === 'object' && event.resource !== null
            ? { resource: event.resource as Record<string, unknown> }
            : {}),
        },
        true,
      );
      if (isNew) await deps.enqueue(event.id);
      return reply.code(200).send({ received: true, duplicate: !isNew });
    });
    done();
  });
}
