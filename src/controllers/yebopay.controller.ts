import { Request, Response } from 'express';
import { YeboPayClient, classifyEventType } from '@services/payments/yebopay.client';
import { TicketService } from '@services/ticket.service';
import { paymentResultPageUrl } from '@utils/paymentResult.util';

export class YeboPayController {
  /**
   * YeboPay webhook receiver (unauthenticated transport — authenticity comes
   * from the `YeboPay-Signature` HMAC over the raw body, not from any
   * credential on the connection).
   *
   * A VERIFIED request always answers 200, even if finalisation throws, so
   * YeboPay doesn't retry-storm us — mirrors CardController/YocoController.
   * An unsigned or wrongly signed body is rejected 401 and never reaches the
   * finalizer.
   *
   * Unlike the Yoco rail this is NOT the only path that can mint a ticket:
   * YeboPay publishes a status endpoint, so the return handler and the
   * reconcile sweep can both resolve a sale by asking. That redundancy is
   * deliberate — YeboPay webhook delivery has no automatic retry, so a single
   * dropped POST must not strand a paid sale.
   */
  static async webhook(req: Request, res: Response): Promise<any> {
    // req.rawBody is captured by the express.json({ verify }) hook in app.ts —
    // the signature covers the EXACT bytes YeboPay sent, so a re-serialised
    // req.body would not verify.
    const rawBody = (req as any).rawBody;
    const ok =
      typeof rawBody === 'string' &&
      new YeboPayClient().verifyWebhook({
        rawBody,
        signatureHeader: String(req.headers['yebopay-signature'] || ''),
      });

    if (!ok) {
      console.error('[yebopay webhook] signature verification FAILED — rejecting');
      return res.status(401).json({ error: 'invalid signature' });
    }

    try {
      // Envelope: { id, type, created, data: { ... } }
      const type = String(req.body?.type || '');
      const data = req.body?.data || {};
      // checkout.* events carry the checkout itself, so data.id IS the checkout id.
      const checkoutId: string | undefined = data?.id;

      // Only terminal checkout events move a sale. charge.* is deliberately
      // ignored here: on YeboPay a declined card is NOT terminal (the buyer can
      // retry in place), so failing the sale on charge.failed would cancel an
      // order still being paid for. classifyEventType fails closed.
      if (checkoutId && classifyEventType(type) !== 'ignore') {
        try {
          await TicketService.finalizeYeboPaySale(checkoutId, {
            type,
            amount: data.amount,
            currency: String(data.currency || ''),
          });
        } catch (e) {
          // An unknown checkout id is not an emergency (it may belong to another
          // environment sharing the merchant) — log and still answer 200.
          console.error('[yebopay webhook] finalize', e);
        }
      }
    } catch (e) {
      console.error('[yebopay webhook]', e);
    }

    return res.status(200).json({ ok: true });
  }

  /**
   * YeboPay successUrl / cancelUrl target — the buyer's BROWSER lands here
   * after the hosted checkout page.
   *
   * Unlike the Yoco return handler, this one DOES finalise, because YeboPay
   * publishes `GET /v1/checkouts/:id` to re-verify against — the same reason
   * the Peach and DeltaPay return handlers finalise. It matters here: YeboPay
   * webhooks are not retried, so resolving on return is what turns a dropped
   * delivery from a stranded sale into a non-event.
   *
   * It finalises but deliberately REPORTS NOTHING. This endpoint is
   * unauthenticated and `ref` is not secret — it is sent to YeboPay as
   * metadata. Echoing the sale's status back would let anyone turn a known or
   * guessed ref into "does this sale exist, and was it paid?". So the response
   * is byte-identical for a real ref, a forged ref and no ref at all.
   *
   * The buyer's actual outcome comes from the authenticated latest-status
   * endpoint, which reads THEIR OWN most recent sale.
   */
  static async returnRedirect(req: Request, res: Response): Promise<any> {
    const ref = typeof req.query['ref'] === 'string' ? req.query['ref'] : undefined;

    if (ref) {
      try {
        const sale = await TicketService.getYeboPaySaleByRef(ref);
        if (sale?.yebopayCheckoutId) {
          // Ask YeboPay rather than trusting the redirect: a buyer can reach
          // this URL by hand, or bail out before paying.
          const remote = await new YeboPayClient().getCheckout(sale.yebopayCheckoutId);
          await TicketService.finalizeYeboPaySale(sale.yebopayCheckoutId, {
            type: remote.status === 'COMPLETED' ? 'checkout.completed' : 'checkout.expired',
            amount: remote.amount ?? 0,
            currency: String(remote.currency || ''),
          });
        }
      } catch (e) {
        // Never block the redirect on this: the webhook and the reconcile sweep
        // are both still behind it. The buyer must always reach a result page.
        console.error('[yebopay return] finalize', e);
      }
    }

    return res.redirect(302, `${paymentResultPageUrl()}?method=yebopay`);
  }
}
