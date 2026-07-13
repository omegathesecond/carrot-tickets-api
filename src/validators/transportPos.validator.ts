import Joi from 'joi';
import { PaymentMethod } from '@interfaces/ticket.interface';

const HEX24 = /^[0-9a-fA-F]{24}$/;

export const listTripsQuerySchema = Joi.object({
  routeId: Joi.string().regex(HEX24).optional(),
  vendorId: Joi.string().regex(HEX24).optional(),
});

export const sellSeatSchema = Joi.object({
  tripId: Joi.string().regex(HEX24).required(),
  seatNumber: Joi.string().trim().optional(),
  passengerName: Joi.string().trim().max(100).required(),
  passengerPhone: Joi.string().trim().max(20).required(),
  paymentMethod: Joi.string().valid(PaymentMethod.CASH, PaymentMethod.KESHLESS_WALLET).required()
    .messages({ 'any.only': 'Only cash and Keshless wallet are supported for bus bookings right now' }),
  keshlessCardNumber: Joi.when('paymentMethod', { is: PaymentMethod.KESHLESS_WALLET, then: Joi.string().length(8).pattern(/^[A-Z0-9]+$/).required(), otherwise: Joi.optional() }),
  keshlessPin: Joi.when('paymentMethod', { is: PaymentMethod.KESHLESS_WALLET, then: Joi.string().length(4).pattern(/^[0-9]{4}$/).optional(), otherwise: Joi.optional() }),
});

export const boardSchema = Joi.object({
  qrCode: Joi.string().trim().required(),
  tripId: Joi.string().regex(HEX24).required(),
});
