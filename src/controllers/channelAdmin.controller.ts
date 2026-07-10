import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { Event } from '@models/event.model';
import { Channel } from '@models/channel.model';
import { Community } from '@models/community.model';
import { ChannelAdminService } from '@services/channelAdmin.service';
import { createChannelSchema, updateChannelSchema } from '@validators/community.validator';

const OWNERSHIP_ERROR = 'You can only manage channels for your own events';

export class ChannelAdminController {
  /** GET /api/tickets/events/:eventId/channels — vendor, own events only. */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const vendorId = ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const eventId = String(req.params['eventId'] || '');
      if (!HEX24.test(eventId)) return ApiResponseUtil.error(res, 'eventId must be an event id', 400);

      const event = await Event.findById(eventId).select('vendorId');
      if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
      if (!ticketsUser?.isSuperAdmin && String(event.vendorId) !== String(vendorId)) {
        return ApiResponseUtil.error(res, OWNERSHIP_ERROR, 403);
      }

      const result = await ChannelAdminService.list(eventId);
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load channels');
    }
  }

  /** POST /api/tickets/events/:eventId/channels — vendor, own events only. */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const vendorId = ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const eventId = String(req.params['eventId'] || '');
      if (!HEX24.test(eventId)) return ApiResponseUtil.error(res, 'eventId must be an event id', 400);

      const { error, value } = createChannelSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const event = await Event.findById(eventId).select('vendorId');
      if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
      if (!ticketsUser?.isSuperAdmin && String(event.vendorId) !== String(vendorId)) {
        return ApiResponseUtil.error(res, OWNERSHIP_ERROR, 403);
      }

      const view = await ChannelAdminService.create(eventId, value);
      return ApiResponseUtil.success(res, view, 'Channel created', 201);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to create channel');
    }
  }

  /**
   * PATCH /api/tickets/channels/:channelId — vendor, own events only.
   * No eventId in the URL, so ownership walks channel -> community -> event.
   */
  static async update(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const vendorId = ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const channelId = String(req.params['channelId'] || '');
      if (!HEX24.test(channelId)) return ApiResponseUtil.error(res, 'channelId must be a channel id', 400);

      const { error, value } = updateChannelSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const channel = await Channel.findById(channelId);
      if (!channel) return ApiResponseUtil.error(res, 'Channel not found', 404);
      const community = await Community.findById(channel.communityId).select('eventId');
      if (!community) return ApiResponseUtil.error(res, 'Community not found', 404);
      const event = await Event.findById(community.eventId).select('vendorId');
      if (!event) return ApiResponseUtil.error(res, 'Event not found', 404);
      if (!ticketsUser?.isSuperAdmin && String(event.vendorId) !== String(vendorId)) {
        return ApiResponseUtil.error(res, OWNERSHIP_ERROR, 403);
      }

      const view = await ChannelAdminService.update(channel, value);
      return ApiResponseUtil.success(res, view, 'Channel updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update channel');
    }
  }
}
