import mongoose from 'mongoose';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Event } from '@models/event.model';
import 'dotenv/config';

async function main() {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { autoIndex: false });
  const charges = await MerchantCharge.updateMany({ purchaseChargeAmount: { $exists: false } }, { $set: { purchaseChargeAmount: 0 } });
  const events = await Event.updateMany({ purchaseCharge: { $exists: false } }, { $set: { purchaseCharge: null } });
  console.log(`Initialized ${charges.modifiedCount} charges and ${events.modifiedCount} events`);
  await mongoose.disconnect();
}
main().catch(async (error) => { console.error(error); await mongoose.disconnect(); process.exitCode = 1; });
