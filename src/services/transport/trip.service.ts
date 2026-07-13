import { Trip } from '@models/transport/trip.model';
import { Seat } from '@models/transport/seat.model';
import { Route } from '@models/transport/route.model';
import { VehicleType } from '@models/transport/vehicleType.model';
import { ITrip, SeatScheme, SeatLayout, TripStatus } from '@interfaces/transport.interface';
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
}
