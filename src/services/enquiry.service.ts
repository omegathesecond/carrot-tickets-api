import { Enquiry, IEnquiry, EnquiryStatus } from '@models/enquiry.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { IBuyer } from '@models/buyer.model';
import { NotificationService } from '@services/notification.service';
import { HttpError } from '@utils/httpError.util';

export class EnquiryService {
  /** Creates the lead AND the proof-of-contact (later unlocks a review — Task
   *  E2) in one write, then notifies the business. The notification is NOT
   *  best-effort: a lead the business never sees in its inbox is a real,
   *  user-facing failure, so a failed NotificationService.create throws and
   *  propagates — no silent swallow. */
  static async create(
    businessId: string,
    buyer: IBuyer,
    input: { message: string; eventDate?: string; eventType?: string; contactPhone?: string; contactEmail?: string }
  ): Promise<IEnquiry> {
    const biz = await Vendor.findOne({
      _id: businessId,
      operatorType: OperatorType.SERVICES,
      verificationStatus: VerificationStatus.VERIFIED,
      isActive: true,
    });
    if (!biz) throw new HttpError(404, 'Business not found');
    if (!input.message?.trim()) throw new HttpError(400, 'A message is required');

    const enquiry = await Enquiry.create({
      businessId: biz._id,
      customerId: buyer._id,
      message: input.message.trim(),
      eventDate: input.eventDate ? new Date(input.eventDate) : undefined,
      eventType: input.eventType,
      contactPhone: input.contactPhone ?? (buyer as any).phone,
      contactEmail: input.contactEmail ?? (buyer as any).email,
    });

    // Best-effort surface is NOT allowed here — an enquiry the business never
    // sees is a lost lead, so a failed notification must throw (no silent swallow).
    await NotificationService.create(
      'vendor',
      String(biz._id),
      'enquiry_received',
      'New enquiry',
      `${(buyer as any).name ?? 'Someone'} sent you an enquiry`,
      { buyerId: String(buyer._id), enquiryId: String(enquiry._id) }
    );

    return enquiry;
  }

  static async hasEnquired(buyerId: string, businessId: string): Promise<boolean> {
    return (await Enquiry.exists({ customerId: buyerId, businessId })) != null;
  }

  static async listForBusiness(vendorId: string, opts: { before?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const q: Record<string, unknown> = { businessId: vendorId };
    if (opts.before) q['_id'] = { $lt: opts.before };
    return Enquiry.find(q).sort({ _id: -1 }).limit(limit).populate('customerId', 'name username avatarUrl phone email');
  }

  static async setStatus(vendorId: string, enquiryId: string, status: EnquiryStatus): Promise<IEnquiry> {
    const updated = await Enquiry.findOneAndUpdate({ _id: enquiryId, businessId: vendorId }, { $set: { status } }, { new: true });
    if (!updated) throw new HttpError(404, 'Enquiry not found');
    return updated;
  }
}
