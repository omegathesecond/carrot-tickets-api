/**
 * Register (or list) the Carrot Tickets webhook with Yoco.
 *
 * This is the step that MINTS THE SIGNING SECRET (`whsec_…`). Yoco returns it
 * exactly once, at registration — it cannot be read back later. Store it in
 * Secret Manager as CARROT_TICKETS__YOCO_WEBHOOK_SECRET[_DEV] and bind it to
 * the service as YOCO_WEBHOOK_SECRET.
 *
 * Without that secret the webhook receiver rejects every delivery with 401,
 * and since Yoco has no status-query endpoint that means NO Yoco sale can ever
 * be finalised. Registering is therefore a hard prerequisite for go-live, not
 * an optimisation.
 *
 * Usage:
 *   YOCO_SECRET_KEY=sk_test_… YOCO_WEBHOOK_URL=https://dev-api.carrottickets.com/api/public/purchase/yoco/webhook \
 *     npm run yoco:register-webhook
 *
 *   YOCO_SECRET_KEY=sk_test_… npm run yoco:register-webhook -- --list
 */
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = (process.env['YOCO_BASE_URL'] || 'https://payments.yoco.com').replace(/\/+$/, '');
const SECRET_KEY = process.env['YOCO_SECRET_KEY'];
const WEBHOOK_URL = process.env['YOCO_WEBHOOK_URL'];
const WEBHOOK_NAME = process.env['YOCO_WEBHOOK_NAME'] || 'carrot-tickets';

function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET_KEY}` };
}

async function list(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/webhooks`, { headers: headers() });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Yoco listWebhooks failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  console.log(JSON.stringify(data, null, 2));
}

async function register(): Promise<void> {
  if (!WEBHOOK_URL) throw new Error('YOCO_WEBHOOK_URL is required (the public /yoco/webhook endpoint)');
  if (!/^https:\/\//.test(WEBHOOK_URL)) throw new Error('YOCO_WEBHOOK_URL must be https');

  const res = await fetch(`${BASE_URL}/api/webhooks`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name: WEBHOOK_NAME, url: WEBHOOK_URL }),
  });
  const data: any = await res.json().catch(() => ({}));
  // Never interpolate the secret key into errors — status + provider detail only.
  if (!res.ok) throw new Error(`Yoco registerWebhook failed: HTTP ${res.status} ${JSON.stringify(data)}`);

  console.log(`\n✅ Registered "${WEBHOOK_NAME}" → ${WEBHOOK_URL}`);
  console.log(`   id: ${data.id}`);

  if (data.secret) {
    console.log(`\n🔑 SIGNING SECRET (shown ONCE — Yoco will not reveal it again):\n`);
    console.log(`   ${data.secret}\n`);
    console.log('   Store it now, then bind it to the service:');
    console.log(
      `   printf '%s' '${'<paste-secret>'}' | gcloud secrets create CARROT_TICKETS__YOCO_WEBHOOK_SECRET --data-file=- --project=contracts-470406\n`
    );
  } else {
    console.error(
      '\n⚠️  No secret in the response. The webhook exists but cannot be verified — ' +
        'delete it and re-register, or the receiver will 401 every delivery.'
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (!SECRET_KEY) throw new Error('YOCO_SECRET_KEY is required');
  if (process.argv.includes('--list')) return list();
  return register();
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
