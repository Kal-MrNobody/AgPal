/**
 * pnpm webhook:register --url https://agpal-api.onrender.com — register (or find) the PayPal webhook for a public API
 * URL and print PAYPAL_WEBHOOK_ID. Uses the PayPal API, so no dashboard clicking is needed.
 */
import { createDb } from '@agpal/db';
import { createServices, PAYPAL_WEBHOOK_EVENTS } from '@agpal/policy';
import { loadEnv } from '@agpal/shared';

const env = loadEnv();
const i = process.argv.indexOf('--url');
const base = (i > 0 ? process.argv[i + 1] : env.PUBLIC_API_URL) ?? '';
if (!/^https:\/\//.test(base))
  throw new Error('Give the public https URL of apps/api: --url https://…');
const db = createDb(env.DATABASE_URL, { max: 1 });
const { inbound } = createServices(db, env);
const id = await inbound.ensureWebhook(
  `${base.replace(/\/$/, '')}/webhooks/paypal`,
  PAYPAL_WEBHOOK_EVENTS,
);
await db.$client.end();
console.log(
  `PayPal webhook for ${base}/webhooks/paypal: ${id}\nSet PAYPAL_WEBHOOK_ID=${id} (Render: agpal-shared env group) and redeploy agpal-api.`,
);
