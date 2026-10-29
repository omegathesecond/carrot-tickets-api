import { createHash, timingSafeEqual } from 'crypto';
import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { EventTag } from '@models/eventTag.model';
import { Wallet } from '@models/wallet.model';
import { TagWithdrawalRequest, TagWithdrawalStatus } from '@models/tagWithdrawalRequest.model';
import { WalletService } from '@services/wallet.service';
import { FloatTag } from '@interfaces/ledger.interface';
import { assertValidBandUid } from '@utils/bandUid.util';
import { HttpError } from '@utils/httpError.util';
import { encryptOperatorPin, decryptOperatorPin } from '@utils/operatorPinEncryption.util';
import { validateTagWithdrawalInput, TagWithdrawalDetails } from '@utils/tagWithdrawalDetails.util';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const oid = (value: string) => {
  if (!/^[a-fA-F0-9]{24}$/.test(value)) throw new HttpError(400, 'Invalid request identifier');
  return new mongoose.Types.ObjectId(value);
};
function uid(value: string) {
  try { return assertValidBandUid(value); }
  catch { throw new HttpError(400, 'Enter the printed tag code, using letters A–F and numbers'); }
}

/** Public responses never contain destinations, contact details, ciphertext or staff identities. */
export function publicTagWithdrawal(row: any) {
  return { id: String(row._id), eventName: row.eventName, bandUid: row.bandUid,
    amount: row.amount, currency: row.currency, method: row.method, status: row.status,
    createdAt: row.createdAt, paidAt: row.paidAt, paymentReference: row.paymentReference,
    rejectionReason: row.rejectionReason };
}

export class TagWithdrawalService {
  static async lookup(rawCode: string, eventId: string) {
    const bandUid = uid(rawCode);
    const id = oid(eventId);
    const [wallet, event, registered] = await Promise.all([
      Wallet.findOne({ bandUid, eventId: id }).lean(),
      Event.findOne({ _id: id, cashless: true }).select('name endTime currency').lean(),
      EventTag.exists({ bandUid, eventId: id, status: 'active' }),
    ]);
    if (!wallet || !event || !registered) throw new HttpError(404, 'No registered wallet was found for that tag code in this event');
    const ended = event.endTime.getTime() < Date.now();
    const reason = !ended ? 'Withdrawals open after this event ends' : wallet.status !== 'active'
      ? 'This tag is unavailable or already has a withdrawal in progress'
      : wallet.balance <= 0 ? 'There is no remaining balance to withdraw'
      : !['SZL', 'ZAR'].includes(wallet.currency) ? 'This wallet currency is not supported; contact Carrot support' : null;
    return { walletId: String(wallet._id), eventId, eventName: event.name,
      endTime: event.endTime, currency: wallet.currency, balance: wallet.balance, eligible: reason === null, reason };
  }

  static async request(input: unknown, actor: string) {
    const value = validateTagWithdrawalInput(input);
    const bandUid = uid(value.bandUid);
    const eventId = oid(value.eventId);
    const trackingHash = hash(value.trackingToken);
    const inputHash = hash(JSON.stringify({ bandUid, eventId: String(eventId), amount: value.expectedAmount,
      country: value.country, method: value.method, details: value.details, trackingHash }));
    const replay = async () => {
      const row = await TagWithdrawalRequest.findOne({ eventId, bandUid, clientTxnId: value.clientTxnId }).select('+inputHash');
      if (!row) return null;
      if (row.inputHash !== inputHash) throw new HttpError(409, 'This request reference was already used with different details');
      return publicTagWithdrawal(row);
    };
    const existing = await replay();
    if (existing) return existing;
    const requestId = new mongoose.Types.ObjectId();
    const encrypted = encryptOperatorPin(JSON.stringify(value.details), `tag-withdrawal:${requestId}`);
    await TagWithdrawalRequest.init();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const event = await Event.findOne({ _id: eventId, cashless: true }).session(session);
        if (!event) throw new HttpError(404, 'Cashless event not found');
        if (event.endTime.getTime() >= Date.now()) throw new HttpError(409, 'Withdrawals open after the event ends');
        const registered = await EventTag.exists({ eventId, bandUid, status: 'active' }).session(session);
        if (!registered) throw new HttpError(404, 'This tag is not registered for that event');
        const wallet = await Wallet.findOneAndUpdate({ eventId, bandUid, status: 'active',
          currency: { $in: ['SZL', 'ZAR'] }, balance: value.expectedAmount }, { $set: { status: 'frozen' } }, { new: true, session });
        if (!wallet) throw new HttpError(409, 'The balance or tag availability changed. Check the code again before requesting');
        const summary = value.details.bank ? `${value.details.bank.bank} ••••${value.details.bank.accountNumber.slice(-4)}`
          : `${value.details.provider} ••••${value.details.mobileNumber!.slice(-4)}`;
        await TagWithdrawalRequest.create([{ _id: requestId, walletId: wallet._id, eventId, eventName: event.name,
          bandUid, amount: wallet.balance, currency: wallet.currency, country: value.country, method: value.method,
          detailsEncrypted: encrypted, destinationSummary: summary, clientTxnId: value.clientTxnId,
          trackingHash, inputHash, status: 'pending', active: true,
          history: [{ status: 'pending', at: new Date(), by: actor }] }], { session });
      });
    } catch (error: any) {
      if (error.code === 11000 || error instanceof HttpError && error.statusCode === 409) {
        const duplicate = await replay();
        if (duplicate) return duplicate;
      }
      if (error.code === 11000) throw new HttpError(409, 'This tag already has a withdrawal request in progress');
      throw error;
    } finally { await session.endSession(); }
    return publicTagWithdrawal(await TagWithdrawalRequest.findById(requestId));
  }

  static async track(id: string, token: string, eventId: string) {
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) throw new HttpError(404, 'Withdrawal request not found');
    const row = await TagWithdrawalRequest.findOne({ _id: oid(id), eventId: oid(eventId) }).select('+trackingHash');
    if (!row || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.trackingHash)))
      throw new HttpError(404, 'Withdrawal request not found');
    return publicTagWithdrawal(row);
  }

  static async detail(id: string) {
    const row = await TagWithdrawalRequest.findById(oid(id)).select('+detailsEncrypted');
    if (!row) throw new HttpError(404, 'Withdrawal request not found');
    const { detailsEncrypted, ...safe } = row.toObject();
    const details: TagWithdrawalDetails = JSON.parse(decryptOperatorPin(detailsEncrypted, `tag-withdrawal:${row._id}`));
    return { ...safe, details };
  }

  static async transition(id: string, status: TagWithdrawalStatus, actor: string, input: { paymentReference?: string; paymentCompleted?: boolean; rejectionReason?: string }) {
    if (!['processing', 'paid', 'rejected'].includes(status)) throw new HttpError(400, 'Invalid withdrawal decision');
    const reference = input.paymentReference?.trim();
    const reason = input.rejectionReason?.trim();
    if (status === 'paid' && (input.paymentCompleted !== true || !reference || reference.length > 120))
      throw new HttpError(400, 'Confirm that payment was sent and enter its payment reference');
    if (status === 'rejected' && (!reason || reason.length > 1000)) throw new HttpError(400, 'Enter a rejection reason');
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const row = await TagWithdrawalRequest.findById(oid(id)).session(session);
        if (!row) throw new HttpError(404, 'Withdrawal request not found');
        // Replaying the same payment reference is safe; conflicting decisions are not.
        if (row.status === 'paid' && status === 'paid' && row.paymentReference === reference) return;
        if (status === 'processing' && row.status === 'processing' && row.processingBy === actor) return;
        if (status === 'rejected' && row.status === 'rejected' && row.rejectionReason === reason) return;
        if (status === 'processing' ? row.status !== 'pending' : status === 'paid'
          ? row.status !== 'processing' || row.processingBy !== actor
          : !['pending', 'processing'].includes(row.status) || row.status === 'processing' && row.processingBy !== actor)
          throw new HttpError(409, 'This request changed or is assigned to another administrator; refresh it');
        if (status === 'paid') {
          const event = await Event.findById(row.eventId).session(session);
          const wallet = await Wallet.findOne({ _id: row.walletId, eventId: row.eventId, status: 'frozen', balance: row.amount, currency: row.currency }).session(session);
          if (!wallet || !event || event.endTime.getTime() >= Date.now())
            throw new HttpError(409, 'Reserved balance or event settings changed; reconcile before confirming payment');
          await WalletService.recordWithdrawal({ walletId: String(row.walletId), eventId: String(row.eventId),
            amount: row.amount, recordedBy: actor, recordedByType: 'Vendor', method: row.method as 'mobile_money' | 'bank_transfer',
            floatTag: FloatTag.OFFICE, clientTxnId: `tag-request:${row._id}`, requiredStatus: 'frozen', closeWallet: true, session });
          row.paidAt = new Date(); row.paymentReference = reference!;
        } else if (status === 'rejected') {
          const released = await Wallet.updateOne({ _id: row.walletId, eventId: row.eventId, status: 'frozen', balance: row.amount },
            { $set: { status: 'active' } }, { session });
          if (released.modifiedCount !== 1) throw new HttpError(409, 'Reserved balance changed; reconcile before releasing it');
          row.rejectionReason = reason!;
        } else { row.processingBy = actor; }
        row.status = status;
        row.active = status === 'pending' || status === 'processing';
        row.history.push({ status, at: new Date(), by: actor, ...(status === 'rejected' ? { note: reason! } : {}) });
        await row.save({ session });
      });
    } finally { await session.endSession(); }
    return TagWithdrawalRequest.findById(oid(id));
  }
}
