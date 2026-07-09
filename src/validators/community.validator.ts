import Joi from 'joi';

export const sendMessageSchema = Joi.object({
  body: Joi.string().trim().min(1).max(2000).required(),
  replyTo: Joi.string().hex().length(24).optional(),
});

export const updateProfileSchema = Joi.object({
  username: Joi.string().optional(),
  bio: Joi.string().allow('').max(280).optional(),
  dmPrivacy: Joi.string().valid('community', 'friends').optional(),
}).min(1);
