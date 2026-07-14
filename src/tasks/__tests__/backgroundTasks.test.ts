import * as cardSvc from '@services/ticket.service';
import * as reservationSvc from '@services/reservation.service';
import * as reminderSvc from '@services/eventReminder.service';
import * as transcodeClient from '@services/transcode.client';
import * as bookingSvc from '@services/transport/booking.service';
import { startBackgroundTasks } from '@/tasks/backgroundTasks';

describe('startBackgroundTasks', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  it('schedules the card-reconcile sweep on its 60s interval', () => {
    const spy = jest.spyOn(cardSvc.TicketService, 'reconcilePendingCardSales').mockResolvedValue(undefined as any);
    jest.spyOn(reservationSvc.ReservationService, 'sweepExpired').mockResolvedValue(undefined as any);
    jest.spyOn(reminderSvc.EventReminderService, 'sweep').mockResolvedValue(undefined as any);
    jest.spyOn(transcodeClient, 'reconcileStuckUpdates').mockResolvedValue(undefined as any);
    // Mocked so the real implementations don't fire real (unconnected) DB
    // queries in this fake-timers unit test — mirrors every other sweep above.
    const bookingCardReconcileSpy = jest.spyOn(bookingSvc.BookingService, 'reconcilePendingCardBookings').mockResolvedValue(undefined as any);
    const bookingSweepSpy = jest.spyOn(bookingSvc.BookingService, 'sweepExpiredBookings').mockResolvedValue(undefined as any);

    const handles = startBackgroundTasks();
    expect(handles.length).toBeGreaterThanOrEqual(6);
    jest.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bookingCardReconcileSpy).toHaveBeenCalledTimes(1);
    expect(bookingSweepSpy).toHaveBeenCalledTimes(1);
    handles.forEach((h: NodeJS.Timeout) => clearInterval(h));
  });
});
