import mongoose, { Schema } from 'mongoose';

// Serialization only; balances are derived from the durable money records.
const schema = new Schema({ _id: { type: String, required: true }, revision: { type: Number, required: true, default: 0 } });
export const CashDeskLock = mongoose.model('CashDeskLock', schema);
