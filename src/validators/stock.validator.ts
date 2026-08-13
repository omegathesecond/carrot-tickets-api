import Joi from 'joi';
import { ProductCategory } from '@interfaces/stock.interface';

const MAX_PRICE_CENTS = 100_000_00; // R100,000/unit ceiling, defense-in-depth
const MAX_QTY = 1_000_000;

export const createProductSchema = Joi.object({
  name: Joi.string().trim().min(1).required(),
  category: Joi.string().valid(...Object.values(ProductCategory)).required(),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS).required(),
  barcode: Joi.string().trim().min(3).optional(),
  unitLabel: Joi.string().trim().optional(),
  unitsPerPack: Joi.number().integer().min(1).optional(),
  packLabel: Joi.string().trim().optional(),
  imageUrl: Joi.string().trim().uri().optional(),
});

export const updateProductSchema = Joi.object({
  name: Joi.string().trim().min(1),
  category: Joi.string().valid(...Object.values(ProductCategory)),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS),
  barcode: Joi.string().trim().min(3).allow(null),
  unitLabel: Joi.string().trim(),
  unitsPerPack: Joi.number().integer().min(1).allow(null),
  packLabel: Joi.string().trim().allow(null),
  imageUrl: Joi.string().trim().uri().allow(null),
  active: Joi.boolean(),
}).min(1);

export const receiveStockSchema = Joi.object({
  merchantId: Joi.string().trim().required(),
  productId: Joi.string().trim().required(),
  quantity: Joi.number().integer().min(1).max(MAX_QTY).required(),
  unit: Joi.string().valid('unit', 'pack').default('unit'),
  note: Joi.string().trim().optional(),
});
