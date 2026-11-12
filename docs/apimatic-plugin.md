# APIMatic Context Plugin (PayPal Server SDK) — how we used it

The plugin is a hackathon preview that may be removed, so every SDK fact AgPal depends on is recorded here.

**How it was used.** The `npx context-plugins install …` command was blocked by the cloud session's safety
check (it runs downloaded code), so the plugin's skills were read directly from
`github.com/paypaldev/server-sdk-context-plugin-preview` (`skills/typescript/*/SKILL.md`) and followed by hand:
typescript-getting-started, -client-initialization, -configuration-resilience, -authentication,
-calling-endpoints, -error-handling, -models and -testing. Every claim below was then checked against the SDK
source in `node_modules` and, where marked, against the PayPal sandbox.

## SDK facts we depend on

| Fact                                                                                                                                                       | Source                                                  | Where we rely on it                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Package `@paypal/paypal-server-sdk`, pinned to exactly `2.5.0`                                                                                             | getting-started                                         | `packages/paypal/package.json`                           |
| Controllers: Orders, Payments, Subscriptions, TransactionSearch, Vault, OAuthAuthorization. No Catalog, Invoicing, Payouts, Disputes, webhook verification | SDK `src/controllers/`                                  | thin REST client (`http.ts`), ADR-009                    |
| One flat options object, controllers instantiated per client; build the client once                                                                        | client-initialization                                   | `sdk.ts`                                                 |
| `DEFAULT_CONFIGURATION.timeout = 0` → axios waits forever                                                                                                  | configuration-resilience, SDK `defaultConfiguration.ts` | explicit 15 s timeout                                    |
| `DEFAULT_RETRY_CONFIG`: `maxNumberOfRetries: 0`, `maximumRetryWaitTime: 0`, methods `GET`, `PUT` → retries never fire                                      | configuration-resilience, SDK source                    | explicit retry budget                                    |
| Retries apply per HTTP method to every operation, idempotent or not                                                                                        | configuration-resilience                                | P6-1                                                     |
| OAuth client credentials via `clientCredentialsAuthCredentials`; token cached on the client; `oAuthClockSkew` unset by default                             | authentication                                          | `oAuthClockSkew: 300`                                    |
| Non-2xx throws `ApiError`; on a bare `ApiError`, `result` is `undefined` and only `body` (raw string) is set                                               | error-handling                                          | `sdkCall` parses `body`                                  |
| Transport failures surface as axios errors, not `ApiError`                                                                                                 | error-handling                                          | `isTransportError`                                       |
| `ApiResponse.result` is the typed model (camelCase, `Money` = `{ currencyCode, value }`); `body` is the raw JSON                                           | calling-endpoints, models                               | SDK responses read via `result` (`typed.ts`, ADR-017)    |
| Capture / Refund models include `sellerReceivableBreakdown` / `sellerPayableBreakdown` (gross, fee, net)                                                   | models, SDK `capturedPayment.ts`, `refund.ts`           | `captureWire` / `refundWire` → one validating normalizer |
| `PricingScheme` has `price` + **required** `pricingModel`, no `fixedPrice`                                                                                 | SDK `pricingScheme.ts`                                  | P5-3                                                     |
| `cancelSubscription` takes no `paypalRequestId`                                                                                                            | SDK `subscriptionsController.ts`                        | P6-1                                                     |

**Typed models (ADR-017, 2026-11-12).** Every SDK call site now reads `res.result` (Order, CapturedPayment, Refund,
Subscription, SearchResponse, BalancesResponse). `packages/paypal/src/typed.ts` maps each model into the one validating
normalizer that also serves webhooks (webhook payloads are raw PayPal JSON, not SDK models), so the money checks
(gross = fee + net, a COMPLETED capture must carry its breakdown, integer minor units) live in one place. Verified
against the sandbox: card capture, refund and payout (`sandbox.int.test.ts`), Transaction Search and balances.

## Issues the plugin helped catch (Prompt 5)

| #    | Severity | Issue                                                                                                                                                  | Before                           | After                                                           | Evidence                                                |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| P5-1 | High     | SDK default timeout is 0 (no timeout); a hung PayPal call would hang a payout forever                                                                  | not set                          | `timeout` and `httpClientOptions.timeout` = 15 000 ms           | `audit.test.ts`                                         |
| P5-2 | High     | Retries never fire: `maximumRetryWaitTime: 0` vetoes every retry even if `maxNumberOfRetries` is raised                                                | not set                          | 3 retries, 30 s budget, backoff 2×                              | `audit.test.ts`                                         |
| P5-3 | High     | Billing plan creation through the typed SDK is rejected: `pricing_model: FIXED` → `INVALID_PARAMETER_VALUE`, and `fixed_price` missing                 | `createBillingPlan` with `price` | REST `POST /v1/billing/plans` with `pricing_scheme.fixed_price` | sandbox 400, debug_id `ca59537179cf3`; REST plan ACTIVE |
| P5-4 | High     | Payouts v1 amount is `{currency, value}`, not `{currency_code, value}` → 400 `may not be null: items[0].amount.currency`                               | shared amount helper             | payout-specific shape; parser accepts both                      | sandbox 400; `audit.test.ts`                            |
| P5-5 | Medium   | Orders returned a bare 422 `UNPROCESSABLE_ENTITY` (no field) for an 82-char `PayPal-Request-Id` containing colons; same call with a short id succeeded | raw composite keys               | keys hashed to a deterministic UUID (`toRequestId`)             | sandbox, `http.test.ts`                                 |
| P5-6 | Medium   | Bare `ApiError.result` is undefined, so error details were lost                                                                                        | —                                | parse `body` into `PayPalError` with issue, field, debug_id     | `http.test.ts`                                          |

## Audit (Prompt 6) — the plugin used as a reviewer

| #    | Severity | Check                     | Finding                                                                                                                                                                           | Fix                                                                                                                        | Regression test      |
| ---- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| P6-1 | High     | Idempotency on every POST | Our SDK retry config retries `POST`, but `cancelSubscription` sends no `PayPal-Request-Id`: a lost response would be re-sent and then fail with 422 although the cancel succeeded | cancel goes through REST (no retry without a key) and treats 422 + status `CANCELLED` as success                           | `audit.test.ts` P6-1 |
| P6-2 | High     | Error-handling breadth    | `sdkCall` marked **every** `Error` (SDK input validation, our own bugs) as a retryable network failure; the gate would keep the hold and retry forever                            | only transport errors (axios without response, ECONN*, timeouts) are retryable; everything else is `CLIENT`, not retryable | `audit.test.ts` P6-2 |
| P6-3 | Low      | Amount formatting         | correct already (bigint → exact decimals; JPY/HUF/TWD 0 decimals)                                                                                                                 | none                                                                                                                       | `audit.test.ts` P6-3 |
| P6-4 | Medium   | Webhook verification      | verification must fail closed on missing headers or a non-JSON body, without calling PayPal; only `SUCCESS` passes                                                                | explicit checks                                                                                                            | `audit.test.ts` P6-4 |
| P6-5 | Medium   | Dropped response fields   | fee/net could be silently treated as 0 if the breakdown were missing                                                                                                              | a `COMPLETED` capture without breakdown, or with gross ≠ fee + net, throws                                                 | `normalize.test.ts`  |
| P6-6 | Info     | Version pinning           | `2.5.0` exact, lockfile committed                                                                                                                                                 | none                                                                                                                       | —                    |

### Before / after (P6-2)

```ts
// before
if (e instanceof Error) throw new PayPalError(..., 'NETWORK', undefined, /* retryable */ true);
// after
if (isTransportError(e)) throw new PayPalError(..., 'NETWORK', undefined, true);
throw new PayPalError(..., 'CLIENT', undefined, false);
```

## APIMatic claim form — "Description of Context Plugin usage" (< 100 words)

We built AgPal's PayPal adapter (Orders, Payments, Subscriptions, Transaction Search on SDK 2.5.0, thin REST for
Payouts, Invoicing, Disputes, webhooks) by following the plugin's TypeScript skills, then used them to audit it.
They caught: the SDK's zero timeout and retry defaults that never fire (both now explicit), a bare ApiError
losing error details, SDK retries re-sending a non-idempotent cancel, and over-broad error mapping that would
retry programming errors. Verifying in sandbox also exposed the typed billing-plan pricing scheme being rejected
and the Payouts amount shape.
