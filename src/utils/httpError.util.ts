/**
 * Error carrying an HTTP status. Services throw these; controllers map them
 * straight onto ApiResponseUtil.error — no string-matching on messages.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
