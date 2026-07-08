import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/**
 * File size limits for different media types (in bytes)
 */
const FILE_SIZE_LIMITS = {
  poster: 5 * 1024 * 1024,      // 5MB for posters
  thumbnail: 2 * 1024 * 1024,   // 2MB for thumbnails
  gallery: 10 * 1024 * 1024,    // 10MB for gallery images
  qrcode: 2 * 1024 * 1024,      // 2MB for QR codes
  wristband: 10 * 1024 * 1024,  // 10MB for wristband artwork (photo-quality backgrounds)
};

/**
 * Allowed MIME types for event media
 */
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

const ALLOWED_QRCODE_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  'image/svg+xml',  // Allow SVG for QR codes
];

/**
 * Multer memory storage configuration
 * Files are stored in memory as buffers for direct R2 upload
 */
const storage = multer.memoryStorage();

/**
 * File filter for image validation
 */
const createFileFilter = (allowedTypes: string[], mediaType: string) => {
  return (req: Request, file: Express.Multer.File, callback: multer.FileFilterCallback) => {
    if (!allowedTypes.includes(file.mimetype)) {
      const error = new Error(`Invalid file type for ${mediaType}. Allowed: ${allowedTypes.join(', ')}`);
      return callback(error);
    }
    callback(null, true);
  };
};

/**
 * Multer configurations for different media types
 */
export const posterUpload = multer({
  storage,
  limits: {
    fileSize: FILE_SIZE_LIMITS.poster,
    files: 1,
  },
  fileFilter: createFileFilter(ALLOWED_IMAGE_TYPES, 'poster'),
});

export const thumbnailUpload = multer({
  storage,
  limits: {
    fileSize: FILE_SIZE_LIMITS.thumbnail,
    files: 1,
  },
  fileFilter: createFileFilter(ALLOWED_IMAGE_TYPES, 'thumbnail'),
});

export const galleryUpload = multer({
  storage,
  limits: {
    fileSize: FILE_SIZE_LIMITS.gallery,
    files: 10,  // Allow up to 10 images in gallery
  },
  fileFilter: createFileFilter(ALLOWED_IMAGE_TYPES, 'gallery'),
});

export const qrcodeUpload = multer({
  storage,
  limits: {
    fileSize: FILE_SIZE_LIMITS.qrcode,
    files: 1,
  },
  fileFilter: createFileFilter(ALLOWED_QRCODE_TYPES, 'qrcode'),
});

// Wristband artwork: photo-quality backgrounds can be large — 10MB, images only.
export const wristbandUpload = multer({
  storage,
  limits: {
    fileSize: FILE_SIZE_LIMITS.wristband,
    files: 1,
  },
  fileFilter: createFileFilter(ALLOWED_IMAGE_TYPES, 'wristband'),
});

/**
 * Middleware to validate that a file was uploaded
 */
export const validateFileUpload = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.file && !req.files) {
    ApiResponseUtil.validationError(res, 'No file uploaded');
    return;
  }
  next();
};

/**
 * Middleware to validate that multiple files were uploaded
 */
export const validateMultipleFileUpload = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
    ApiResponseUtil.validationError(res, 'No files uploaded');
    return;
  }
  next();
};

/**
 * Middleware to validate event exists and user has access
 * This should be called after authentication middleware
 */
export const validateEventAccess = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { eventId } = req.params;
    const ticketsUser = (req as any).ticketsUser;

    if (!eventId) {
      ApiResponseUtil.validationError(res, 'Event ID is required');
      return;
    }

    if (!ticketsUser || !ticketsUser.vendorId) {
      ApiResponseUtil.unauthorized(res, 'Unauthorized access');
      return;
    }

    // Event existence and ownership validation will be done in the controller
    // as it requires database access
    next();
  } catch (error: any) {
    ApiResponseUtil.error(res, error.message || 'Failed to validate event access');
  }
};

/**
 * Error handler for Multer errors
 */
export const handleMulterError = (err: any, req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      ApiResponseUtil.validationError(res, 'File size exceeds the limit');
      return;
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      ApiResponseUtil.validationError(res, 'Too many files uploaded');
      return;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      ApiResponseUtil.validationError(res, 'Unexpected file field');
      return;
    }
    ApiResponseUtil.validationError(res, `Upload error: ${err.message}`);
    return;
  }

  if (err) {
    ApiResponseUtil.error(res, err.message || 'File upload failed');
    return;
  }

  next();
};
