import Joi from 'joi';

export const sendMessageSchema = Joi.object({
  body: Joi.string().trim().min(1).max(2000).required(),
  replyTo: Joi.string().hex().length(24).optional(),
});

export const updateProfileSchema = Joi.object({
  username: Joi.string().optional(),
  bio: Joi.string().allow('').max(280).optional(),
  dmPrivacy: Joi.string().valid('community', 'friends').optional(),
  notificationPrefs: Joi.object({
    announcements: Joi.boolean(),
    dms: Joi.boolean(),
    mentions: Joi.boolean(),
    social: Joi.boolean(),
    reminders: Joi.boolean(),
  }).min(1).optional(),
}).min(1);

export const blockSchema = Joi.object({
  userId: Joi.string().hex().length(24).required(),
});

export const followSchema = Joi.object({
  targetType: Joi.string().valid('buyer', 'organizer').required(),
  targetId: Joi.string().hex().length(24).required(),
});

export const createThreadSchema = Joi.object({
  participantIds: Joi.array().items(Joi.string().hex().length(24)).min(1).max(9).required(),
});

export const organizerProfileSchema = Joi.object({
  logoUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(500).allow('').optional(),
  bio: Joi.string().max(500).allow('').optional(),
}).min(1);

export const reviewSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  text: Joi.string().trim().max(1000).allow('').optional(),
});

export const reviewReplySchema = Joi.object({
  text: Joi.string().trim().min(1).max(1000).required(),
});

export const announcementSchema = Joi.object({
  body: Joi.string().trim().min(1).max(2000).required(),
});

export const pushSubscribeSchema = Joi.object({
  endpoint: Joi.string().uri({ scheme: ['https'] }).max(1000).required(),
  keys: Joi.object({
    p256dh: Joi.string().max(300).required(),
    auth: Joi.string().max(300).required(),
  }).required(),
});
