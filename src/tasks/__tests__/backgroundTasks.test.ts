import * as cardSvc from '@services/ticket.service';
import * as reservationSvc from '@services/reservation.service';
import * as reminderSvc from '@services/eventReminder.service';
import * as transcodeClient from '@services/transcode.client';
import * as bookingSvc from '@services/transport/booking.service';
import * as menuOrderSvc from '@services/menuOrder.service';
import * as reconciliationSvc from '@services/reconciliation.service';
import { startBackgroundTasks } from '@/tasks/backgroundTasks';

/**
 * Every sweep is mocked so the real implementations don't fire real
 * (unconnected) DB queries in this fake-timers unit test.
 */
function mockAllSweeps() {
  return {
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

  it('schedules the card-reconcile sweep on its 60s interval', () => {
    const spies = mockAllSweeps();

    const handles = startBackgroundTasks();
    expect(handles.length).toBeGreaterThanOrEqual(6);
    jest.advanceTimersByTime(60_000);
    expect(spies.cardReconcile).toHaveBeenCalledTimes(1);
    expect(spies.bookingCardReconcile).toHaveBeenCalledTimes(1);
    expect(spies.bookingSweep).toHaveBeenCalledTimes(1);
    expect(spies.menuMomoReconcile).toHaveBeenCalledTimes(1);
    handles.forEach((h: NodeJS.Timeout) => clearInterval(h));
  });

  it('schedules the cashless ledger reconciliation sweep on its 15-minute interval', () => {
    const spies = mockAllSweeps();

    const handles = startBackgroundTasks();
    jest.advanceTimersByTime(15 * 60_000 - 1);
    expect(spies.cashlessReconcile).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(spies.cashlessReconcile).toHaveBeenCalledTimes(1);
    handles.forEach((h: NodeJS.Timeout) => clearInterval(h));
  });
});
