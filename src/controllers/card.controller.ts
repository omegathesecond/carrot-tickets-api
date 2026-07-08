import { Request, Response } from 'express';
import { PeachClient } from '@services/payments/peach.client';
import { TicketService } from '@services/ticket.service';

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
        await TicketService.finalizeCardSale(paymentId);
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
      try {
        await TicketService.finalizeCardSale(paymentId);
      } catch (e) {
        console.error('[card return] finalize', e); // best-effort; polling on the page is the backstop
      }
      return res.redirect(302, `${pageUrl}?id=${encodeURIComponent(paymentId)}`);
    }
    // No id — send the buyer to the result page anyway; it will show a generic state.
    return res.redirect(302, pageUrl);
  }
}
