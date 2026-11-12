/**
 * pnpm webhook:tunnel — start a cloudflared quick tunnel to apps/api, register the PayPal webhook for it (sandbox),
 * and print the URL, webhook id and the exact event list. Keep it running while you test.
 */
import { spawn } from 'node:child_process';
import { createDb } from '@agpal/db';
import { createServices, PAYPAL_WEBHOOK_EVENTS } from '@agpal/policy';
import { loadEnv } from '@agpal/shared';

const env = loadEnv();
const port = env.API_PORT;
const child = spawn(
  'cloudflared',
  ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const url = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('cloudflared did not print a URL within 60s')),
    60_000,
  );
  const scan = (chunk: Buffer) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('exit', (code) => reject(new Error(`cloudflared exited with ${String(code)}`)));
});

const webhookUrl = `${url}/webhooks/paypal`;
console.warn(`\nTunnel:      ${url}\nWebhook URL: ${webhookUrl}\n`);
console.warn('Events to subscribe:\n' + PAYPAL_WEBHOOK_EVENTS.map((e) => `  - ${e}`).join('\n'));

if (env.PAYPAL_ENVIRONMENT === 'sandbox' && process.argv.includes('--register')) {
  const db = createDb(env.DATABASE_URL, { max: 1 });
  const { inbound } = createServices(db, env);
  const id = await inbound.ensureWebhook(webhookUrl, PAYPAL_WEBHOOK_EVENTS);
  await db.$client.end();
  console.warn(
    `\nRegistered sandbox webhook ${id}. Set PAYPAL_WEBHOOK_ID=${id} for apps/api, then restart it.`,
  );
} else {
  console.warn(
    '\nRegister it in the PayPal dashboard (Apps & Credentials → your app → Webhooks), or rerun with --register (sandbox).',
  );
}
console.warn('\nCtrl+C to stop the tunnel.');
process.once('SIGINT', () => child.kill());
