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
}
