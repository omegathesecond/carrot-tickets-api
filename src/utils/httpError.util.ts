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

/**
 * A code was requested again inside the resend cooldown window.
 *
 * 429 rather than 400: a cooldown is not a malformed request, it is a "not
 * yet". Carries the remaining seconds as a NUMBER so the controller can answer
 * with a standard `Retry-After` and a client can count down to the exact moment
 * another code is allowed, instead of regexing them out of the sentence.
 *
 * The message text is part of the contract — the buyer site still parses it —
 * so change the wording only together with that parse.
 */
export class OtpCooldownError extends HttpError {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      429,
      `Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'} before requesting another code.`
    );
    this.name = 'OtpCooldownError';
  }
}
