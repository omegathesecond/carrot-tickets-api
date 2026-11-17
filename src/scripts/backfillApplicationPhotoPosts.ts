import mongoose from 'mongoose';
import { MarketApplication } from '../marketplace/models';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { publishApplicationPhotos } from '@services/applicationPhotoPosts.service';

/** Run explicitly after deployment; safe to resume without resurrecting removed posts. */
export async function backfillApplicationPhotoPosts() {
  let applications = 0;
  for await (const application of MarketApplication.find({ 'profile.experiencePhotos.0': { $exists: true } }).sort({ createdAt: 1 }).cursor()) {
    const [buyer, vendor] = await Promise.all([Buyer.exists({ _id: application.ownerId }), Vendor.exists({ _id: application.ownerId })]);
    if (Boolean(buyer) === Boolean(vendor)) throw new Error(`Cannot uniquely identify application owner ${application.ownerId}`);
    await publishApplicationPhotos(buyer ? 'buyer' : 'vendor', application.ownerId, application.profile!.experiencePhotos!, application.createdAt);
    applications++;
  }
  return { applications };
}
if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    try { await mongoose.connect(uri); console.log(await backfillApplicationPhotoPosts()); }
    finally { await mongoose.disconnect(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
