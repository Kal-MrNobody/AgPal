/** Normalized PayPal error. SDK and HTTP error types never leave packages/paypal. */
export class PayPalError extends Error {
  override name = 'PayPalError';
  constructor(
    message: string,
    readonly status: number | undefined,
    /** PayPal's error name, e.g. UNPROCESSABLE_ENTITY, RESOURCE_NOT_FOUND. */
    readonly issue: string | undefined,
    readonly debugId: string | undefined,
    /** Safe to retry with the same idempotency key. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Build a PayPalError from a PayPal error JSON body (shape is shared by every REST API). */
export function fromErrorBody(status: number, raw: unknown, fallback: string): PayPalError {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    name?: string;
    message?: string;
    debug_id?: string;
    error?: string;
    error_description?: string;
    details?: { issue?: string; description?: string; field?: string }[];
  };
  const detail = body.details?.[0];
  const issue = detail?.issue ?? body.name ?? body.error;
  const message = [
    body.message ?? body.error_description ?? fallback,
    detail?.issue,
    detail?.field,
    detail?.description,
  ]
    .filter(Boolean)
    .join(': ');
  return new PayPalError(
    `PayPal ${status}: ${message}`,
    status,
    issue,
    body.debug_id,
    RETRYABLE_STATUS.has(status),
  );
}
