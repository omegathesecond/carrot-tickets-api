import { Router } from 'express';
import { MediaController } from '@controllers/media.controller';
import { authenticateTickets, requireTicketsPermission, requireSuperAdminOrPermission } from '@middleware/ticketsAuth.middleware';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import {
  posterUpload,
  thumbnailUpload,
  galleryUpload,
  qrcodeUpload,
  wristbandUpload,
  itemImageUpload,
  validateFileUpload,
  validateMultipleFileUpload,
  validateEventAccess,
  handleMulterError,
} from '@middleware/media.middleware';

const router = Router();

router.use(authenticateTickets);
router.use((req, res, next) => {
  // Media routes must enforce the same capability as their owning feature.
  const permission = req.path.endsWith('/menu-item') ? TicketsPermission.MANAGE_MENU :
    req.path.endsWith('/product') ? TicketsPermission.MANAGE_STOCK :
    req.path.endsWith('/wristband') ? TicketsPermission.PRINT_WRISTBANDS :
    req.method === 'GET' ? TicketsPermission.VIEW_EVENTS : TicketsPermission.EDIT_EVENT;
  return (permission === TicketsPermission.PRINT_WRISTBANDS ?
    requireSuperAdminOrPermission(permission) : requireTicketsPermission(permission))(req, res, next);
});

/**
 * Media Upload Routes for Carrot Tickets
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
  validateEventAccess,
  qrcodeUpload.single('qrcode'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadQRCode
);

/**
 * @route   POST /api/media/events/:eventId/wristband
 * @desc    Upload wristband artwork (platform staff only — checked in controller)
 * @access  Private (super-admin or tickets:print_wristbands)
 * @body    multipart/form-data with 'artwork' field
 * @limits  10MB, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/wristband',
  wristbandUpload.single('artwork'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadWristbandAsset
);

/**
 * @route   POST /api/media/events/:eventId/menu-item
 * @desc    Upload an image for a menu item; returns the url, writes no document
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'image' field
 * @limits  5MB, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/menu-item',
  validateEventAccess,
  itemImageUpload.single('image'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadMenuItemImage,
);

/**
 * @route   POST /api/media/events/:eventId/product
 * @desc    Upload an image for a catalogue product; returns the url, writes no document
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'image' field
 * @limits  5MB, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/product',
  validateEventAccess,
  itemImageUpload.single('image'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadProductImage,
);

/**
 * @route   DELETE /api/media/events/:eventId
 * @desc    Delete media by URL
 * @access  Private (Vendor)
 * @body    { url: string, mediaType: 'poster' | 'thumbnail' | 'gallery' | 'qrcode' }
 */
router.delete(
  '/events/:eventId',
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
  validateEventAccess,
  MediaController.listEventMedia
);

export default router;
