import mongoose from 'mongoose';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { StockMovement } from '@models/stockMovement.model';
import { StockCount } from '@models/stockCount.model';
import { StockTransfer } from '@models/stockTransfer.model';

const OWNER_RULE = 'exactly one of eventId or venueId is required';
const id = () => new mongoose.Types.ObjectId();

/** The owner-rule error on `doc`, or undefined. Other validation errors are ignored. */
async function ownerError(doc: mongoose.Document): Promise<string | undefined> {
  try {
    await doc.validate();
    return undefined;
  } catch (e: any) {
    return e?.errors?.venueId?.message;
  }
}

const MODELS: Array<[string, mongoose.Model<any>]> = [
  ['Merchant', Merchant],
  ['MerchantOperator', MerchantOperator],
  ['Product', Product],
  ['ProductStock', ProductStock],
  ['StockMovement', StockMovement],
  ['StockCount', StockCount],
  ['StockTransfer', StockTransfer],
];

describe.each(MODELS)('%s — event-or-venue ownership', (_name, Model) => {
  it('accepts an eventId alone', async () => {
    expect(await ownerError(new Model({ eventId: id() }))).toBeUndefined();
  });

  it('accepts a venueId alone', async () => {
    expect(await ownerError(new Model({ venueId: id() }))).toBeUndefined();
  });

  it('refuses neither', async () => {
    expect(await ownerError(new Model({}))).toBe(OWNER_RULE);
  });

  it('refuses both', async () => {
    expect(await ownerError(new Model({ eventId: id(), venueId: id() }))).toBe(OWNER_RULE);
  });

  it('has a venueId-led index for venue queries', () => {
    const keys = Model.schema.indexes().map(([k]) => Object.keys(k)[0]);
    expect(keys).toContain('venueId');
  });
});
