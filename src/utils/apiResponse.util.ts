import { Response } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  error?: string;
  timestamp: string;
  path: string;
}

export class ApiResponseUtil {
  static success<T>(
    res: Response,
    data: T,
    message: string = 'Success',
    statusCode: number = 200
  ): Response<ApiResponse<T>> {
    const response: ApiResponse<T> = {
      success: true,
      message,
      data,
      timestamp: new Date().toISOString(),
      path: res.req.originalUrl
    };

    return res.status(statusCode).json(response);
  }

  static error(
    res: Response,
    message: string = 'Internal Server Error',
    statusCode: number = 500,
    error?: any
  ): Response<ApiResponse> {
    const response: ApiResponse = {
      success: false,
      message,
      timestamp: new Date().toISOString(),
      path: res.req.originalUrl,
      ...(error && { error: typeof error === 'string' ? error : JSON.stringify(error) })
    };

    return res.status(statusCode).json(response);
  }

  static validationError(
    res: Response,
    message: string = 'Validation Error',
    error?: string
  ): Response<ApiResponse> {
    return this.error(res, message, 400, error);
  }

  static badRequest(
    res: Response,
    message: string = 'Bad Request',
    error?: string
  ): Response<ApiResponse> {
    return this.error(res, message, 400, error);
  }

  static notFound(
    res: Response,
    message: string = 'Resource not found'
  ): Response<ApiResponse> {
    return this.error(res, message, 404);
  }

  static unauthorized(
    res: Response,
    message: string = 'Unauthorized'
  ): Response<ApiResponse> {
    return this.error(res, message, 401);
  }

  static forbidden(
    res: Response,
    message: string = 'Forbidden'
  ): Response<ApiResponse> {
    return this.error(res, message, 403);
  }

  static serverError(
    res: Response,
    message: string = 'Internal Server Error'
  ): Response<ApiResponse> {
    return this.error(res, message, 500);
  }

  static created<T>(
    res: Response,
    data: T,
    message: string = 'Resource created successfully'
  ): Response<ApiResponse<T>> {
    return this.success(res, data, message, 201);
  }
}
