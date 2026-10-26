import { SalePricing } from '@interfaces/stock.interface';

/** Calculate the charge and its audit facts together, without rounding a per-unit discount. */
export function priceProductLine(product: {
  price: number;
  bundlePrice?: { quantity: number; price: number } | null;
}, qty: number): { lineTotal: number; pricing: SalePricing } {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('qty must be a positive integer');
  const bundle = product.bundlePrice;
  if (bundle && (!Number.isSafeInteger(bundle.quantity) || bundle.quantity < 2 ||
      !Number.isSafeInteger(bundle.price) || bundle.price < 1 ||
      bundle.price >= product.price * bundle.quantity)) throw new Error('Invalid product bundle price');
  const specialBundles = bundle ? Math.floor(qty / bundle.quantity) : 0;
  const specialUnits = specialBundles * (bundle?.quantity ?? 0);
  const regularUnits = qty - specialUnits;
  const lineTotal = regularUnits * product.price + specialBundles * (bundle?.price ?? 0);
  return { lineTotal, pricing: { regularUnits, specialUnits, specialBundles,
    ...(bundle ? { bundleQuantity: bundle.quantity, bundlePrice: bundle.price } : {}),
    discountAmount: product.price * qty - lineTotal } };
}
