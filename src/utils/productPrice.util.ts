/** Price complete discounted groups plus loose units, without rounding a per-unit discount. */
export function productLineTotal(product: {
  price: number;
  bundlePrice?: { quantity: number; price: number } | null;
}, qty: number): number {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('qty must be a positive integer');
  const bundle = product.bundlePrice;
  if (!bundle) return product.price * qty;
  if (!Number.isSafeInteger(bundle.quantity) || bundle.quantity < 2 ||
      !Number.isSafeInteger(bundle.price) || bundle.price < 1 ||
      bundle.price >= product.price * bundle.quantity) throw new Error('Invalid product bundle price');
  return Math.floor(qty / bundle.quantity) * bundle.price + (qty % bundle.quantity) * product.price;
}
