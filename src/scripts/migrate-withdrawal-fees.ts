import mongoose from 'mongoose';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { TagWithdrawalRequest } from '@models/tagWithdrawalRequest.model';

async function main() {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);
  try {
    for (const model of [WalletWithdrawal, TagWithdrawalRequest] as const) {
      const result = await model.collection.updateMany({ payoutAmount: { $exists: false }, feeAmount: { $in: [null, 0] } },
        [{ $set: { feeAmount: 0, payoutAmount: '$amount' } }]);
      console.log(`${model.modelName}: snapshotted ${result.modifiedCount} historical zero-fee withdrawals`);
      if (await model.collection.countDocuments({ $or: [{ feeAmount: { $exists: false } }, { payoutAmount: { $exists: false } }] }))
        throw new Error(`${model.modelName}: withdrawal amounts need reconciliation`);
    }
  } finally { await mongoose.disconnect(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
