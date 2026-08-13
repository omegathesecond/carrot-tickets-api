import { Schema, model, Document, Types } from 'mongoose';

export type EnquiryStatus = 'new' | 'read' | 'replied' | 'closed';

export interface IEnquiry extends Document {
  businessId: Types.ObjectId;
  customerId: Types.ObjectId;
  eventDate?: Date;
  eventType?: string;
  message: string;
  contactPhone?: string;
  contactEmail?: string;
  status: EnquiryStatus;
  createdAt: Date;
  updatedAt: Date;
}

const enquirySchema = new Schema<IEnquiry>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    eventDate: { type: Date },
    eventType: { type: String, trim: true, maxlength: 100 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    contactPhone: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    status: { type: String, enum: ['new', 'read', 'replied', 'closed'], default: 'new', required: true },
  },
  { timestamps: true }
);

enquirySchema.index({ businessId: 1, createdAt: -1 });
enquirySchema.index({ customerId: 1, businessId: 1 });

export const Enquiry = model<IEnquiry>('Enquiry', enquirySchema);
