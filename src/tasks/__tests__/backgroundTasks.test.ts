import * as cardSvc from '@services/ticket.service';
import * as reservationSvc from '@services/reservation.service';
import * as reminderSvc from '@services/eventReminder.service';
import * as transcodeClient from '@services/transcode.client';
import * as bookingSvc from '@services/transport/booking.service';
import * as menuOrderSvc from '@services/menuOrder.service';
import * as reconciliationSvc from '@services/reconciliation.service';
import { AccountActivityDigestService } from '@services/accountActivityDigest.service';
import { VoteNotificationService } from '@services/voteNotification.service';
import { WeekendReminderService } from '@services/weekendReminder.service';
import { WeekendService } from '@services/weekend.service';
import { ShareEarnService } from '@services/shareEarn.service';
import { startBackgroundTasks } from '@/tasks/backgroundTasks';

/**
 * Every sweep is mocked so the real implementations don't fire real
 * (unconnected) DB queries in this fake-timers unit test.
 */
function mockAllSweeps() {
  return {
    deltapay: jest.spyOn(cardSvc.TicketService, 'reconcilePendingDeltapaySales').mockResolvedValue(undefined as any),
    momo: jest.spyOn(cardSvc.TicketService, 'reconcilePendingMomoSales').mockResolvedValue(undefined as any),
    yoco: jest.spyOn(cardSvc.TicketService, 'reportStuckYocoSales').mockResolvedValue(undefined as any),
    yebopay: jest.spyOn(cardSvc.TicketService, 'reconcilePendingYeboPaySales').mockResolvedValue(undefined as any),
    digest: jest.spyOn(AccountActivityDigestService, 'sweep').mockResolvedValue(undefined as any),
    vote: jest.spyOn(VoteNotificationService, 'sweep').mockResolvedValue(undefined as any),
    weekendReminder: jest.spyOn(WeekendReminderService, 'sweep').mockResolvedValue(undefined as any),
    weekend: jest.spyOn(WeekendService, 'sweepCancelledEventLinks').mockResolvedValue(undefined as any),
    shareClose: jest.spyOn(ShareEarnService, 'autoCloseExpiredCampaigns').mockResolvedValue(undefined as any),
    shareNotify: jest.spyOn(ShareEarnService, 'notifyCampaignsClosingSoon').mockResolvedValue(undefined as any),

    cardReconcile: jest.spyOn(cardSvc.TicketService, 'reconcilePendingCardSales').mockResolvedValue(undefined as any),
    reservationSweep: jest.spyOn(reservationSvc.ReservationService, 'sweepExpired').mockResolvedValue(undefined as any),
    reminderSweep: jest.spyOn(reminderSvc.EventReminderService, 'sweep').mockResolvedValue(undefined as any),
    updateReconcile: jest.spyOn(transcodeClient, 'reconcileStuckUpdates').mockResolvedValue(undefined as any),
    storyReconcile: jest.spyOn(transcodeClient, 'reconcileStuckStories').mockResolvedValue(undefined as any),
    bookingCardReconcile: jest.spyOn(bookingSvc.BookingService, 'reconcilePendingCardBookings').mockResolvedValue(undefined as any),
    bookingSweep: jest.spyOn(bookingSvc.BookingService, 'sweepExpiredBookings').mockResolvedValue(undefined as any),
    // Menu preorders paid by MoMo whose callback never arrived — same 60s
    // cadence as the ticket MoMo/card reconcilers.
    menuMomoReconcile: jest.spyOn(menuOrderSvc.MenuOrderService, 'reconcilePendingMomoOrders').mockResolvedValue(undefined as any),
    // Cashless ledger reconciliation over recently-ended cashless events.
    cashlessReconcile: jest.spyOn(reconciliationSvc.ReconciliationService, 'sweepRecentCashlessEvents').mockResolvedValue(undefined as any),
  };
}

describe('startBackgroundTasks', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  it('schedules the card-reconcile sweep on its 60s interval', async () => {
    const spies = mockAllSweeps();

    const handles = startBackgroundTasks();
    expect(handles.length).toBeGreaterThanOrEqual(6);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(spies.cardReconcile).toHaveBeenCalledTimes(1);
    expect(spies.bookingCardReconcile).toHaveBeenCalledTimes(1);
    expect(spies.bookingSweep).toHaveBeenCalledTimes(1);
    expect(spies.menuMomoReconcile).toHaveBeenCalledTimes(1);
    handles.forEach((h: NodeJS.Timeout) => clearInterval(h));
  });

  it('schedules the cashless ledger reconciliation sweep on its 15-minute interval', async () => {
    const spies = mockAllSweeps();

    const handles = startBackgroundTasks();
    await jest.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(spies.cashlessReconcile).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(spies.cashlessReconcile).toHaveBeenCalledTimes(1);
    handles.forEach((h: NodeJS.Timeout) => clearInterval(h));
  });
});
