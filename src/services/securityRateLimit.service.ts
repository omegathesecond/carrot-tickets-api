import crypto from 'crypto';
import { SecurityRateLimit } from '@models/securityRateLimit.model';
import { HttpError } from '@utils/httpError.util';

export class SecurityRateLimitError extends HttpError {
  constructor(public readonly retryAfterSeconds: number) {
    super(429, `Too many attempts. Try again in ${retryAfterSeconds} seconds.`);
  }
}

/** Shared, atomic quotas across every API instance. Destination hashes avoid
 * copying phone numbers/email addresses into the abuse-control collection. */
export class SecurityRateLimitService {
  private static key(namespace: string, identity: string): string {
    return crypto.createHash('sha256').update(`${namespace}:${identity.trim().toLowerCase()}`).digest('hex');
  }

  static async consume(namespace: string, identity: string, capacity: number, windowMs: number): Promise<void> {
    const now = new Date();
    const expired = { $lte: [{ $ifNull: ['$resetAt', new Date(0)] }, now] };
    const update = [{ $set: {
      count: { $cond: [expired, 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }] },
      resetAt: { $cond: [expired, new Date(now.getTime() + windowMs), '$resetAt'] },
      expiresAt: new Date(now.getTime() + windowMs * 2),
    } }];
    const filter = { _id: this.key(namespace, identity) };
    let row;
    try {
      row = await SecurityRateLimit.findOneAndUpdate(filter, update, { upsert: true, new: true }).lean();
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      // Another instance inserted the same unique key; apply to that row.
      row = await SecurityRateLimit.findOneAndUpdate(filter, update, { new: true }).lean();
    }
    if (!row) throw new Error('Security quota could not be recorded');
    if (row.count > capacity) throw new SecurityRateLimitError(Math.max(1, Math.ceil((row.resetAt.getTime() - Date.now()) / 1000)));
  }

  static async clear(namespace: string, identity: string): Promise<void> {
    await SecurityRateLimit.deleteOne({ _id: this.key(namespace, identity) });
  }
}
