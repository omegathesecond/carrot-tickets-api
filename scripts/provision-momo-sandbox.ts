/**
 * One-time: create an MTN MoMo SANDBOX API user + key for the Collections product.
 * Run: MTN_MOMO_SUBSCRIPTION_KEY=xxx MTN_MOMO_BASE_URL=https://sandbox.momodeveloper.mtn.com \
 *      npx ts-node scripts/provision-momo-sandbox.ts
 * Prints MTN_MOMO_API_USER + MTN_MOMO_API_KEY to paste into env/secrets.
 */
import { randomUUID } from 'crypto';
(async () => {
  const base = process.env['MTN_MOMO_BASE_URL']!;
  const sub = process.env['MTN_MOMO_SUBSCRIPTION_KEY']!;
  const referenceId = randomUUID();
  let r = await fetch(`${base}/v1_0/apiuser`, {
    method: 'POST',
    headers: { 'X-Reference-Id': referenceId, 'Ocp-Apim-Subscription-Key': sub, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerCallbackHost: 'carrottickets.com' }),
  });
  if (r.status !== 201) throw new Error(`apiuser failed: ${r.status} ${await r.text()}`);
  r = await fetch(`${base}/v1_0/apiuser/${referenceId}/apikey`, {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': sub },
  });
  if (!r.ok) throw new Error(`apikey failed: ${r.status}`);
  const { apiKey } = await r.json() as any;
  console.log('MTN_MOMO_API_USER=', referenceId);
  console.log('MTN_MOMO_API_KEY=', apiKey);
})();
