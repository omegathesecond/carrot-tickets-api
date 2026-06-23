import mongoose, { Schema } from 'mongoose';

export interface ITicketReservation extends mongoose.Document {
  eventId: mongoose.Types.ObjectId;
  ticketTypeId: string;
  quantity: number;
  saleId: mongoose.Types.ObjectId;
  expiresAt: Date;
  status: 'held' | 'confirmed' | 'released';
}

const schema = new Schema<ITicketReservation>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  ticketTypeId: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  saleId: { type: Schema.Types.ObjectId, ref: 'TicketSale', required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['held', 'confirmed', 'released'], default: 'held', index: true },
}, { timestamps: true });

export const TicketReservation = mongoose.model<ITicketReservation>('TicketReservation', schema);
