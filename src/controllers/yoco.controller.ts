import { Request, Response } from 'express';
import { YocoClient, classifyEventType } from '@services/payments/yoco.client';
import { TicketService } from '@services/ticket.service';
import { paymentResultPageUrl, paymentResultRedirect } from '@utils/paymentResult.util';

/** Map a stored sale status onto the display hint the result page understands. */
function displayStatus(paymentStatus?: string): 'completed' | 'failed' | 'pending' {
  if (paymentStatus === 'completed') return 'completed';
  if (paymentStatus === 'failed' || paymentStatus === 'refunded') return 'failed';
  return 'pending';
}

export class YocoController {
  /**
   * Yoco webhook receiver (unauthenticated transport — authenticity comes from
   * the Standard-Webhooks signature, not from any credential on the connection).
   *
   * THIS IS THE ONLY PATH THAT CAN MINT A YOCO TICKET. Yoco publishes no
   * status-query endpoint, so unlike the Peach and DeltaPay webhooks there is no
   * server-side re-verification behind this — the signature check IS the
   * verification. An unsigned or wrongly signed body is rejected with 401 and
   * never reaches the finalizer.
   *
   * A VERIFIED request always answers 200, even if finalisation throws, so Yoco
   * doesn't retry-storm us — mirrors CardController.webhook.
   */
  static async webhook(req: Request, res: Response): Promise<any> {
    // req.rawBody is captured by the express.json({ verify }) hook in app.ts —
    // the signature covers the EXACT bytes Yoco sent, so a re-serialised
    // req.body would not verify.
    const rawBody = (req as any).rawBody;
    const ok =
      typeof rawBody === 'string' &&
      new YocoClient().verifyWebhook({
        rawBody,
        webhookId: String(req.headers['webhook-id'] || ''),
        webhookTimestamp: String(req.headers['webhook-timestamp'] || ''),
        webhookSignature: String(req.headers['webhook-signature'] || ''),
      });

    if (!ok) {
      console.error('[yoco webhook] signature verification FAILED — rejecting');
      return res.status(401).json({ error: 'invalid signature' });
    }

    try {
      const type = String(req.body?.type || '');
      const payload = req.body?.payload || {};
      // Yoco links a payment back to its checkout via payload.metadata.checkoutId.
      const checkoutId: string | undefined = payload?.metadata?.checkoutId;

      // Only the two payment events move a sale. Anything else (refunds, future
      // additions) is acknowledged and ignored — classifyEventType fails closed.
      if (checkoutId && classifyEventType(type) !== 'ignore') {
        try {
          await TicketService.finalizeYocoSale(checkoutId, {
            type,
            amountCents: Number(payload.amount),
            currency: String(payload.currency || ''),
          });
        } catch (e) {
          // An unknown checkout id is not an emergency (it may belong to another
          // environment sharing the merchant) — log and still answer 200.
          console.error('[yoco webhook] finalize', e);
        }
      }
    } catch (e) {
      console.error('[yoco webhook]', e);
    }

    return res.status(200).json({ ok: true });
  }

  /**
   * Yoco successUrl / cancelUrl / failureUrl target — the buyer's BROWSER lands
   * here after the hosted checkout page.
   *
   * Deliberately does NOT finalise. Peach and DeltaPay finalise on return
   * because they expose a server-side status query to re-verify against; Yoco
   * does not, so the only trustworthy outcome is the signed webhook. This
   * handler therefore just READS our own sale record and 302s to the SPA result
   * page with a display hint. The `ref` is a lookup hint only — a forged one
   * reveals nothing it wasn't already given and can mint nothing.
   */
  static async returnRedirect(req: Request, res: Response): Promise<any> {
    const raw = req.query['ref'];
    const ref = typeof raw === 'string' && raw ? raw : undefined;
    if (!ref) return res.redirect(302, paymentResultPageUrl());

    try {
      const sale = await TicketService.getYocoSaleByRef(ref);
      if (!sale?.yocoCheckoutId) return res.redirect(302, paymentResultPageUrl());

      return res.redirect(
        302,
        paymentResultRedirect(sale.yocoCheckoutId, displayStatus(sale.paymentStatus), 'yoco')
      );
    } catch (e) {
      // Best-effort display only — the page's authenticated poll is the backstop.
      console.error('[yoco return] lookup', e);
      return res.redirect(302, paymentResultPageUrl());
    }
  }
}
