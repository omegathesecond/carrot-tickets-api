import { Request, Response } from 'express';
import { TicketService } from '@services/ticket.service';
import { paymentResultPageUrl, paymentResultRedirect } from '@utils/paymentResult.util';

export class DeltapayController {
  /**
   * DeltaPay session callback (unauthenticated — DeltaPay pushes here).
   *
   * The body carries ONLY `{ checkout_session_id }` — no status, no amount, no
   * signature. That is by design: the callback tells us WHEN to check, never
   * WHAT the outcome was, so there is nothing here an attacker could forge into
   * a payment. finalizeDeltapaySale re-verifies with DeltaPay server-side.
   *
   * Always returns 200 so DeltaPay never retry-storms — mirrors CardController.webhook.
   */
  static async callback(req: Request, res: Response): Promise<any> {
    try {
      const sessionId: string | undefined =
        req.body?.checkout_session_id || req.body?.checkoutSessionId;

      if (sessionId) {
        try {
          await TicketService.finalizeDeltapaySale(sessionId);
        } catch (e) {
          // An unknown session id is not an emergency (it may belong to another
          // environment sharing the integration) — log and still answer 200.
          console.error('[deltapay callback] finalize', e);
        }
      }
    } catch (e) {
      console.error('[deltapay callback]', e);
    }

    return res.status(200).json({ status: 'received' });
  }

  /**
   * DeltaPay return_url target — the buyer's BROWSER lands here after the hosted
   * checkout page.
   *
   * Why a server endpoint rather than pointing return_url straight at the SPA:
   * the SPA is a static Cloudflare Pages site, so it cannot finalise anything.
   * Here we (1) finalise server-side — so the sale mints even if the callback
   * never fires and the buyer closes the tab — then (2) 302 the browser to the
   * SPA result page for display.
   *
   * DeltaPay appends the session id on the return; we accept the documented
   * `checkout_session_id` plus common aliases so a provider-side naming change
   * degrades to the generic result page instead of a blank error.
   */
  static async returnRedirect(req: Request, res: Response): Promise<any> {
    const raw =
      req.query['checkout_session_id'] ||
      req.query['checkoutSessionId'] ||
      req.query['session_id'] ||
      req.query['id'];
    const sessionId = typeof raw === 'string' && raw ? raw : undefined;

    if (!sessionId) {
      // No id — send the buyer to the result page anyway; it shows a generic state.
      return res.redirect(302, paymentResultPageUrl());
    }

    let status: 'completed' | 'failed' | 'pending' | undefined;
    try {
      ({ status } = await TicketService.finalizeDeltapaySale(sessionId));
    } catch (e) {
      // Best-effort: the SPA poll and the reconcile sweep are the backstops.
      console.error('[deltapay return] finalize', e);
    }

    return res.redirect(302, paymentResultRedirect(sessionId, status, 'deltapay'));
  }
}
