/**
 * SMS service for Keshless Tickets.
 *
 * Mirrors the canonical YeboLink sender pattern from
 * `keshless/api/src/services/sms/yebolink.sender.ts`:
 *   - reads YEBOLINK_API_KEY, YEBOLINK_BASE_URL, SMS_ENABLED env vars
 *   - posts to /api/v1/messages/send with { to, channel: 'sms', content }
 *   - returns boolean (true = accepted by gateway)
 *   - logs loudly on failure (no silent fallback)
 *   - returns true when SMS_ENABLED!=='true' (dev parity, matches main API)
 *
 * Only one formatted message right now (sendTicketConfirmation). Add more
 * helpers here as the tickets product grows (reminder before event, refund
 * notice, etc.).
 *
 * Per global rule: SMS failures do NOT roll back the ticket purchase.
 * The caller invokes this fire-and-forget and logs the boolean result.
 */

const YEBOLINK_API_KEY = process.env['YEBOLINK_API_KEY'] || '';
const YEBOLINK_BASE_URL = process.env['YEBOLINK_BASE_URL'] || 'https://api.yebolink.com';
const SMS_ENABLED = process.env['SMS_ENABLED'] === 'true';

interface YeboLinkResponse {
  id: string;
  status: string;       // "queued"
  creditsUsed: number;
  createdAt: string;
}

export interface TicketSummary {
  ticketId: string;       // TKT-...
  eventName: string;
  eventDate: string;      // ISO
  venue: string;
}

export class SmsService {
  /**
   * Low-level send. Returns true if the gateway accepted the message
   * (HTTP 201), false otherwise. Always logs the outcome.
   */
  private static async send(phoneNumber: string, message: string): Promise<boolean> {
    if (!SMS_ENABLED) {
      console.warn(`[SMS:yebolink] SMS_ENABLED!=='true' — would have sent to ${phoneNumber}`);
      return true; // dev-parity with main keshless-api behaviour
    }
    if (!YEBOLINK_API_KEY) {
      console.error('[SMS:yebolink] YEBOLINK_API_KEY missing — cannot send');
      return false;
    }

    try {
      const response = await fetch(`${YEBOLINK_BASE_URL}/api/v1/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': YEBOLINK_API_KEY,
        },
        body: JSON.stringify({
          to: phoneNumber,
          channel: 'sms',
          content: { text: message, from_name: 'KeshlessTickets' },
        }),
      });

      if (response.status === 201) {
        const data = (await response.json()) as YeboLinkResponse;
        console.log(`[SMS:yebolink] Sent to ${phoneNumber} (id=${data.id})`);
        return true;
      }

      const errorText = await response.text().catch(() => '');
      console.error(`[SMS:yebolink] Send failed: ${response.status} ${errorText.slice(0, 200)}`);
      return false;
    } catch (error) {
      console.error('[SMS:yebolink] Error sending SMS', error instanceof Error ? error.message : String(error));
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
}
