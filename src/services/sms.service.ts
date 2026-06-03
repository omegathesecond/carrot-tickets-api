/**
 * SMS service for Keshless Tickets.
 *
 * Routes through the unified Keshless SMS gateway at
 * POST {KESHLESS_API_URL}/integration/sms — the main keshless-api owns
 * the provider switching (MTN SMPP via the USSD relay, or YeboLink),
 * the credit pool, and the central logs. We just shape the body and
 * authenticate with the existing integration API key.
 *
 * Same KESHLESS_API_URL + KESHLESS_API_KEY env vars we already use for
 * /integration/payment — no new secrets, no new YeboLink wiring on this
 * service. When a new Keshless sub-product (travels, etc.) needs SMS, it
 * gets the capability for free as soon as it has an integration key.
 *
 * Per global rule: SMS failures do NOT roll back the ticket purchase.
 * The caller invokes this fire-and-forget and logs the boolean result.
 */

const KESHLESS_API_URL = process.env['KESHLESS_API_URL'] || 'http://localhost:3000/api';
const KESHLESS_API_KEY = process.env['KESHLESS_API_KEY'] || '';

export interface TicketSummary {
  ticketId: string;       // TKT-...
  eventName: string;
  eventDate: string;      // ISO
  venue: string;
}

export class SmsService {
  /**
   * Low-level send. Returns true if the gateway accepted the message
   * (HTTP 200), false otherwise. Always logs the outcome.
   */
  private static async send(phoneNumber: string, message: string): Promise<boolean> {
    if (!KESHLESS_API_KEY) {
      console.error('[SMS] KESHLESS_API_KEY missing — cannot reach unified gateway');
      return false;
    }

    try {
      const response = await fetch(`${KESHLESS_API_URL}/integration/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': KESHLESS_API_KEY,
        },
        body: JSON.stringify({ to: phoneNumber, message }),
      });

      if (response.ok) {
        console.log(`[SMS] Dispatched to ${phoneNumber} via Keshless gateway`);
        return true;
      }

      const errorText = await response.text().catch(() => '');
      console.error(`[SMS] Gateway returned ${response.status}: ${errorText.slice(0, 200)}`);
      return false;
    } catch (error) {
      console.error('[SMS] Error reaching gateway', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Send a ticket purchase confirmation. For multi-ticket buys, lists each
   * ticketId on its own line up to a soft cap, falling back to a count if
   * the body would exceed ~320 chars (≈ 2 SMS segments) to keep costs sane.
   */
  static async sendTicketConfirmation(
    phoneNumber: string,
    tickets: TicketSummary[],
  ): Promise<boolean> {
    if (!phoneNumber || tickets.length === 0) return false;

    const first = tickets[0];
    if (!first) return false;

    const dateShort = new Date(first.eventDate).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

    let body: string;
    if (tickets.length === 1) {
      body =
        `🎫 ${first.eventName} ticket confirmed!\n` +
        `Code: ${first.ticketId}\n` +
        `${dateShort} • ${first.venue}\n` +
        `Show this code at entry.`;
    } else {
      const codes = tickets.map((t) => t.ticketId).join('\n');
      const candidate =
        `🎫 ${tickets.length} ${first.eventName} tickets confirmed!\n` +
        `${codes}\n` +
        `${dateShort} • ${first.venue}`;
      body = candidate.length <= 320
        ? candidate
        : `🎫 ${tickets.length} ${first.eventName} tickets confirmed! See your receipt for codes. ${dateShort} • ${first.venue}`;
    }

    return this.send(phoneNumber, body);
  }

  /**
   * Send a login one-time passcode. Unlike the purchase confirmation, the
   * OTP send is NOT fire-and-forget — the caller must surface a failure to
   * the buyer (they can't log in without the code), per the no-silent-
   * fallback rule. Returns true only if the gateway accepted the message.
   */
  static async sendOtp(phoneNumber: string, code: string): Promise<boolean> {
    if (!phoneNumber || !code) return false;
    const body =
      `${code} is your Keshless Tickets login code.\n` +
      `It expires in 10 minutes. Don't share it with anyone.`;
    return this.send(phoneNumber, body);
  }
}
