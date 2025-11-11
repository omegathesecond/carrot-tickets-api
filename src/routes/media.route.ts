import { Router } from 'express';
import { MediaController } from '@controllers/media.controller';
import { authenticateTickets } from '@middleware/ticketsAuth.middleware';
import {
  posterUpload,
  thumbnailUpload,
  galleryUpload,
  qrcodeUpload,
  validateFileUpload,
  validateMultipleFileUpload,
  validateEventAccess,
  handleMulterError,
} from '@middleware/media.middleware';

const router = Router();

/**
 * Media Upload Routes for Keshless Tickets
 * All routes require authentication via authenticateTickets
 *
 * Base path: /api/media
 */

/**
 * @route   POST /api/media/events/:eventId/poster
 * @desc    Upload event poster image
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'poster' field
 * @limits  5MB, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/poster',
  authenticateTickets,
  validateEventAccess,
  posterUpload.single('poster'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadPoster
);

/**
 * @route   POST /api/media/events/:eventId/thumbnail
 * @desc    Upload event thumbnail image
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'thumbnail' field
 * @limits  2MB, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/thumbnail',
  authenticateTickets,
  validateEventAccess,
  thumbnailUpload.single('thumbnail'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadThumbnail
);

/**
 * @route   POST /api/media/events/:eventId/gallery
 * @desc    Upload gallery images (multiple)
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'gallery' field (multiple files)
 * @limits  10MB per file, max 10 files, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/gallery',
  authenticateTickets,
  validateEventAccess,
  galleryUpload.array('gallery', 10),
  handleMulterError,
  validateMultipleFileUpload,
  MediaController.uploadGalleryImages
);

/**
 * @route   POST /api/media/events/:eventId/qrcode
 * @desc    Upload custom QR code image
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'qrcode' field
 * @limits  2MB, JPEG/PNG/WEBP/SVG
 */
router.post(
  '/events/:eventId/qrcode',
  authenticateTickets,
  validateEventAccess,
  qrcodeUpload.single('qrcode'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadQRCode
);

/**
 * @route   DELETE /api/media/events/:eventId
 * @desc    Delete media by URL
 * @access  Private (Vendor)
 * @body    { url: string, mediaType: 'poster' | 'thumbnail' | 'gallery' | 'qrcode' }
 */
router.delete(
  '/events/:eventId',
  authenticateTickets,
  validateEventAccess,
  MediaController.deleteMedia
);

/**
 * @route   GET /api/media/events/:eventId/list
 * @desc    List all media for an event
 * @access  Private (Vendor)
 */
router.get(
  '/events/:eventId/list',
  authenticateTickets,
  validateEventAccess,
  MediaController.listEventMedia
);

export default router;
