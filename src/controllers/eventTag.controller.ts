// api/src/controllers/eventTag.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';
import { operatorMayActOnEvent } from '@services/operatorEventScope.service';
import { EventTagService } from '@services/eventTag.service';
import { WalletService } from '@services/wallet.service';
import { EventTagStatus } from '@interfaces/eventTag.interface';

/** Every registry action is bounded by the same two questions. */
async function loadRegisterableEvent(req: Request, res: Response): Promise<any | null> {
  const eventId = String(req.params['eventId']);

  // 1. Is this the caller's event at all, and is it even a cashless show?
  const event = await loadOwnedCashlessEvent(req, res, eventId);
  if (!event) return null;

  // 2. If the caller is an OPERATOR rather than the organizer, are they posted
  //    to this event? Without this a register-desk operator hired for Friday's
  //    show could enrol tags into Saturday's — both belong to the same vendor,
  //    so the ownership check above passes them straight through.
  if (!(await operatorMayActOnEvent(req, eventId))) {
    ApiResponseUtil.error(res, 'You are not assigned to this event', 403);
    return null;
  }

  return event;
}

/**
 * A bad uid, a tag that isn't in this register, or one already spoken for by a
 * ticket, is the operator's problem to fix and gets a 400 carrying the reader's
 * own words — each distinct, because at a busy desk they call for different
 * actions (retype it / register it / it is not a blank). Anything else — the
 * database being unreachable, say — is ours, and must not be dressed up as
 * "your input was wrong": the desk would sit there re-typing a uid that was
 * fine all along.
 */
function statusFor(err: unknown): number {
  const msg = (err as { message?: string })?.message ?? '';
  return /invalid band uid|not in this event|not registered for this event|belongs to a ticket/i.test(msg)
    ? 400
    : 500;
}

/** Who enrolled it — the operator row when there is one, else the organizer. */
function actorIdOf(req: Request): string | undefined {
  const ticketsUser = (req as any).ticketsUser;
  return (ticketsUser?.userId || ticketsUser?.vendorId) as string | undefined;
}

/**
 * The event's tag register: which physical NFC tags this organizer has enrolled
 * into this show. A tag that is not in here cannot be bound to a ticket and so
 * can never carry money at the event (see WalletService.bindBand) — which is
 * the whole point: someone walking in with a tag from another event, or one
 * they bought themselves, gets nothing.
 */
export class EventTagController {
  /** GET /api/tickets/events/:eventId/tags/registry */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const event = await loadRegisterableEvent(req, res);
      if (!event) return;

      const rawStatus = req.query['status'] ? String(req.query['status']) : undefined;
      if (rawStatus && rawStatus !== 'active' && rawStatus !== 'retired') {
        return ApiResponseUtil.badRequest(res, 'invalid status');
      }

      const rawLimit = req.query['limit'] ? Number(req.query['limit']) : undefined;
      if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1)) {
        return ApiResponseUtil.badRequest(res, 'invalid limit');
      }

      const rawSkip = req.query['skip'] ? Number(req.query['skip']) : undefined;
      if (rawSkip !== undefined && (!Number.isInteger(rawSkip) || rawSkip < 0)) {
        return ApiResponseUtil.badRequest(res, 'invalid skip');
      }

      return ApiResponseUtil.success(res, await EventTagService.list(String(event._id), {
        ...(rawStatus ? { status: rawStatus as EventTagStatus } : {}),
        ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
        ...(rawSkip !== undefined ? { skip: rawSkip } : {}),
        ...(req.query['q'] ? { q: String(req.query['q']) } : {}),
      }));
    } catch (err: any) {
      console.error('Tag registry list error:', err);
      return ApiResponseUtil.error(res, 'Failed to load the tag register', 500);
    }
  }

  /**
   * POST /api/tickets/events/:eventId/tags/registry
   *
   * Takes EITHER `{ bandUid }` — one tap at the Register desk — or
   * `{ bandUids: [...] }` — a list pasted in the dashboard from a tag order.
   */
  static async register(req: Request, res: Response): Promise<any> {
    try {
      const event = await loadRegisterableEvent(req, res);
      if (!event) return;

      const eventId = String(event._id);
      const actorId = actorIdOf(req);
      const { bandUid, bandUids } = req.body || {};

      if (Array.isArray(bandUids)) {
        if (!bandUids.length) return ApiResponseUtil.badRequest(res, 'bandUids must not be empty');
        if (bandUids.length > 1000) return ApiResponseUtil.badRequest(res, 'register at most 1000 tags at a time');
        const result = await EventTagService.registerTags({
          eventId,
          bandUids: bandUids.map(String),
          ...(actorId ? { registeredBy: actorId } : {}),
        });
        return ApiResponseUtil.success(res, result);
      }

      if (typeof bandUid !== 'string' || !bandUid.trim()) {
        return ApiResponseUtil.badRequest(res, 'bandUid is required');
      }

      const one = await EventTagService.registerTag({
        eventId,
        bandUid,
        ...(actorId ? { registeredBy: actorId } : {}),
      });

      // ONE TAP = ONE TAG GOING INTO SOMEBODY'S HAND. The POS Register loop
      // posts a single {bandUid} per scan, so that scan has to leave the tag
      // spendable — enrolling it and stopping there is what produced "No wallet
      // for that band/ticket" at the cashier. Doing it here rather than in the
      // app means the handhelds already in the field get it with no release.
      //
      // The bulk {bandUids} branch above deliberately does NOT do this: a
      // pasted tag order is stock nobody is carrying yet, and minting a wallet
      // per line would fill the Balances screen with tags still in the box.
      //
      // Not swallowed if it fails: the operator must not be told a tag is
      // registered when it cannot hold money. Both halves are idempotent, so
      // re-tapping recovers.
      const { wallet } = await WalletService.ensureStandaloneWalletForBand({
        eventId,
        bandUid: one.bandUid,
        acceptTicketBound: true,
        ...(actorId ? { issuedBy: actorId } : {}),
      });

      return ApiResponseUtil.success(res, {
        bandUid: one.bandUid,
        outcome: one.outcome,
        walletId: String(wallet._id),
        balance: wallet.balance,
        counts: await EventTagService.counts(eventId),
      });
    } catch (err: any) {
      console.error('Tag register error:', err);
      return ApiResponseUtil.error(res, err?.message || 'Failed to register the tag', statusFor(err));
    }
  }

  /**
   * POST /api/tickets/events/:eventId/tags/issue — `{ bandUid }`
   *
   * Hand a registered tag to somebody who has no ticket. The tag gets a wallet
   * of its own (design 2026-09-05), which is what makes it spendable: every
   * money path finds a wallet by {eventId, bandUid}, so before this the cashier
   * had nothing to top up and answered "No wallet for that band/ticket".
   *
   * Deliberately does NOT take an opening amount. Loading cash is the cashier
   * desk's job and already works once the wallet exists; recording a top-up
   * against a register-desk operator would need a new actor type in
   * TopupRecordedByType and in every report that groups by it.
   */
  static async issue(req: Request, res: Response): Promise<any> {
    try {
      const event = await loadRegisterableEvent(req, res);
      if (!event) return;

      const { bandUid } = req.body || {};
      if (typeof bandUid !== 'string' || !bandUid.trim()) {
        return ApiResponseUtil.badRequest(res, 'bandUid is required');
      }

      const { wallet, created } = await WalletService.ensureStandaloneWalletForBand({
        eventId: String(event._id),
        bandUid,
        // Same actor the register routes record — the operator row when there
        // is one, else the organizer.
        ...(actorIdOf(req) ? { issuedBy: actorIdOf(req) as string } : {}),
      });

      const body = {
        bandUid: wallet.bandUid,
        walletId: String(wallet._id),
        balance: wallet.balance,
        created,
      };
      // 201 only when a wallet was actually minted; a repeat tap is a 200 so the
      // desk can tell "issued" from "already issued" without reading the body.
      return created ? ApiResponseUtil.created(res, body) : ApiResponseUtil.success(res, body);
    } catch (err: any) {
      console.error('Tag issue error:', err);
      return ApiResponseUtil.error(res, err?.message || 'Failed to issue the tag', statusFor(err));
    }
  }

  /** POST /api/tickets/events/:eventId/tags/registry/retire — `{ bandUid, reason? }` */
  static async retire(req: Request, res: Response): Promise<any> {
    try {
      const event = await loadRegisterableEvent(req, res);
      if (!event) return;

      const { bandUid, reason } = req.body || {};
      if (typeof bandUid !== 'string' || !bandUid.trim()) {
        return ApiResponseUtil.badRequest(res, 'bandUid is required');
      }

      const { tag, releasedWalletId } = await EventTagService.retireTag({
        eventId: String(event._id),
        bandUid,
        ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
      });

      return ApiResponseUtil.success(res, {
        bandUid: tag.bandUid,
        status: tag.status,
        // Set when a wallet was wearing the tag and was released along with it,
        // so the UI can say "this attendee's tag was switched off".
        releasedWalletId,
        counts: await EventTagService.counts(String(event._id)),
      });
    } catch (err: any) {
      console.error('Tag retire error:', err);
      return ApiResponseUtil.error(res, err?.message || 'Failed to retire the tag', statusFor(err));
    }
  }
}
