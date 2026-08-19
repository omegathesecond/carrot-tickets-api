import { ReservationService } from '@services/reservation.service';
import { TicketService } from '@services/ticket.service';
import { EventReminderService } from '@services/eventReminder.service';
import { reconcileStuckUpdates } from '@services/transcode.client';
import { BookingService } from '@services/transport/booking.service';

// Start the reservation expiry sweep
const RESERVATION_SWEEP_MS = 60_000;

// Reconcile paid-but-stuck Peach card sales (return endpoint + webhook +
// poll all missed). Runs ahead of the 15-min reservation expiry so a paid
// sale is minted, never failed. See TicketService.reconcilePendingCardSales.
const CARD_RECONCILE_MS = 60_000;

// Reconcile paid-but-stuck DeltaPay sales (return redirect + session callback +
// poll all missed). Runs ahead of the 12-min reservation hold so a paid sale is
// minted, never failed. See TicketService.reconcilePendingDeltapaySales.
const DELTAPAY_RECONCILE_MS = 60_000;

// Yoco: report (never resolve) sales stuck PENDING because no signed webhook
// arrived. Yoco has NO status-query endpoint, so unlike the card/DeltaPay
// reconcilers above this one cannot ask the provider what happened — it makes
// the sale loud for manual recovery instead. See
// TicketService.reportStuckYocoSales and the ReservationService.sweepExpired
// carve-out that keeps such sales PENDING.
const YOCO_STUCK_REPORT_MS = 300_000;

// Event reminders (spec §6): T-24h and day-of pushes for ticket holders.
const REMINDER_SWEEP_MS = 600_000;

// Discover feed: re-trigger or fail-loud-fail video updates stuck in
// 'processing' (transcoder crashed/never called back). See
// @services/transcode.client#reconcileStuckUpdates.
const UPDATE_RECONCILE_MS = 120_000;

// Bus bookings: reconcile paid-but-stuck Peach card bookings (mirrors
// CARD_RECONCILE_MS above) + sweep expired PENDING bookings whose
// reservation hold lapsed (releases seat/GA capacity, marks FAILED/CANCELLED).
// See BookingService.reconcilePendingCardBookings / sweepExpiredBookings.
const BOOKING_CARD_RECONCILE_MS = 60_000;
const BOOKING_SWEEP_MS = 60_000;

/**
 * Registers all periodic background sweeps (reservation expiry, card-sale
 * reconciliation, event reminders, stuck-update reconciliation) with their
 * existing intervals. Returns the interval handles so callers (tests,
 * graceful shutdown) can inspect or clear them.
 *
 * Behavior-preserving move out of src/app.ts — same functions, same
 * intervals, same error-logging; only the wiring moved.
 */
export function startBackgroundTasks(): NodeJS.Timeout[] {
  const handles: NodeJS.Timeout[] = [];

  handles.push(setInterval(() => {
    ReservationService.sweepExpired().catch(err => console.error('[reservation-sweep] error', err));
  }, RESERVATION_SWEEP_MS));

  handles.push(setInterval(() => {
    TicketService.reconcilePendingCardSales().catch(err => console.error('[card-reconcile] error', err));
  }, CARD_RECONCILE_MS));

  handles.push(setInterval(() => {
    TicketService.reconcilePendingDeltapaySales().catch(err => console.error('[deltapay-reconcile] error', err));
  }, DELTAPAY_RECONCILE_MS));

  handles.push(setInterval(() => {
    TicketService.reportStuckYocoSales().catch(err => console.error('[yoco-stuck] error', err));
  }, YOCO_STUCK_REPORT_MS));

  handles.push(setInterval(() => {
    EventReminderService.sweep().catch((err) => console.error('[reminder-sweep] error', err));
  }, REMINDER_SWEEP_MS));

  handles.push(setInterval(() => {
    reconcileStuckUpdates().catch((e) => console.error('update reconcile sweep failed:', e?.message));
  }, UPDATE_RECONCILE_MS));

  handles.push(setInterval(() => {
    BookingService.reconcilePendingCardBookings().catch(err => console.error('[booking card-reconcile] error', err));
  }, BOOKING_CARD_RECONCILE_MS));

  handles.push(setInterval(() => {
    BookingService.sweepExpiredBookings().catch(err => console.error('[booking sweep] error', err));
  }, BOOKING_SWEEP_MS));

  return handles;
}
