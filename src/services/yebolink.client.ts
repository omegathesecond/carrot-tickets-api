/**
 * YeboLink client for Carrot Tickets.
 *
 * The Keshless SMS gateway terminates on MTN Eswatini's SMPP link, so it can
 * only reach +268 handsets. International recipients (foreign buyers grabbing
 * OTPs / ticket codes) are routed here instead — YeboLink (api.yebolink.com)
 * sends via Twilio, which has global termination. Eswatini numbers stay on
 * Keshless (see sms.service.ts for the routing split).
 *
 * Keys live in the "Carrot Tickets" YeboLink workspace (carrottickects@gmail.com),
 * NOT the Omevision Hub workspace — this is a contract product.
 */

const YEBOLINK_API_URL = process.env['YEBOLINK_API_URL'] || 'https://api.yebolink.com';

function getApiKey(): string {
  const key = process.env['YEBOLINK_API_KEY'];
  if (!key) throw new Error('YEBOLINK_API_KEY env var is not set');
  return key;
}

export interface YeboLinkSendResult {
  messageId: string;
  status: string;
}

export const YeboLinkClient = {
  async sendSMS(to: string, text: string, fromName = 'CarrotTix'): Promise<YeboLinkSendResult> {
    const res = await fetch(`${YEBOLINK_API_URL}/api/v1/messages/send`, {
      method: 'POST',
      headers: { 'X-API-Key': getApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        channel: 'sms',
        content: { text, from_name: fromName },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: { message_id?: string; status?: string };
    };
    if (!res.ok || !body.success) {
      throw new Error(`YeboLink SMS send failed (${res.status}): ${body.error ?? 'unknown error'}`);
    }
    return {
      messageId: body.data?.message_id ?? '',
      status: body.data?.status ?? '',
    };
  },
};
