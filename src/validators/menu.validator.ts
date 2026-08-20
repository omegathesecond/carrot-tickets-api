import Joi from 'joi';
import { MenuSection } from '@models/menuItem.model';
import { PaymentMethod } from '@interfaces/ticket.interface';

const MAX_PRICE_CENTS = 100_000_00; // R100,000/item ceiling, defense-in-depth
const MAX_ITEMS_PER_ORDER = 30;
const MAX_QTY_PER_LINE = 50;

export const createMenuItemSchema = Joi.object({
  section: Joi.string().valid(...Object.values(MenuSection)).required(),
  vendorName: Joi.string().trim().max(120).optional(),
  category: Joi.string().trim().min(1).max(80).required(),
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(500).allow('').optional(),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS).required(),
  imageUrl: Joi.string().trim().uri().optional(),
  displayOrder: Joi.number().integer().min(0).optional(),
});

export const updateMenuItemSchema = Joi.object({
  section: Joi.string().valid(...Object.values(MenuSection)),
  vendorName: Joi.string().trim().max(120).allow(null, ''),
  category: Joi.string().trim().min(1).max(80),
  name: Joi.string().trim().min(1).max(120),
  description: Joi.string().trim().max(500).allow(null, ''),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS),
  imageUrl: Joi.string().trim().uri().allow(null, ''),
  active: Joi.boolean(),
  displayOrder: Joi.number().integer().min(0),
}).min(1);

export const createMenuOrderSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        menuItemId: Joi.string().trim().required(),
        quantity: Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required(),
      }),
    )
    .min(1)
    .max(MAX_ITEMS_PER_ORDER)
    .required(),
  paymentMethod: Joi.string().valid(PaymentMethod.KESHLESS_WALLET, PaymentMethod.MTN_MOMO).required(),
  keshlessCardNumber: Joi.string().trim().when('paymentMethod', {
    is: PaymentMethod.KESHLESS_WALLET,
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  keshlessPin: Joi.string().trim().optional(),
  momoPhone: Joi.string().trim().when('paymentMethod', {
    is: PaymentMethod.MTN_MOMO,
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  buyerName: Joi.string().trim().max(120).optional(),
  notes: Joi.string().trim().max(500).allow('').optional(),
});

export const updateMenuOrderFulfillmentSchema = Joi.object({
  fulfillmentStatus: Joi.string().valid('new', 'preparing', 'ready', 'collected', 'cancelled').required(),
});
