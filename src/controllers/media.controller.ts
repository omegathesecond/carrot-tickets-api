import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { R2Service } from '@utils/r2.service';
import { Event } from '@models/event.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

/**
 * MediaController - Handles event media uploads to Cloudflare R2
 *
 * Endpoints:
 * - POST /api/media/events/:eventId/poster - Upload event poster
 * - POST /api/media/events/:eventId/thumbnail - Upload event thumbnail
 * - POST /api/media/events/:eventId/gallery - Upload gallery images (multiple)
 * - POST /api/media/events/:eventId/qrcode - Upload QR code
 * - DELETE /api/media/events/:eventId - Delete media by URL
 * - GET /api/media/events/:eventId/list - List all media for an event
 */
export class MediaController {
  /**
   * Upload event poster
   * POST /api/media/events/:eventId/poster
   */
  static async uploadPoster(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const ticketsUser = (req as any).ticketsUser;
      const file = req.file;

      if (!eventId) {
        return ApiResponseUtil.validationError(res, 'Event ID is required');
      }

      if (!file) {
        return ApiResponseUtil.validationError(res, 'No file uploaded');
      }

      // Verify event exists and belongs to vendor (or superadmin)
      const query: any = { _id: eventId };
      if (!ticketsUser.isSuperAdmin) {
        query.vendorId = ticketsUser.vendorId;
      }
      const event = await Event.findOne(query);
      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found');
      }

      // Delete old poster if exists
      if (event.posterUrl) {
        try {
          await R2Service.deleteEventMediaByUrl(event.posterUrl);
        } catch (err) {
          console.warn('Failed to delete old poster:', err);
        }
      }

      // Upload new poster
      const { key, url } = await R2Service.uploadEventMedia(
        eventId,
        'poster',
        file.originalname || 'poster',
        file.buffer,
        file.mimetype
      );

      // Update event with new poster URL
      event.posterUrl = url;
      await event.save();

      ApiResponseUtil.success(res, {
        event,
        media: { key, url, type: 'poster' }
      }, 'Poster uploaded successfully');
    } catch (error: any) {
      console.error('Upload poster error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to upload poster');
    }
  }

  /**
   * Upload event thumbnail
   * POST /api/media/events/:eventId/thumbnail
   */
  static async uploadThumbnail(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const ticketsUser = (req as any).ticketsUser;
      const file = req.file;

      if (!eventId) {
        return ApiResponseUtil.validationError(res, 'Event ID is required');
      }

      if (!file) {
        return ApiResponseUtil.validationError(res, 'No file uploaded');
      }

      // Verify event exists and belongs to vendor (or superadmin)
      const query: any = { _id: eventId };
      if (!ticketsUser.isSuperAdmin) {
        query.vendorId = ticketsUser.vendorId;
      }
      const event = await Event.findOne(query);
      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found');
      }

      // Delete old thumbnail if exists
      if (event.thumbnailUrl) {
        try {
          await R2Service.deleteEventMediaByUrl(event.thumbnailUrl);
        } catch (err) {
          console.warn('Failed to delete old thumbnail:', err);
        }
      }

      // Upload new thumbnail
      const { key, url } = await R2Service.uploadEventMedia(
        eventId,
        'thumbnail',
        file.originalname || 'thumbnail',
        file.buffer,
        file.mimetype
      );

      // Update event with new thumbnail URL
      event.thumbnailUrl = url;
      await event.save();

      ApiResponseUtil.success(res, {
        event,
        media: { key, url, type: 'thumbnail' }
      }, 'Thumbnail uploaded successfully');
    } catch (error: any) {
      console.error('Upload thumbnail error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to upload thumbnail');
    }
  }

  /**
   * Upload gallery images
   * POST /api/media/events/:eventId/gallery
   * Supports multiple files
   */
  static async uploadGalleryImages(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const ticketsUser = (req as any).ticketsUser;
      const files = req.files as Express.Multer.File[];

      if (!eventId) {
        return ApiResponseUtil.validationError(res, 'Event ID is required');
      }

      if (!files || files.length === 0) {
        return ApiResponseUtil.validationError(res, 'No files uploaded');
      }

      // Verify event exists and belongs to vendor (or superadmin)
      const query: any = { _id: eventId };
      if (!ticketsUser.isSuperAdmin) {
        query.vendorId = ticketsUser.vendorId;
      }
      const event = await Event.findOne(query);
      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found');
      }

      // Upload all images
      const uploadedUrls: string[] = [];
      const uploadResults: Array<{ key: string; url: string }> = [];

      for (const file of files) {
        const { key, url } = await R2Service.uploadEventMedia(
          eventId,
          'gallery',
          file.originalname || 'gallery-image',
          file.buffer,
          file.mimetype
        );
        uploadedUrls.push(url);
        uploadResults.push({ key, url });
      }

      // Add URLs to gallery images array
      event.galleryImages = [...(event.galleryImages || []), ...uploadedUrls];
      await event.save();

      ApiResponseUtil.success(res, {
        event,
        media: { uploaded: uploadResults, type: 'gallery' }
      }, `${files.length} image(s) uploaded successfully`);
    } catch (error: any) {
      console.error('Upload gallery images error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to upload gallery images');
    }
  }

  /**
   * Upload QR code
   * POST /api/media/events/:eventId/qrcode
   */
  static async uploadQRCode(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const ticketsUser = (req as any).ticketsUser;
      const file = req.file;

      if (!eventId) {
        return ApiResponseUtil.validationError(res, 'Event ID is required');
      }

      if (!file) {
        return ApiResponseUtil.validationError(res, 'No file uploaded');
      }

      // Verify event exists and belongs to vendor (or superadmin)
      const query: any = { _id: eventId };
      if (!ticketsUser.isSuperAdmin) {
        query.vendorId = ticketsUser.vendorId;
      }
      const event = await Event.findOne(query);
      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found');
      }

      // Delete old QR code if exists
      if (event.qrCodeUrl) {
        try {
          await R2Service.deleteEventMediaByUrl(event.qrCodeUrl);
        } catch (err) {
          console.warn('Failed to delete old QR code:', err);
        }
      }

      // Upload new QR code
      const { key, url } = await R2Service.uploadEventMedia(
        eventId,
        'qrcode',
        file.originalname || 'qrcode',
        file.buffer,
        file.mimetype
      );

      // Update event with new QR code URL
      event.qrCodeUrl = url;
      await event.save();

      ApiResponseUtil.success(res, {
        event,
        media: { key, url, type: 'qrcode' }
      }, 'QR code uploaded successfully');
    } catch (error: any) {
      console.error('Upload QR code error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to upload QR code');
    }
  }

  /**
   * Delete media by URL
   * DELETE /api/media/events/:eventId
   * Body: { url: string, mediaType: 'poster' | 'thumbnail' | 'gallery' | 'qrcode' }
   */
  static async deleteMedia(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const { url, mediaType } = req.body;
      const ticketsUser = (req as any).ticketsUser;

      if (!url || !mediaType) {
        return ApiResponseUtil.validationError(res, 'URL and media type are required');
      }

      // Verify event exists and belongs to vendor (or superadmin)
      const query: any = { _id: eventId };
      if (!ticketsUser.isSuperAdmin) {
        query.vendorId = ticketsUser.vendorId;
      }
      const event = await Event.findOne(query);
      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found');
      }

      // Delete from R2
      await R2Service.deleteEventMediaByUrl(url);

      // Remove from event document
      switch (mediaType) {
        case 'poster':
          if (event.posterUrl === url) {
            event.posterUrl = undefined;
          }
          break;
        case 'thumbnail':
          if (event.thumbnailUrl === url) {
            event.thumbnailUrl = undefined;
          }
          break;
        case 'gallery':
          event.galleryImages = (event.galleryImages || []).filter(imgUrl => imgUrl !== url);
          break;
        case 'qrcode':
          if (event.qrCodeUrl === url) {
            event.qrCodeUrl = undefined;
          }
          break;
        default:
          return ApiResponseUtil.validationError(res, 'Invalid media type');
      }

      await event.save();

      ApiResponseUtil.success(res, { event }, 'Media deleted successfully');
    } catch (error: any) {
      console.error('Delete media error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to delete media');
    }
  }

  /**
   * List all media for an event
   * GET /api/media/events/:eventId/list
   */
  static async listEventMedia(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const ticketsUser = (req as any).ticketsUser;

      // Verify event exists and belongs to vendor (or superadmin)
      const query: any = { _id: eventId };
      if (!ticketsUser.isSuperAdmin) {
        query.vendorId = ticketsUser.vendorId;
      }
      const event = await Event.findOne(query);
      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found');
      }

      const media = {
        poster: event.posterUrl || null,
        thumbnail: event.thumbnailUrl || null,
        gallery: event.galleryImages || [],
        qrcode: event.qrCodeUrl || null,
      };

      ApiResponseUtil.success(res, { eventId, media }, 'Media retrieved successfully');
    } catch (error: any) {
      console.error('List media error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to list media');
    }
  }

  /**
   * Upload wristband artwork
   * POST /api/media/events/:eventId/wristband
   *
   * Platform-staff only — super-admin or tickets:print_wristbands. Not
   * vendor-gated: admins print wristbands for any organizer's event on the
   * office printer, so (unlike the routes above) this is not wired through
   * validateEventAccess/vendorId scoping.
   */
  static async uploadWristbandAsset(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;
      const ticketsUser = (req as any).ticketsUser;
      const file = req.file;

      const allowed = ticketsUser?.isSuperAdmin ||
        (ticketsUser?.permissions || []).includes(TicketsPermission.PRINT_WRISTBANDS);
      if (!allowed) {
        return ApiResponseUtil.forbidden(res, 'Permission required: tickets:print_wristbands');
      }

      if (!eventId) {
        return ApiResponseUtil.validationError(res, 'Event ID is required');
      }

      if (!file) {
        return ApiResponseUtil.validationError(res, 'No file uploaded');
      }

      const event = await Event.findById(eventId);
      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found');
      }

      const key = R2Service.generateMediaKey(`events/${eventId}/wristbands`, file.originalname);
      await R2Service.uploadBufferToR2(key, file.buffer, file.mimetype);
      const url = R2Service.getPublicUrl(key);

      ApiResponseUtil.created(res, { url });
    } catch (error: any) {
      console.error('Upload wristband asset error:', error);
      ApiResponseUtil.serverError(res, error.message || 'Failed to upload wristband artwork');
    }
  }
}
