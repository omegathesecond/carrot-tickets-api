import { Schema, model, Document } from 'mongoose';

/**
 * A message submitted through the public "Contact Support" form on the
 * marketing site (carrottickets.com/contact).
 *
 * There is no email provider wired into this service and SMS is too small to
 * carry a support message, so the DURABLE record of a contact request is this
 * collection — nothing is ever lost even if the best-effort SMS alert to the
 * support line fails. Status lets support triage: 'new' until someone actions
 * it, then 'read' / 'resolved'.
 */
export type ContactMessageStatus = 'new' | 'read' | 'resolved';

export interface IContactMessage extends Document {
  name: string;
  email: string;
  subject: string;
  message: string;
  status: ContactMessageStatus;
  createdAt: Date;
  updatedAt: Date;
}

const contactMessageSchema = new Schema<IContactMessage>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    status: { type: String, enum: ['new', 'read', 'resolved'], default: 'new', index: true },
  },
  { timestamps: true }
);

// Newest-first is how support will read them.
contactMessageSchema.index({ createdAt: -1 });

export const ContactMessage = model<IContactMessage>('ContactMessage', contactMessageSchema);
