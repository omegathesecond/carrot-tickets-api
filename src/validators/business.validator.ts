import Joi from 'joi';
import { BUSINESS_CATEGORIES } from '@/constants/businessCategories';

export const businessRequestOtpSchema = Joi.object({
  identifier: Joi.string().trim().required(),
});

export const registerBusinessSchema = Joi.object({
  identifier: Joi.string().trim().required(),
  code: Joi.string().trim().length(6).pattern(/^\d+$/).required(),
  password: Joi.string().min(6).required(),
  businessName: Joi.string().trim().min(1).max(100).required(),
  serviceCategory: Joi.string().valid(...BUSINESS_CATEGORIES).required(),
});

export const businessReviewSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  text: Joi.string().trim().max(1000).allow('').optional(),
});

// GET /api/public/businesses — directory query. Mirrors publicEventsQuerySchema
// (public.controller.ts): 'All'/absent category = unfiltered.
export const publicBusinessesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  search: Joi.string().optional().max(100),
  category: Joi.string().optional().max(50),
});

