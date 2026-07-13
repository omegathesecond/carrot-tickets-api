import mongoose from 'mongoose';
import { Trip } from '@models/transport/trip.model';
import { Seat } from '@models/transport/seat.model';
import { Route } from '@models/transport/route.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { BoardingScan } from '@models/transport/boardingScan.model';
import { Reseller } from '@models/reseller.model';
import { SeatScheme, TripStatus } from '@interfaces/transport.interface';
import { IBooking, IBookingSale, BookingStatus, BoardingScanResult } from '@interfaces/booking.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { getProcessor } from '@services/payments';
import { computeSaleEconomics, SaleSoldByType } from '@services/saleEconomics.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { deriveChannel } from '@services/ticket.service';
import { normalizePhone } from '@utils/phone.util';
import { HttpError } from '@utils/httpError.util';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';

const SYNC_METHODS: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.KESHLESS_WALLET];

const SOLD_BY_MAP: Record<'vendor' | 'sub-user' | 'reseller-operator', SaleSoldByType> = {
  vendor: 'Vendor',
  'sub-user': 'VendorSubUser',
  'reseller-operator': 'ResellerOperator',
};

export interface SellSeatParams {
  tripId: string;
  seatNumber?: string; // required for seat-mapped, omitted for PASSENGER_COUNT
  passengerName: string;
  passengerPhone: string;
  paymentMethod: PaymentMethod;
  keshlessCardNumber?: string;
  keshlessPin?: string;
  soldBy: string;
  soldByType: 'vendor' | 'sub-user' | 'reseller-operator';
  resellerId?: string;
  hubId?: string;
  resellerCommissionPercent?: number;
}

export class BookingService {
  private static momoClient = new MtnMomoClient();
  private static MOMO_TTL_MS = 5 * 60_000;

  /** Atomically claim capacity for a booking; throws HttpError(409) if unavailable. Shared by sellSeat + async initiate. */
  private static async claimCapacity(trip: any, isSeatMapped: boolean, seatNumber: string | undefined, bookingId: any): Promise<void> {
    if (isSeatMapped) {
      if (!seatNumber) throw new HttpError(400, 'seatNumber is required for this vehicle');
      const seat = await Seat.findOneAndUpdate(
        { tripId: trip._id, seatNumber, isBooked: false, isReserved: false },
        { $set: { isBooked: true, bookingId } }, { new: true },
      );
      if (!seat) throw new HttpError(409, 'Seat is already booked or reserved');
    } else {
      const claimed = await Trip.findOneAndUpdate(
        { _id: trip._id, status: { $in: [TripStatus.SCHEDULED, TripStatus.BOARDING] }, $expr: { $lt: [{ $add: ['$soldCount', '$reservedCount'] }, '$totalSeats'] } },
        { $inc: { soldCount: 1 } }, { new: true },
      );
      if (!claimed) throw new HttpError(409, 'Trip is fully booked');
    }
  }

  /** Release a claim tied to a specific booking (seat-mapped: free the seat; passenger-count: decrement soldCount). */
  private static async releaseBookingClaim(booking: IBooking, isSeatMapped: boolean): Promise<void> {
    if (isSeatMapped) {
      await Seat.updateOne({ tripId: booking.tripId, seatNumber: booking.seatNumber, bookingId: booking._id }, { $set: { isBooked: false }, $unset: { bookingId: '' } });
    } else {
      await Trip.updateOne({ _id: booking.tripId }, { $inc: { soldCount: -1 } });
    }
  }

  static async initiateMomoBooking(p: {
    tripId: string; seatNumber?: string; passengerName: string; passengerPhone: string; momoPhone: string;
    soldBy: string; soldByType: 'vendor' | 'sub-user' | 'reseller-operator'; resellerId?: string; hubId?: string;
  }): Promise<{ referenceId: string; saleId: string; expiresAt: Date }> {
    if (!this.momoClient.isConfigured()) throw new HttpError(503, 'MTN MoMo is not available');

    const trip = await Trip.findById(p.tripId);
    if (!trip) throw new HttpError(404, 'Trip not found');
    if (![TripStatus.SCHEDULED, TripStatus.BOARDING].includes(trip.status)) throw new HttpError(422, 'Trip is not open for sale');
    const isSeatMapped = trip.seatScheme !== SeatScheme.PASSENGER_COUNT;

    const route = await Route.findById(trip.routeId).select('farePerSeat');
    if (!route) throw new HttpError(404, 'Route not found');
    const fare = route.farePerSeat;

    const cfg = await PaymentConfigService.get();
    if (!cfg.mtnMomoEnabled) throw new HttpError(400, 'MoMo is not enabled');
    let resolvedCommission = cfg.defaultResellerCommissionPercent;
    if (p.resellerId) {
      const reseller = await Reseller.findById(p.resellerId).select('status isActive commissionPercent');
      if (!reseller) throw new HttpError(404, 'Reseller not found');
      if (reseller.status === 'suspended' || reseller.isActive === false) throw new HttpError(403, 'Reseller account is suspended');
      resolvedCommission = reseller.commissionPercent ?? cfg.defaultResellerCommissionPercent;
    }
    const mappedSoldByType = SOLD_BY_MAP[p.soldByType];
    const econ = computeSaleEconomics({ faceAmount: fare, paymentMethod: PaymentMethod.MTN_MOMO as any, soldByType: mappedSoldByType, resellerCommissionPercent: resolvedCommission, platformFeePercent: cfg.platformFeePercent });

    const booking = new Booking({ tripId: trip._id, vendorId: trip.vendorId, passengerName: p.passengerName, passengerPhone: normalizePhone(p.passengerPhone), seatNumber: isSeatMapped ? p.seatNumber : undefined, fareAmount: fare, platformFee: econ.platformFeeAmount, totalAmount: fare, status: BookingStatus.PENDING });
    await this.claimCapacity(trip, isSeatMapped, p.seatNumber, booking._id);

    // seat-mapped claimCapacity can't filter on trip status inline (it only
    // scopes by tripId/seatNumber/isBooked/isReserved), so mirror sellSeat's
    // post-claim recheck: a trip that left the sellable window between our
    // initial load and this claim would otherwise slip through.
    if (isSeatMapped) {
      const freshTrip = await Trip.findById(trip._id).select('status');
      if (!freshTrip || ![TripStatus.SCHEDULED, TripStatus.BOARDING].includes(freshTrip.status)) {
        await this.releaseBookingClaim(booking, isSeatMapped);
        throw new HttpError(422, 'Trip is no longer open for sale');
      }
    }

    const expiresAt = new Date(Date.now() + this.MOMO_TTL_MS);
    let sale;
    try {
      await booking.save();
      sale = await BookingSale.create({
        tripId: trip._id, vendorId: trip.vendorId, bookingIds: [booking._id], quantity: 1,
        customerName: p.passengerName, customerPhone: booking.passengerPhone, totalAmount: fare,
        paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.PENDING, reservationExpiresAt: expiresAt,
        soldBy: p.soldBy, soldByType: mappedSoldByType, channel: deriveChannel(mappedSoldByType),
        ...(p.resellerId ? { resellerId: p.resellerId } : {}), ...(p.hubId ? { hubId: p.hubId } : {}),
        faceAmount: fare, serviceFeeAmount: 0, amountCharged: fare,
        resellerCommissionPercent: econ.resellerCommissionPercent, resellerCommissionAmount: econ.resellerCommissionAmount,
        platformFeePercent: econ.platformFeePercent, platformFeeAmount: econ.platformFeeAmount,
        organizerProceeds: econ.organizerProceeds, fundsCustody: econ.fundsCustody, soldAt: new Date(),
      });
      booking.saleId = sale._id as any;
      await booking.save();
    } catch (err) {
      await this.releaseBookingClaim(booking, isSeatMapped);
      await Booking.updateOne({ _id: booking._id }, { $set: { status: BookingStatus.CANCELLED } }).catch(() => {});
      throw err;
    }

    try {
      const currency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
      const payerMsisdn = normalizePhone(p.momoPhone).replace(/^\+/, '');
      const { referenceId } = await this.momoClient.requestToPay({ amount: fare, currency, payerMsisdn, externalId: sale.saleRef, payerMessage: `Bus seat ${p.seatNumber ?? 'GA'}` });
      sale.momoReferenceId = referenceId;
      await sale.save();
      return { referenceId, saleId: sale._id.toString(), expiresAt };
    } catch (err) {
      await this.releaseBookingClaim(booking, isSeatMapped);
      booking.status = BookingStatus.CANCELLED; await booking.save();
      sale.paymentStatus = PaymentStatus.FAILED; await sale.save();
      throw err;
    }
  }

  static async sellSeat(p: SellSeatParams): Promise<{ booking: IBooking; sale: IBookingSale }> {
    if (!SYNC_METHODS.includes(p.paymentMethod)) {
      throw new HttpError(400, `Payment method ${p.paymentMethod} is not yet supported for bus bookings`);
    }

    const trip = await Trip.findById(p.tripId);
    if (!trip) throw new HttpError(404, 'Trip not found');
    if (![TripStatus.SCHEDULED, TripStatus.BOARDING].includes(trip.status)) {
      throw new HttpError(422, 'Trip is not open for sale');
    }
    // seatScheme is snapshotted onto the Trip itself (SP1a) — no VehicleType
    // populate needed, and it stays correct even if the vehicle type changes later.
    const isSeatMapped = trip.seatScheme !== SeatScheme.PASSENGER_COUNT;

    const route = await Route.findById(trip.routeId).select('farePerSeat');
    if (!route) throw new HttpError(404, 'Route not found');
    const fare = route.farePerSeat;

    // ── Economic snapshot (reused DRY helper) ─────────────────────
    // Read-only — computed BEFORE any claim is taken, so a config-read
    // failure here never leaves a seat/capacity claim dangling.
    const cfg = await PaymentConfigService.get();

    // Guard: payment method must be enabled in PaymentConfig (mirrors
    // ResellerSaleService's toggle check). Only cash/keshless_wallet reach
    // here — async methods already 400'd above. Fail BEFORE claiming.
    const METHOD_TOGGLE: Record<string, keyof typeof cfg> = { cash: 'cashEnabled', keshless_wallet: 'keshlessWalletEnabled' };
    const toggle = METHOD_TOGGLE[p.paymentMethod];
    if (toggle && !cfg[toggle]) throw new HttpError(400, 'Payment method is not enabled');

    // Guard + resolve commission: reseller must exist and not be suspended.
    // Reseller-specific commission takes precedence over the platform default.
    let resolvedCommission = p.resellerCommissionPercent ?? cfg.defaultResellerCommissionPercent;
    if (p.resellerId) {
      const reseller = await Reseller.findById(p.resellerId).select('status isActive commissionPercent');
      if (!reseller) throw new HttpError(404, 'Reseller not found');
      if (reseller.status === 'suspended' || reseller.isActive === false) throw new HttpError(403, 'Reseller account is suspended');
      resolvedCommission = reseller.commissionPercent ?? cfg.defaultResellerCommissionPercent;
    }

    const mappedSoldByType = SOLD_BY_MAP[p.soldByType];
    const econ = computeSaleEconomics({
      faceAmount: fare,
      paymentMethod: p.paymentMethod as any,
      soldByType: mappedSoldByType,
      resellerCommissionPercent: resolvedCommission,
      platformFeePercent: cfg.platformFeePercent,
    });

    // Pre-allocate the booking id so we can stamp it on the seat during the atomic claim.
    const booking = new Booking({
      tripId: trip._id,
      vendorId: trip.vendorId,
      passengerName: p.passengerName,
      passengerPhone: normalizePhone(p.passengerPhone),
      seatNumber: isSeatMapped ? p.seatNumber : undefined,
      fareAmount: fare,
      platformFee: econ.platformFeeAmount,
      totalAmount: fare,
      status: BookingStatus.PENDING,
    });

    // releaseClaim is defined BEFORE the claim itself is taken so the
    // seat-mapped branch below can call it immediately after a successful
    // claim if the post-claim trip-status recheck fails.
    const releaseClaim = async () => {
      if (isSeatMapped) {
        await Seat.updateOne(
          { tripId: trip._id, seatNumber: p.seatNumber, bookingId: booking._id },
          { $set: { isBooked: false }, $unset: { bookingId: '' } },
        );
      } else {
        await Trip.updateOne({ _id: trip._id }, { $inc: { soldCount: -1 } });
      }
    };

    // ── Atomic capacity claim ─────────────────────────────────────
    if (isSeatMapped) {
      if (!p.seatNumber) throw new HttpError(400, 'seatNumber is required for this vehicle');
      const seat = await Seat.findOneAndUpdate(
        { tripId: trip._id, seatNumber: p.seatNumber, isBooked: false, isReserved: false },
        { $set: { isBooked: true, bookingId: booking._id } },
        { new: true },
      );
      if (!seat) throw new HttpError(409, 'Seat is already booked or reserved');

      // Seat.findOneAndUpdate above can't filter on trip status inline (it
      // only scopes by tripId/seatNumber/isBooked/isReserved), so a trip
      // that left the sellable window between our initial load and this
      // claim would otherwise slip through. Re-check and release+422 if so.
      const freshTrip = await Trip.findById(trip._id).select('status');
      if (!freshTrip || ![TripStatus.SCHEDULED, TripStatus.BOARDING].includes(freshTrip.status)) {
        await releaseClaim();
        throw new HttpError(422, 'Trip is no longer open for sale');
      }
    } else {
      const claimed = await Trip.findOneAndUpdate(
        {
          _id: trip._id,
          status: { $in: [TripStatus.SCHEDULED, TripStatus.BOARDING] },
          $expr: { $lt: [{ $add: ['$soldCount', '$reservedCount'] }, '$totalSeats'] },
        },
        { $inc: { soldCount: 1 } },
        { new: true },
      );
      if (!claimed) throw new HttpError(409, 'Trip is fully booked');
    }

    // ── Zone A (pre-money): charge, release the claim on ANY failure ──
    let walletTransactionId: string | undefined;
    try {
      const charge = await getProcessor(p.paymentMethod).charge({
        method: p.paymentMethod,
        amount: fare, // POS stays at face; no service fee
        description: `Carrot Tickets bus - seat ${p.seatNumber ?? 'GA'}`,
        keshlessCardNumber: p.keshlessCardNumber,
        keshlessPin: p.keshlessPin,
      });
      if (charge.status !== 'completed') throw new HttpError(402, charge.message || 'Payment failed');
      walletTransactionId = charge.providerRef;
    } catch (err) {
      await releaseClaim();
      throw err;
    }

    // ── Zone B (money captured — DO NOT release on failure here) ──────
    // Once the charge has completed, the claim must stay held: releasing it
    // would let the seat/capacity be re-sold while we've already taken the
    // customer's money. Any throw below needs manual reconciliation instead.
    try {
      booking.status = BookingStatus.CONFIRMED;
      await booking.save();

      const sale = await BookingSale.create({
        tripId: trip._id,
        vendorId: trip.vendorId,
        bookingIds: [booking._id],
        quantity: 1,
        customerName: p.passengerName,
        customerPhone: booking.passengerPhone,
        totalAmount: fare,
        paymentMethod: p.paymentMethod,
        paymentStatus: PaymentStatus.COMPLETED,
        walletTransactionId,
        soldBy: p.soldBy,
        soldByType: mappedSoldByType,
        channel: deriveChannel(mappedSoldByType),
        ...(p.resellerId ? { resellerId: p.resellerId } : {}),
        ...(p.hubId ? { hubId: p.hubId } : {}),
        faceAmount: fare,
        serviceFeeAmount: 0,
        amountCharged: fare,
        resellerCommissionPercent: econ.resellerCommissionPercent,
        resellerCommissionAmount: econ.resellerCommissionAmount,
        platformFeePercent: econ.platformFeePercent,
        platformFeeAmount: econ.platformFeeAmount,
        organizerProceeds: econ.organizerProceeds,
        fundsCustody: econ.fundsCustody,
        soldAt: new Date(),
      });

      booking.saleId = sale._id as any;
      await booking.save();

      return { booking, sale: sale as IBookingSale };
    } catch (err) {
      console.error(
        '[booking sell] payment captured but persistence failed — seat remains claimed, needs reconciliation',
        {
          tripId: String(trip._id),
          seatNumber: p.seatNumber,
          bookingRef: booking.bookingRef,
          error: err instanceof Error ? err.message : err,
        },
      );
      throw err;
    }
  }

  static async getMomoBookingSaleByReference(referenceId: string) {
    return BookingSale.findOne({ momoReferenceId: referenceId });
  }

  /**
   * Finalize an async MTN MoMo bus booking identified by referenceId. Idempotent.
   * Mirrors TicketService.finalizeMomoSale: not-PENDING → return current status;
   * PENDING → pending; FAILED → release claim + cancel booking + fail sale;
   * SUCCESSFUL → amount/currency guard then ATOMIC claim via
   * findOneAndUpdate({_id, paymentStatus:PENDING}) so a concurrent poll +
   * callback can't double-confirm.
   */
  static async finalizeMomoBooking(referenceId: string): Promise<{ status: 'completed' | 'failed' | 'pending'; reason?: string }> {
    const sale = await BookingSale.findOne({ momoReferenceId: referenceId });
    if (!sale) throw new HttpError(404, 'Booking sale not found for reference');
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return sale.paymentStatus === PaymentStatus.COMPLETED ? { status: 'completed' } : { status: 'failed', reason: sale.momoFailureReason };
    }

    const booking = await Booking.findById(sale.bookingIds[0]);
    if (!booking) throw new HttpError(404, 'Booking not found for sale');
    const trip = await Trip.findById(booking.tripId).select('seatScheme');
    const isSeatMapped = trip?.seatScheme !== SeatScheme.PASSENGER_COUNT;

    const { status, raw } = await this.momoClient.getStatus(referenceId);
    if (status === 'PENDING') return { status: 'pending' };

    if (status === 'FAILED') {
      const reason = typeof raw?.reason === 'string' ? raw.reason : undefined;
      await this.releaseBookingClaim(booking, isSeatMapped);
      booking.status = BookingStatus.CANCELLED; await booking.save();
      sale.paymentStatus = PaymentStatus.FAILED; if (reason) sale.momoFailureReason = reason; await sale.save();
      return { status: 'failed', reason };
    }

    // SUCCESSFUL — amount + currency guard before confirming
    const expectedCurrency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
    const expectedAmount = sale.amountCharged ?? sale.totalAmount;
    const confirmedAmount = Number(raw?.amount);
    if (!Number.isFinite(confirmedAmount) || confirmedAmount !== expectedAmount || raw?.currency !== expectedCurrency) {
      await this.releaseBookingClaim(booking, isSeatMapped);
      booking.status = BookingStatus.CANCELLED; await booking.save();
      sale.paymentStatus = PaymentStatus.FAILED; sale.momoFailureReason = 'AMOUNT_MISMATCH'; await sale.save();
      return { status: 'failed', reason: 'AMOUNT_MISMATCH' };
    }

    // atomic claim — concurrent poll + callback can't double-confirm
    const claimed = await BookingSale.findOneAndUpdate({ _id: sale._id, paymentStatus: PaymentStatus.PENDING }, { $set: { paymentStatus: PaymentStatus.COMPLETED } }, { new: true });
    if (!claimed) return { status: 'completed' };
    booking.status = BookingStatus.CONFIRMED; await booking.save();
    return { status: 'completed' };
  }

  static async board(p: {
    qrCode: string;
    tripId: string;
    scannedBy: string;
    scannedByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator';
  }): Promise<{ result: BoardingScanResult; booking?: IBooking }> {
    const booking = await Booking.findOne({ qrCode: p.qrCode.trim().toUpperCase() });

    const writeScan = async (result: BoardingScanResult, bookingId?: mongoose.Types.ObjectId, vendorId?: mongoose.Types.ObjectId) => {
      await BoardingScan.create({
        bookingId,
        tripId: p.tripId,
        vendorId: vendorId ?? (booking?.vendorId),
        scannedBy: p.scannedBy,
        scannedByType: p.scannedByType,
        result,
      });
    };

    if (!booking) {
      // No vendor context for an unknown QR — record against the trip only.
      const trip = await Trip.findById(p.tripId).select('vendorId');
      await BoardingScan.create({ tripId: p.tripId, vendorId: trip?.vendorId, scannedBy: p.scannedBy, scannedByType: p.scannedByType, result: BoardingScanResult.INVALID });
      return { result: BoardingScanResult.INVALID };
    }
    if (booking.tripId.toString() !== p.tripId) {
      await writeScan(BoardingScanResult.WRONG_TRIP, booking._id, booking.vendorId);
      return { result: BoardingScanResult.WRONG_TRIP, booking };
    }
    if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.REFUNDED) {
      await writeScan(BoardingScanResult.CANCELLED_BOOKING, booking._id, booking.vendorId);
      return { result: BoardingScanResult.CANCELLED_BOOKING, booking };
    }
    if (booking.status === BookingStatus.BOARDED) {
      await writeScan(BoardingScanResult.ALREADY_BOARDED, booking._id, booking.vendorId);
      return { result: BoardingScanResult.ALREADY_BOARDED, booking };
    }

    // Atomic transition to BOARDED so two concurrent scans can't both "succeed".
    const boarded = await Booking.findOneAndUpdate(
      { _id: booking._id, status: BookingStatus.CONFIRMED },
      { $set: { status: BookingStatus.BOARDED, boardedAt: new Date(), boardedBy: p.scannedBy } },
      { new: true },
    );
    if (!boarded) {
      await writeScan(BoardingScanResult.ALREADY_BOARDED, booking._id, booking.vendorId);
      return { result: BoardingScanResult.ALREADY_BOARDED, booking };
    }
    await writeScan(BoardingScanResult.SUCCESS, booking._id, booking.vendorId);
    return { result: BoardingScanResult.SUCCESS, booking: boarded };
  }
}
