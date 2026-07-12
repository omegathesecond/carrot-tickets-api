import mongoose from 'mongoose';

const updateSchema = new mongoose.Schema({}, { strict: false, collection: 'updates' });
export const Update = mongoose.model('Update', updateSchema);

export async function connect(): Promise<void> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
}
