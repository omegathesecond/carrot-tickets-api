import Joi from 'joi';
import { SeatScheme } from '@interfaces/transport.interface';

const HEX24 = /^[0-9a-fA-F]{24}$/;

const layoutJson = Joi.object({
  rows: Joi.number().integer().min(1).required(),
  seatsPerRow: Joi.number().integer().min(1).required(),
});

export const createVehicleTypeSchema = Joi.object({
  name: Joi.string().trim().max(100).required(),
  totalSeats: Joi.number().integer().min(1).max(200).required(),
  seatScheme: Joi.string().valid(...Object.values(SeatScheme)).default(SeatScheme.SEQUENTIAL),
  layoutJson: Joi.when('seatScheme', { is: SeatScheme.ROW_LETTER, then: layoutJson.required(), otherwise: Joi.any().strip() }),
  registrations: Joi.array().items(Joi.string().trim()).optional(),
});

export const updateVehicleTypeSchema = Joi.object({
  name: Joi.string().trim().max(100).optional(),
  totalSeats: Joi.number().integer().min(1).max(200).optional(),
  seatScheme: Joi.string().valid(...Object.values(SeatScheme)).optional(),
  layoutJson: layoutJson.optional(),
  registrations: Joi.array().items(Joi.string().trim()).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const createRouteSchema = Joi.object({
  name: Joi.string().trim().max(120).required(),
  originCity: Joi.string().trim().max(80).required(),
  destinationCity: Joi.string().trim().max(80).required(),
  stops: Joi.array().items(Joi.string().trim()).optional(),
  farePerSeat: Joi.number().min(0).required(),
});

export const updateRouteSchema = Joi.object({
  name: Joi.string().trim().max(120).optional(),
  originCity: Joi.string().trim().max(80).optional(),
  destinationCity: Joi.string().trim().max(80).optional(),
  stops: Joi.array().items(Joi.string().trim()).optional(),
  farePerSeat: Joi.number().min(0).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const createTripSchema = Joi.object({
  routeId: Joi.string().regex(HEX24).required(),
  vehicleTypeId: Joi.string().regex(HEX24).required(),
  departureTime: Joi.date().iso().greater('now').required(),
  arrivalTime: Joi.date().iso().greater(Joi.ref('departureTime')).optional(),
  vehicleReg: Joi.string().trim().max(20).optional(),
  reservedSeatNumbers: Joi.array().items(Joi.string().trim()).optional(),
  reservedCount: Joi.number().integer().min(0).optional(),
  reservedNote: Joi.string().trim().max(200).optional(),
});

export const reserveSeatSchema = Joi.object({ note: Joi.string().trim().max(200).optional() });
export const reservedCountSchema = Joi.object({ reservedCount: Joi.number().integer().min(0).required() });
export const listTripsQuerySchema = Joi.object({ routeId: Joi.string().regex(HEX24).optional() });
