import mongoose from 'mongoose';
import { Trip } from '@models/transport/trip.model';
import { Seat } from '@models/transport/seat.model';
import { Route } from '@models/transport/route.model';
import { Booking } from '@models/transport/booking.model';
import { BookingSale } from '@models/transport/bookingSale.model';
import { SeatScheme, TripStatus } from '@interfaces/transport.interface';
import { IBooking, IBookingSale, BookingStatus } from '@interfaces/booking.interface';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import { getProcessor } from '@services/payments';
import { computeSaleEconomics, SaleSoldByType } from '@services/saleEconomics.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { normalizePhone } from '@utils/phone.util';
import { HttpError } from '@utils/httpError.util';

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

    // Pre-allocate the booking id so we can stamp it on the seat during the atomic claim.
    const booking = new Booking({
      tripId: trip._id,
      vendorId: trip.vendorId,
      passengerName: p.passengerName,
      passengerPhone: normalizePhone(p.passengerPhone),
      seatNumber: isSeatMapped ? p.seatNumber : undefined,
      fareAmount: fare,
      platformFee: 0,
      totalAmount: fare,
      status: BookingStatus.PENDING,
    });

    // ── Atomic capacity claim ─────────────────────────────────────
    if (isSeatMapped) {
      if (!p.seatNumber) throw new HttpError(400, 'seatNumber is required for this vehicle');
      const seat = await Seat.findOneAndUpdate(
        { tripId: trip._id, seatNumber: p.seatNumber, isBooked: false, isReserved: false },
        { $set: { isBooked: true, bookingId: booking._id } },
        { new: true },
      );
      if (!seat) throw new HttpError(409, 'Seat is already booked or reserved');
    } else {
      const claimed = await Trip.findOneAndUpdate(
        { _id: trip._id, $expr: { $lt: [{ $add: ['$soldCount', '$reservedCount'] }, '$totalSeats'] } },
        { $inc: { soldCount: 1 } },
        { new: true },
      );
      if (!claimed) throw new HttpError(409, 'Trip is fully booked');
    }

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

    // ── Charge (synchronous processors only) ──────────────────────
    let paymentStatus: PaymentStatus;
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
      paymentStatus = PaymentStatus.COMPLETED;
    } catch (err) {
      await releaseClaim();
      throw err;
    }

    // ── Economic snapshot (reused DRY helper) ─────────────────────
    const cfg = await PaymentConfigService.get();
    const mappedSoldByType = SOLD_BY_MAP[p.soldByType];
    const econ = computeSaleEconomics({
      faceAmount: fare,
      paymentMethod: p.paymentMethod as any,
      soldByType: mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent ?? cfg.defaultResellerCommissionPercent,
      platformFeePercent: cfg.platformFeePercent,
    });

    // ── Persist booking + sale ────────────────────────────────────
    booking.platformFee = econ.platformFeeAmount;
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
      paymentStatus,
      walletTransactionId,
      soldBy: p.soldBy,
      soldByType: mappedSoldByType,
      channel: SalesChannel.RESELLER_POS,
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

    booking.saleId = sale._id as mongoose.Types.ObjectId;
    await booking.save();

    return { booking, sale: sale as IBookingSale };
  }
}
