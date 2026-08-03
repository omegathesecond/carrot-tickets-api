/**
 * The SPA page a buyer lands on after returning from an external payment
 * provider (Peach 3-D Secure, DeltaPay hosted checkout, …).
 *
 * Shared so every redirect-style payment method sends buyers to the same place.
 * `CARD_RESULT_PAGE_URL` is the historical name for this same page and is kept
 * as a fallback so existing deploys keep working without an env change.
 */
const DEFAULT_RESULT_PAGE_URL = 'https://carrottickets.com/payment-result';

export function paymentResultPageUrl(): string {
  return (
    process.env['PAYMENT_RESULT_PAGE_URL'] ||
    process.env['CARD_RESULT_PAGE_URL'] ||
    DEFAULT_RESULT_PAGE_URL
  );
}

/**
 * Build the redirect target for a finished (or still-pending) payment.
 *
 * The `status` is a DISPLAY hint only — it lets the result page show an outcome
 * even when the buyer returns on a different device/browser and isn't signed in.
 * It grants nothing: tickets mint server-side only, so a spoofed status is inert
 * and the page's authenticated poll remains authoritative.
 */
export function paymentResultRedirect(
  id?: string,
  status?: 'completed' | 'failed' | 'pending',
  method?: string
): string {
  const page = paymentResultPageUrl();
  if (!id) return page;
  const params = new URLSearchParams({ id });
  if (status) params.set('status', status);
  if (method) params.set('method', method);
  return `${page}?${params.toString()}`;
}
