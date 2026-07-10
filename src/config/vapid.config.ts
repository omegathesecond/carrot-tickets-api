import webpush from 'web-push';

/**
 * Web Push (VAPID) configuration. Push is DELIVERY, not data: a missing key
 * pair must not crash the API (inbox rows still persist, clients still
 * resync) — but it must be LOUD, and the vapid-public-key endpoint 503s.
 */
const publicKey = process.env['VAPID_PUBLIC_KEY'];
const privateKey = process.env['VAPID_PRIVATE_KEY'];
const subject = process.env['VAPID_SUBJECT'];

export const vapidConfigured: boolean = Boolean(publicKey && privateKey && subject);
export const VAPID_PUBLIC_KEY: string | undefined = publicKey;

export function initWebPush(): void {
  if (!vapidConfigured) {
    console.error(
      '❌ VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not fully set — Web Push DISABLED (inbox notifications unaffected).'
    );
    return;
  }
  webpush.setVapidDetails(subject as string, publicKey as string, privateKey as string);
  console.log('📬 Web Push configured');
}
