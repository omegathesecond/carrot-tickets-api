import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { HttpError } from '@utils/httpError.util';

export const HEX24 = /^[0-9a-f]{24}$/i;

/** Map service errors onto the response: HttpError keeps its status, anything
 *  else logs loudly and becomes a 500. */
export function failWithHttpError(res: Response, error: any, fallback: string) {
  if (error instanceof HttpError) return ApiResponseUtil.error(res, error.message, error.statusCode);
  console.error(fallback, error);
  return ApiResponseUtil.error(res, error?.message || fallback, 500);
}

export interface MessageCursorParams {
  before?: string;
  after?: string;
  limit?: number;
}

/**
 * Validate the shared message-pagination query params. On invalid input this
 * writes the 400 response and returns null — callers just return.
 */
export function parseMessageCursorParams(req: Request, res: Response): MessageCursorParams | null {
  const rawLimit = req.query['limit'];
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      ApiResponseUtil.error(res, 'limit must be a positive integer', 400);
      return null;
    }
  }
  const before = req.query['before'] as string | undefined;
  if (before !== undefined && !HEX24.test(before)) {
    ApiResponseUtil.error(res, 'before must be a message id', 400);
    return null;
  }
  const after = req.query['after'] as string | undefined;
  if (after !== undefined && !HEX24.test(after)) {
    ApiResponseUtil.error(res, 'after must be a message id', 400);
    return null;
  }
  return { before, after, limit };
}
