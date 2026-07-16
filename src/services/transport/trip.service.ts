import { FilterQuery } from 'mongoose';
import { Trip } from '@models/transport/trip.model';
import { Seat } from '@models/transport/seat.model';
import { Route } from '@models/transport/route.model';
import { VehicleType } from '@models/transport/vehicleType.model';
import { Vendor } from '@models/vendor.model';
import { ITrip, SeatScheme, SeatLayout, TripStatus } from '@interfaces/transport.interface';
import { OperatorType } from '@interfaces/vendor.interface';
import { HttpError } from '@utils/httpError.util';

const ROW_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // skip I, L, O for legibility

/** Deterministic seat labels for a scheme. PASSENGER_COUNT has no seat rows. */
export function generateSeatNumbers(scheme: SeatScheme, totalSeats: number, layoutJson?: SeatLayout | null): string[] {
  if (scheme === SeatScheme.PASSENGER_COUNT) return [];
  if (scheme === SeatScheme.SEQUENTIAL) {
    return Array.from({ length: totalSeats }, (_, i) => String(i + 1));
  }
  // ROW_LETTER
  if (!layoutJson || !layoutJson.rows || !layoutJson.seatsPerRow) {
    throw new HttpError(400, 'ROW_LETTER vehicle type requires layoutJson { rows, seatsPerRow }');
  }
  if (layoutJson.rows > ROW_LETTERS.length) {
    throw new HttpError(400, `ROW_LETTER supports at most ${ROW_LETTERS.length} rows`);
  }
  const out: string[] = [];
  for (let r = 0; r < layoutJson.rows; r++) {
    for (let c = 1; c <= layoutJson.seatsPerRow; c++) {
      out.push(`${ROW_LETTERS[r]}${c}`);
    }
  }
  return out.slice(0, totalSeats);
}

export interface CreateTripParams {
  vendorId: string;
  routeId: string;
  vehicleTypeId: string;
  departureTime: Date;
  arrivalTime?: Date;
  vehicleReg?: string;
  reservedSeatNumbers?: string[];
  reservedCount?: number;
  reservedNote?: string;
}

export class TripService {
  static async createTrip(p: CreateTripParams): Promise<ITrip> {
    const route = await Route.findOne({ _id: p.routeId, vendorId: p.vendorId });
    if (!route) throw new HttpError(404, 'Route not found');
    const vt = await VehicleType.findOne({ _id: p.vehicleTypeId, vendorId: p.vendorId });
    if (!vt) throw new HttpError(404, 'Vehicle type not found');

    const seatNumbers = generateSeatNumbers(vt.seatScheme, vt.totalSeats, vt.layoutJson);
    const isSeatMapped = vt.seatScheme !== SeatScheme.PASSENGER_COUNT;

    if (isSeatMapped && p.reservedCount) {
      throw new HttpError(400, 'reservedCount is only valid for passenger-count vehicles; use reservedSeatNumbers');
    }
    if (!isSeatMapped && p.reservedSeatNumbers?.length) {
      throw new HttpError(400, 'reservedSeatNumbers is only valid for seat-mapped vehicles; use reservedCount');
    }
    const reservedCount = !isSeatMapped ? (p.reservedCount ?? 0) : 0;
    if (reservedCount < 0 || reservedCount > vt.totalSeats) {
      throw new HttpError(400, 'reservedCount out of range');
    }
    const reservedSet = new Set(p.reservedSeatNumbers ?? []);
    for (const sn of reservedSet) {
      if (!seatNumbers.includes(sn)) throw new HttpError(400, `Unknown seat ${sn} for this vehicle type`);
    }

    const trip = await Trip.create({
      vendorId: p.vendorId,
      routeId: p.routeId,
      vehicleTypeId: p.vehicleTypeId,
      departureTime: p.departureTime,
      arrivalTime: p.arrivalTime,
      vehicleReg: p.vehicleReg,
      totalSeats: vt.totalSeats,
      seatScheme: vt.seatScheme,
      soldCount: 0,
      reservedCount,
      status: TripStatus.SCHEDULED,
    });

    if (seatNumbers.length) {
      try {
        await Seat.insertMany(
          seatNumbers.map((sn) => ({
            tripId: trip._id,
            seatNumber: sn,
            isReserved: reservedSet.has(sn),
            reservedNote: reservedSet.has(sn) ? p.reservedNote : undefined,
            reservedAt: reservedSet.has(sn) ? new Date() : undefined,
          })),
        );
      } catch (err) {
        // No multi-doc txn: on seat-insert failure, remove any partial seats + the orphan trip, then fail loud.
        await Seat.deleteMany({ tripId: trip._id });
        await Trip.deleteOne({ _id: trip._id });
        throw err;
      }
    }
    return trip;
  }

  static async getWithAvailability(vendorId: string, tripId: string, isSuperAdmin = false): Promise<{ trip: ITrip; availableSeats: number; seats: any[] }> {
    const query: FilterQuery<ITrip> = isSuperAdmin ? { _id: tripId } : { _id: tripId, vendorId };
    const trip = await Trip.findOne(query)
      .populate('routeId', 'name originCity destinationCity farePerSeat')
      .populate('vehicleTypeId', 'name seatScheme totalSeats');
    if (!trip) throw new HttpError(404, 'Trip not found');

    if (trip.seatScheme === SeatScheme.PASSENGER_COUNT) {
      const availableSeats = Math.max(0, trip.totalSeats - trip.soldCount - trip.reservedCount);
      return { trip, availableSeats, seats: [] };
    }
    const seats = await Seat.find({ tripId: trip._id }).sort({ seatNumber: 1 });
    const availableSeats = seats.filter((s) => !s.isBooked && !s.isReserved).length;
    return { trip, availableSeats, seats };
  }

  /** Shared "sellable" predicate: reused by listSellable and listSellableOperators
   *  so "has a sellable trip" means the same thing everywhere. */
  private static sellablePredicate(now: Date): FilterQuery<ITrip> {
    return {
      status: { $in: [TripStatus.SCHEDULED, TripStatus.BOARDING] },
      departureTime: { $gte: now },
    };
  }

  static async listSellable(p: { vendorId?: string; routeId?: string; now?: Date }): Promise<ITrip[]> {
    const now = p.now ?? new Date();
    const query: FilterQuery<ITrip> = TripService.sellablePredicate(now);
    if (p.vendorId) query.vendorId = p.vendorId;
    if (p.routeId) query.routeId = p.routeId;
    return Trip.find(query)
      .sort({ departureTime: 1 })
      .populate('routeId', 'name originCity destinationCity farePerSeat')
      .populate('vehicleTypeId', 'name seatScheme');
  }

  /** Bus companies a reseller conductor can sell for: active, transport|both
   *  vendors with at least one sellable trip (same predicate as listSellable). */
  static async listSellableOperators(now = new Date()): Promise<Array<{ id: string; businessName: string }>> {
    const vendorIds = await Trip.distinct('vendorId', TripService.sellablePredicate(now));
    if (!vendorIds.length) return [];
    const vendors = await Vendor.find({
      _id: { $in: vendorIds },
      operatorType: { $in: [OperatorType.TRANSPORT, OperatorType.BOTH] },
      isActive: true,
    }).select('businessName').lean();
    return vendors.map((v) => ({ id: String(v._id), businessName: v.businessName as string }));
  }

  static async reserveSeat(vendorId: string, tripId: string, seatNumber: string, note?: string, byUserId?: string): Promise<void> {
    const trip = await TripService.findOwnedTrip(vendorId, tripId);
    if (trip.seatScheme === SeatScheme.PASSENGER_COUNT) {
      throw new HttpError(400, 'This trip uses passenger-count capacity, not a seat map');
    }
    const seat = await Seat.findOneAndUpdate(
      { tripId, seatNumber, isBooked: false, isReserved: false },
      { $set: { isReserved: true, reservedNote: note, reservedBy: byUserId, reservedAt: new Date() } },
      { new: true },
    );
    if (!seat) throw new HttpError(409, 'Seat is already booked or reserved');
  }

  static async releaseSeat(vendorId: string, tripId: string, seatNumber: string): Promise<void> {
    const trip = await TripService.findOwnedTrip(vendorId, tripId);
    if (trip.seatScheme === SeatScheme.PASSENGER_COUNT) {
      throw new HttpError(400, 'This trip uses passenger-count capacity, not a seat map');
    }
    const seat = await Seat.findOneAndUpdate(
      { tripId, seatNumber, isBooked: false, isReserved: true },
      { $set: { isReserved: false }, $unset: { reservedNote: '', reservedBy: '', reservedAt: '' } },
      { new: true },
    );
    if (!seat) throw new HttpError(409, 'Seat is not currently reserved (or is booked)');
  }

  static async setReservedCount(vendorId: string, tripId: string, reservedCount: number): Promise<ITrip> {
    const trip = await TripService.findOwnedTrip(vendorId, tripId);
    if (trip.seatScheme !== SeatScheme.PASSENGER_COUNT) {
      throw new HttpError(400, 'Seat-mapped trips reserve individual seats, not a count');
    }
    if (reservedCount < 0 || reservedCount + trip.soldCount > trip.totalSeats) {
      throw new HttpError(400, 'reservedCount would exceed trip capacity');
    }
    trip.reservedCount = reservedCount;
    return trip.save();
  }

  private static async findOwnedTrip(vendorId: string, tripId: string): Promise<ITrip> {
    const trip = await Trip.findOne({ _id: tripId, vendorId });
    if (!trip) throw new HttpError(404, 'Trip not found');
    return trip;
  }
}
