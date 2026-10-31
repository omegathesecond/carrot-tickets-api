import mongoose, { ClientSession } from 'mongoose';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { generatePin, generateUniqueLoginCode } from '@utils/operatorCredentials.util';
import { sanitizeGrants } from '@interfaces/operatorGrant.interface';

const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();

export class MerchantOperatorService {
  /** Shared by manual creation and the stall-named account generator. */
  static async create(params: {
    merchantId: string; eventId: string; fullName: string; phoneNumber?: string;
    pin?: string; grants?: unknown; session?: ClientSession; reservedCodes?: Set<string>;
  }) {
    const loginCode = await generateUniqueLoginCode(params.reservedCodes);
    params.reservedCodes?.add(loginCode);
    const pin = params.pin ?? generatePin();
    const operator = await new MerchantOperator({
      fullName: params.fullName, phoneNumber: params.phoneNumber,
      merchantId: params.merchantId, eventId: params.eventId,
      loginCode, pin, grants: sanitizeGrants(params.grants),
    }).save({ session: params.session });
    return { operator, loginCode, pin };
  }

  static async createMissingForEvent(eventId: string) {
    const session = await mongoose.startSession();
    try {
      let result = { created: 0, existing: 0, inactive: 0, skipped: 0 };
      await session.withTransaction(async () => {
        // Serialize generators for this event before reading its users. A
        // simultaneous click retries against the first click's committed rows.
        const lock = await Event.updateOne({ _id: eventId }, { $inc: { __v: 1 } }, { session, timestamps: false });
        if (lock.matchedCount !== 1) throw new Error('Event not found');
        const stalls = await Merchant.find({ eventId, deletedAt: null }).sort({ _id: 1 }).session(session);
        const operators = await MerchantOperator.find({ eventId, deletedAt: null }).session(session).lean();
        const reservedCodes = new Set<string>();
        result = { created: 0, existing: 0, inactive: 0, skipped: 0 };
        for (const stall of stalls) {
          if (stall.status !== 'active') { result.skipped++; continue; }
          const matches = operators.filter(op => String(op.merchantId) === String(stall._id) && normalizeName(op.fullName) === normalizeName(stall.name));
          if (matches.length) {
            result.existing++;
            if (!matches.some(op => op.isActive)) result.inactive++;
            continue;
          }
          await MerchantOperatorService.create({
            merchantId: String(stall._id), eventId, fullName: stall.name,
            grants: [], session, reservedCodes,
          });
          result.created++;
        }
      });
      return result;
    } finally { await session.endSession(); }
  }
}
