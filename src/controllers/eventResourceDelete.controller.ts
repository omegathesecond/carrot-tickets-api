import { decryptOperatorPin } from '@utils/operatorPinEncryption.util';
import { RequestHandler } from 'express';
import mongoose, { Model } from 'mongoose';
import { MerchantOperator } from '@models/merchantOperator.model';
import { CashCollection } from '@models/cashCollection.model';
import { Table } from '@models/table.model';
import { ApiResponseUtil } from '@utils/apiResponse.util';

/** Retain identities referenced by money, stock and activity records. Routes are Super Admin only. */
export function deleteEventResource(model: Model<any>, stall = false): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = req.params['id'];
      if (!mongoose.Types.ObjectId.isValid(String(id))) {
        ApiResponseUtil.badRequest(res, 'Invalid resource ID'); return;
      }
      if (stall && await Table.exists({ $or: [
        { status: 'open', 'items.merchantId': id },
        { status: 'settled', fulfilment: { $elemMatch: { merchantId: id, status: { $ne: 'collected' } } } },
      ] })) {
        ApiResponseUtil.error(res, 'Finish the stall’s open tables and collections before deleting it', 409); return;
      }
      if (model.modelName === 'Waiter' && await Table.exists({ openedBy: id, $or: [
        { status: 'open' },
        { status: 'settled', fulfilment: { $elemMatch: { status: { $ne: 'collected' } } } },
      ] })) {
        ApiResponseUtil.error(res, 'Finish this waiter’s tables and collections before deleting the account', 409); return;
      }
      if (!stall && await CashCollection.exists({ status: 'pending', $or: [{ cashierId: id }, { collectorId: id }] })) {
        ApiResponseUtil.error(res, 'Resolve pending cash collections before deleting the account', 409); return;
      }
      const deletedAt = new Date();
      const row = await model.findOneAndUpdate(
        { _id: id, deletedAt: null },
        { $set: { deletedAt, ...(stall ? { status: 'suspended' } : { isActive: false }) } },
        { new: true },
      );
      if (!row) { ApiResponseUtil.notFound(res, 'Resource not found'); return; }
      // A stall's staff also lose access and leave its management list.
      if (stall) await MerchantOperator.updateMany({ merchantId: id }, { $set: { deletedAt, isActive: false } });
      ApiResponseUtil.success(res, { deleted: true });
    } catch (err) { next(err); }
  };
}

/** Credentials are selected only by this privileged endpoint and never cached. */
export function revealEventOperatorPin(model: Model<any>): RequestHandler {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const id = req.params['id'];
      if (!mongoose.Types.ObjectId.isValid(String(id))) {
        ApiResponseUtil.badRequest(res, 'Invalid resource ID'); return;
      }
      const row = await model.findOne({ _id: id, deletedAt: null }).select('+encryptedPin');
      if (!row) { ApiResponseUtil.notFound(res, 'Account not found'); return; }
      if (!row.encryptedPin) {
        ApiResponseUtil.error(res, 'This PIN was created before PIN viewing was enabled. Reset it once to enable Show PIN.', 409); return;
      }
      const pin = decryptOperatorPin(row.encryptedPin, String(row._id));
      ApiResponseUtil.success(res, { loginCode: row.loginCode, pin });
    } catch (err) { next(err); }
  };
}
