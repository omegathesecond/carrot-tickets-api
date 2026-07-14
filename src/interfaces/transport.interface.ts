import { Document, Types } from 'mongoose';

export enum SeatScheme {
  SEQUENTIAL = 'sequential',
  ROW_LETTER = 'row_letter',
  PASSENGER_COUNT = 'passenger_count',
}

export enum TripStatus {
  SCHEDULED = 'scheduled',
  BOARDING = 'boarding',
  DEPARTED = 'departed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** For ROW_LETTER vehicles: seat labels are generated A1..A{seatsPerRow}, B1.. */
export interface SeatLayout {
  rows: number;
  seatsPerRow: number;
}

export interface IVehicleType extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  name: string;
  totalSeats: number;
  seatScheme: SeatScheme;
  layoutJson?: SeatLayout | null;
  registrations: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IRoute extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  name: string;
  originCity: string;
  destinationCity: string;
  stops?: string[];
  farePerSeat: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITrip extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  routeId: Types.ObjectId;
  vehicleTypeId: Types.ObjectId;
  departureTime: Date;
  arrivalTime?: Date;
  vehicleReg?: string;
  totalSeats: number;
  seatScheme: SeatScheme;
  soldCount: number;
  reservedCount: number;
  status: TripStatus;
  reminderSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISeat extends Document {
  _id: Types.ObjectId;
  tripId: Types.ObjectId;
  seatNumber: string;
  isBooked: boolean;
  bookingId?: Types.ObjectId; // ref 'Booking' — Booking model arrives in SP1b
  isReserved: boolean;
  reservedNote?: string;
  reservedBy?: Types.ObjectId;
  reservedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
