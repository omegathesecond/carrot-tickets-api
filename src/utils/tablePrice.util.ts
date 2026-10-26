import { ITableLine } from '@interfaces/table.interface';
import { priceProductLine } from '@utils/productPrice.util';

/** Combine rounds only when stall, product and snapshotted offer all agree. */
export function priceTableLines(lines: ITableLine[]) {
  const groups = new Map<string, ITableLine>();
  for (const line of lines) {
    const key = JSON.stringify([String(line.merchantId), String(line.productId), line.unitPrice,
      line.bundlePrice?.quantity ?? null, line.bundlePrice?.price ?? null]);
    const group = groups.get(key);
    if (group) group.qty += line.qty;
    else groups.set(key, { _id: line._id, merchantId: line.merchantId, productId: line.productId,
      name: line.name, unitPrice: line.unitPrice, bundlePrice: line.bundlePrice,
      qty: line.qty, addedBy: line.addedBy, addedAt: line.addedAt });
  }
  const items = [...groups.values()].map(line => ({ ...line,
    ...priceProductLine({ price: line.unitPrice, bundlePrice: line.bundlePrice }, line.qty),
  }));
  const subtotal = items.reduce((sum, line) => sum + line.lineTotal, 0);
  if (!Number.isSafeInteger(subtotal)) throw new Error('order total is too large');
  return { items, subtotal };
}
