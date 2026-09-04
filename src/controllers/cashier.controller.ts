// api/src/controllers/cashier.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { ScanService } from '@services/scan.service';
import { bindBandSchema } from '@validators/tickets.validator';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Wallet } from '@models/wallet.model';
import { WalletService, WalletIdempotencyMismatchError } from '@services/wallet.service';
import { WalletDeclinedError } from '@services/merchant.service';
import { CashierService } from '@services/cashier.service';
import { normalizeBandUid } from '@utils/bandUid.util';
import { cashTopupSchema } from '@validators/reseller.validator';
import { cashierWithdrawSchema } from '@validators/cashier.validator';
import { CashierToken } from '@interfaces/cashier.interface';
import { resolveOperatorEventScope, operatorMayActOnEvent } from '@services/operatorEventScope.service';

/** Human-facing message per WalletDeclinedError reason, for the 402 envelope. */
const DECLINE_MESSAGE: Record<WalletDeclinedError['reason'], string> = {
  insufficient_balance: 'Insufficient balance',
  wallet_not_active: 'Wallet is not active',
  wallet_not_found: 'Wallet not found',
};

/**
 * Load a cashless, PUBLISHED event or send the right 4xx. Mirrors the lifecycle
 * guards in ResellerController.cashTopup / MerchantController.charge — a cashier
 * token must not move money at a non-cashless, cancelled, or not-yet-live event.
 *
 * Also the single chokepoint for the cashier's event assignment: every money
 * move (top-up, cash-out) loads its event through here, so the check cannot be
 * forgotten on a new one.
 */
async function loadCashlessEvent(req: Request, res: Response, eventId: string): Promise<any | null> {
  const event = await Event.findById(eventId).lean();
  if (!event) { ApiResponseUtil.error(res, 'Event not found', 404); return null; }
  if (!event.cashless) { ApiResponseUtil.error(res, 'Event is not cashless', 400); return null; }
  if (event.status !== EventStatus.PUBLISHED) { ApiResponseUtil.error(res, 'Event is not published', 400); return null; }
  if (!(await operatorMayActOnEvent(req, eventId))) {
    ApiResponseUtil.error(res, 'You are not assigned to this event', 403); return null;
  }
  return event;
}

export class CashierController {
  /**
   * GET /api/cashier/events — the cashless events this cashier can work. Scoped
   * to their organizer (vendorId) unless platform-scoped. The POS uses this to
   * pick which show's desk they're running.
   */
  /**
   * POST /api/cashier/bind-tag — the tag desk, for a cashier who has been
   * granted it (OperatorGrant.ISSUE_TAGS). Same ScanService call the gate uses;
   * the difference is only who is allowed to reach it and through which
   * middleware, since cashiers carry their own token vocabulary. Scoped to the
   * single event the cashier was hired for, so a granted cashier cannot bind a
   * tag on another of their organizer's events.
   */
  static async bindTag(req: Request, res: Response): Promise<any> {
    try {
      const cashier = (req as any).cashier as CashierToken;

      const { error, value } = bindBandSchema.validate(req.body);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      // Read from her ROW, not the token: the token lives for days with no DB
      // lookup, and resolveOperatorEventScope is where a deleted, deactivated
      // or event-less cashier fails closed to []. ScanService treats an empty
      // list as "unrestricted", so the denial has to be answered here.
      const allowedEventIds = await resolveOperatorEventScope(req);
      if (allowedEventIds && allowedEventIds.length === 0) {
        return ApiResponseUtil.error(res, 'You are not assigned to this event', 403);
      }

      const result = await ScanService.bindBandToTicket({
        ticketId: value.ticketId,
        bandUid: value.bandUid,
        vendorId: cashier.vendorId as string,
        isSuperAdmin: cashier.isSuperAdmin || false,
        expectedEventId: value.expectedEventId,
        allowedEventIds: allowedEventIds ?? undefined,
        boundBy: cashier.cashierId,
      });

      return ApiResponseUtil.success(res, result);
    } catch (err: any) {
      console.error('Cashier bind tag error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to issue tag', 400);
    }
  }

  static async getEvents(req: Request, res: Response): Promise<any> {
    try {
      const cashier = (req as any).cashier as CashierToken;
      const filter: Record<string, unknown> = { status: EventStatus.PUBLISHED, cashless: true };
      if (!cashier.isSuperAdmin) filter['vendorId'] = cashier.vendorId;
      const allowedEventIds = await resolveOperatorEventScope(req);
      if (allowedEventIds) filter['_id'] = { $in: allowedEventIds };
      const events = await Event.find(filter)
        .select('name venue eventDate cashless')
        .sort({ eventDate: 1 })
        .limit(100)
        .lean();
      return ApiResponseUtil.success(res, {
        events: events.map((e: any) => ({ id: String(e._id), name: e.name, venue: e.venue, eventDate: e.eventDate })),
      });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to fetch events', 500);
    }
  }

  /**
   * POST /api/cashier/topup — load cash onto a band's wallet. Same money move as
   * the reseller desk (WalletService.topUpCash), tagged recordedByType 'Cashier'
   * so it attributes to this cashier in reports and her own transactions.
   */
  static async topup(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = cashTopupSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const event = await loadCashlessEvent(req, res, value.eventId);
      if (!event) return;

      const cashier = (req as any).cashier as CashierToken;
      const wallet = value.bandUid
        ? await Wallet.findOne({ eventId: value.eventId, bandUid: normalizeBandUid(value.bandUid) })
        : await Wallet.findOne({ ticketId: value.ticketId, eventId: value.eventId });
      if (!wallet) return ApiResponseUtil.error(res, 'No wallet for that band/ticket', 404);

      const result = await WalletService.topUpCash({
        walletId: String(wallet._id),
        eventId: value.eventId,
        amount: value.amount,
        recordedBy: cashier.cashierId,
        recordedByType: 'Cashier',
        clientTxnId: value.clientTxnId,
      });
      return ApiResponseUtil.success(res, {
        newBalance: result.wallet.balance,
        amount: result.topup.amount,
      });
    } catch (e: any) {
      if (e instanceof WalletIdempotencyMismatchError) return ApiResponseUtil.error(res, e.message, 409);
      const msg = e?.message || 'Top-up failed';
      const status = /not active|not found|cashless|amount/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /**
   * POST /api/cashier/withdraw — hand cash back: debit the band's wallet and pay
   * the venue's cash float down (WalletService.withdrawCash). A decline (nothing
   * on the band) is a 402 with the current balance, never a 4xx/5xx, so the POS
   * can say "only R X left" rather than showing an error.
   */
  static async withdraw(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = cashierWithdrawSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const event = await loadCashlessEvent(req, res, value.eventId);
      if (!event) return;

      const cashier = (req as any).cashier as CashierToken;
      const bandUid = normalizeBandUid(value.bandUid);
      const wallet = await Wallet.findOne({ eventId: value.eventId, bandUid });
      if (!wallet) return ApiResponseUtil.notFound(res, 'No wallet for that band');

      const result = await WalletService.withdrawCash({
        walletId: String(wallet._id),
        eventId: value.eventId,
        amount: value.amount,
        recordedBy: cashier.cashierId,
        clientTxnId: value.clientTxnId,
      });
      return ApiResponseUtil.success(res, {
        newBalance: result.wallet.balance,
        amount: result.withdrawal.amount,
      });
    } catch (e: any) {
      if (e instanceof WalletIdempotencyMismatchError) return ApiResponseUtil.error(res, e.message, 409);
      if (e instanceof WalletDeclinedError) {
        return ApiResponseUtil.error(res, DECLINE_MESSAGE[e.reason], 402, {
          reason: e.reason,
          currentBalance: e.currentBalance,
        });
      }
      const msg = e?.message || 'Withdrawal failed';
      const status = /not found|cashless|amount|not active/i.test(msg) ? 400 : 500;
      return ApiResponseUtil.error(res, msg, status);
    }
  }

  /**
   * GET /api/cashier/balance?eventId=&bandUid= — tap a band, read its balance +
   * unified history (top-ups, withdrawals, purchases). Lets a cashier answer
   * "how much is left?" and verify a complaint.
   */
  static async balance(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.query.eventId || '');
      const rawUid = String(req.query.bandUid || '');
      if (!eventId || !rawUid) return ApiResponseUtil.error(res, 'eventId and bandUid are required', 400);
      if (!(await operatorMayActOnEvent(req, eventId))) {
        return ApiResponseUtil.error(res, 'You are not assigned to this event', 403);
      }
      const view = await WalletService.getWalletViewByBand(normalizeBandUid(rawUid), eventId);
      if (!view) return ApiResponseUtil.notFound(res, 'No wallet for that band');
      return ApiResponseUtil.success(res, view);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to read balance', 500);
    }
  }

  /**
   * GET /api/cashier/transactions?eventId=&limit= — this cashier's own top-ups +
   * withdrawals with status. cashierId comes ONLY from the JWT, never a query
   * param, so a cashier can never see another cashier's desk.
   */
  static async transactions(req: Request, res: Response): Promise<any> {
    try {
      const cashier = (req as any).cashier as CashierToken;
      const rawLimit = Number(req.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
      const eventId = req.query.eventId ? String(req.query.eventId) : undefined;
      const result = await CashierService.listTransactions({ cashierId: cashier.cashierId, eventId, limit });
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to load transactions', 500);
    }
  }
}
