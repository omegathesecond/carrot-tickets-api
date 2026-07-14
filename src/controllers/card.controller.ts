import { Request, Response } from 'express';
import { PeachClient } from '@services/payments/peach.client';
import { TicketService } from '@services/ticket.service';
import { BookingService } from '@services/transport/booking.service';

/** True when `e` is the ticket finalizer's "not a ticket sale" miss — the
 * signal to fall through to the bus-booking finalizer instead. */
function isNotFoundError(e: unknown): boolean {
  return /not found/i.test(e instanceof Error ? e.message : String(e));
}

export class CardController {
  /**
   * Peach Payments webhook receiver. Always returns HTTP 200 to prevent
   * Peach retry storms — mirror of MomoController.callback pattern.
   *
   * Body handling: app.ts mounts a global express.json(), so req.body is
   * already parsed JSON. Two shapes are handled:
   *   1. Verification handshake: { verificationCode } — acknowledge and return.
   *   2. Plaintext (no webhook secret set): { id } — finalize directly.
   *   3. Encrypted (PEACH_WEBHOOK_SECRET set): { encryptedBody } + AES-GCM
   *      headers → decrypt → extract id → finalize.
   */
  static async webhook(req: Request, res: Response): Promise<any> {
    try {
      // Peach verification handshake — just acknowledge.
      if (req.body?.verificationCode) {
        return res.status(200).json({ ok: true });
      }

      let paymentId: string | undefined;

      const webhookSecret = process.env['PEACH_WEBHOOK_SECRET'];
      if (webhookSecret && req.body?.encryptedBody) {
        // Encrypted JSON-wrapper mode.
        const payload = new PeachClient().decryptWebhook({
          bodyHex: req.body.encryptedBody,
          ivHex: req.headers['x-initialization-vector'] as string,
          authTagHex: req.headers['x-authentication-tag'] as string,
        });
        paymentId = payload?.id;
      } else {
        // Plaintext / test mode — body already parsed JSON by express.json().
        paymentId = req.body?.id;
      }

      if (paymentId) {
        try {
          await TicketService.finalizeCardSale(paymentId);
        } catch (e) {
          // Not a ticket sale — try the bus-booking finalizer before giving up.
          // Both finalizers are idempotent, so a retried webhook double-invoking
          // is safe. Swallow+log here (own try/catch) rather than letting it
          // reach the outer catch, since a genuinely-unknown paymentId will
          // throw "not found" again and must not be logged as an unexpected error.
          if (isNotFoundError(e)) {
            try {
              await BookingService.finalizeCardBooking(paymentId);
            } catch (be) {
              console.error('[card webhook] booking finalize', be);
            }
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      console.error('[card webhook]', e);
    }

    return res.status(200).json({ ok: true }); // always 200 so Peach doesn't retry-storm
  }

  /**
   * Peach shopperResultUrl target — the buyer's BROWSER lands here after the
   * hosted card page (incl. 3-D Secure). Peach returns via GET (id in query)
   * OR POST (3-D Secure ACS form-submits back), so this accepts both.
   *
   * Why a server endpoint instead of pointing shopperResultUrl straight at the
   * SPA: the SPA is a Cloudflare Pages static site that rejects POST → the 3DS
   * return was "blocked". Here we (1) finalise server-side — so the sale mints
   * even if the webhook never fires or the buyer closes the tab — then (2) 302
   * the browser (GET) to the SPA result page for the status display.
   */
  static async returnRedirect(req: Request, res: Response): Promise<any> {
    const raw =
      req.query['id'] || req.body?.id || req.query['paymentId'] || req.body?.paymentId;
    const paymentId = typeof raw === 'string' && raw ? raw : undefined;

    const pageUrl = process.env['CARD_RESULT_PAGE_URL'] || 'https://carrottickets.com/payment-result';

    if (paymentId) {
      let status: 'completed' | 'failed' | 'pending' | undefined;
      try {
        ({ status } = await TicketService.finalizeCardSale(paymentId));
      } catch (e) {
        // Not a ticket sale — try the bus-booking finalizer before giving up
        // (idempotent, same as the webhook fall-through). Its returned status
        // (if any) is what gets threaded into the redirect's &status= param.
        if (isNotFoundError(e)) {
          try {
            ({ status } = await BookingService.finalizeCardBooking(paymentId));
          } catch (be) {
            console.error('[card return] booking finalize', be); // best-effort; polling on the page is the backstop
          }
        } else {
          console.error('[card return] finalize', e); // best-effort; polling on the page is the backstop
        }
      }
      // Pass the server-side outcome so the SPA can show the result WITHOUT
      // depending on the buyer being signed in on this device (3DS can return
      // on a different browser/device). Polling stays the authoritative re-check;
      // a spoofed &status grants no ticket (minting is server-side only).
      const q = `?id=${encodeURIComponent(paymentId)}${status ? `&status=${status}` : ''}`;
      return res.redirect(302, `${pageUrl}${q}`);
    }
    // No id — send the buyer to the result page anyway; it will show a generic state.
    return res.redirect(302, pageUrl);
  }
}
