// api/src/services/posCatalog.service.ts
import { Product, IProduct } from '@models/product.model';
import { ProductStock, IProductStock } from '@models/productStock.model';
import { Merchant } from '@models/merchant.model';
import { ProductCategory } from '@interfaces/stock.interface';

export type PosTileStatus = 'in_stock' | 'low' | 'sold_out';

/**
 * One product tile as the handhelds render it. Price is integer minor units —
 * the client formats it against the event's own currency, so nothing here
 * names or symbolises one.
 */
export interface PosTile {
  productId: string;
  name: string;
  price: number;
  barcode: string | null;
  category: ProductCategory;
  imageUrl: string | null;
  unitLabel: string;
  unitsPerPack: number | null;
  packLabel: string | null;
  onHand: number;
  lowStockThreshold: number | null;
  status: PosTileStatus;
}

/** The product fields a tile is built from. Structural rather than IProduct so
 *  a .lean() row satisfies it without a cast — nothing here needs a document. */
type CatalogProduct = Pick<
  IProduct, 'name' | 'price' | 'barcode' | 'category' | 'imageUrl' | 'unitLabel' | 'unitsPerPack' | 'packLabel'
> & { _id: unknown };

/** The stall's count for it. Same reasoning. */
type CatalogStock = Pick<IProductStock, 'onHand' | 'lowStockThreshold'>;

/** A tile in a grid that spans stalls, so each one must say whose shelf it is on. */
export interface StallPosTile extends PosTile {
  merchantId: string;
  merchantName: string;
}

/**
 * The POS-facing catalogue read-model: what a handheld may put on screen and
 * tap. Distinct from StockReportService, which answers the organizer's
 * "how is my inventory doing" questions over the same records.
 *
 * ONE definition of "this stall carries this product" — a ProductStock row —
 * shared by the stall's own grid and the waiter's event-wide one. That is the
 * same fact TableService.addItem and StockService.applyMovement enforce on the
 * write side ('product not sold at that stall'); a catalogue derived any other
 * way would offer tiles the add call then refuses.
 */
export class PosCatalogService {
  /** sold_out at 0, low at/below a set threshold, else in_stock. Drives the tile badges. */
  static statusOf(onHand: number, lowStockThreshold: number | null): PosTileStatus {
    if (onHand <= 0) return 'sold_out';
    if (lowStockThreshold != null && lowStockThreshold > 0 && onHand <= lowStockThreshold) return 'low';
    return 'in_stock';
  }

  /** Project one product + the stall's count for it into a tile. Optional
   *  fields are nulled rather than dropped: the clients read them as nullable,
   *  and an explicit null is the honest "this product has none". */
  static tile(product: CatalogProduct, stock?: CatalogStock | null): PosTile {
    const onHand = stock?.onHand ?? 0;
    const lowStockThreshold = stock?.lowStockThreshold ?? null;
    return {
      productId: String(product._id),
      name: product.name,
      price: product.price,
      barcode: product.barcode ?? null,
      category: product.category,
      imageUrl: product.imageUrl ?? null,
      unitLabel: product.unitLabel,
      unitsPerPack: product.unitsPerPack ?? null,
      packLabel: product.packLabel ?? null,
      onHand,
      lowStockThreshold,
      status: PosCatalogService.statusOf(onHand, lowStockThreshold),
    };
  }

  /**
   * One stall's catalogue, for its own POS: the products IT carries, in name
   * order. A stall carries a product iff it has a ProductStock row for it —
   * loading every product at the event and left-joining quantities made a
   * stall's handheld list its neighbours' items as permanent sold-out tiles.
   */
  static async forMerchant(merchantId: string, eventId: string): Promise<PosTile[]> {
    const rows = await ProductStock.find({ merchantId }).lean();
    const byProduct = new Map(rows.map((r) => [String(r.productId), r]));
    const products = await Product.find({
      eventId, active: true, _id: { $in: rows.map((r) => r.productId) },
    }).sort({ name: 1 }).lean();
    return products.map((p) => PosCatalogService.tile(p, byProduct.get(String(p._id))));
  }

  /**
   * The whole event's catalogue in ONE list, for the waiter working the floor
   * rather than a stall. A product carried by three stalls appears three
   * times: the waiter is choosing WHERE to fetch it from, and the count that
   * decides sold-out — and the stall that gets the order — differ per row.
   *
   * Scoped through the event's ACTIVE stalls rather than by ProductStock's own
   * eventId. Two reasons: a Merchant is the authoritative event boundary (it
   * is what the stall's own catalogue keys off), and a suspended stall must
   * not be offered to the floor — it can neither log its till in
   * (merchantAuth) nor take a charge (MerchantService.charge), so advertising
   * its shelves would be the one remaining way stock left a closed stall.
   */
  static async forEvent(eventId: string): Promise<StallPosTile[]> {
    const merchants = await Merchant.find({ eventId, status: 'active' }).select('name').lean();
    if (merchants.length === 0) return [];
    const merchantName = new Map(merchants.map((m: any) => [String(m._id), m.name as string]));

    const rows = await ProductStock.find({ merchantId: { $in: merchants.map((m: any) => m._id) } }).lean();
    if (rows.length === 0) return [];

    const products = await Product.find({
      eventId, active: true, _id: { $in: rows.map((r) => r.productId) },
    }).lean();
    const byId = new Map<string, CatalogProduct>(products.map((p) => [String(p._id), p]));

    return rows
      // A row whose product is retired (or belongs to another event) drops out
      // — same rule the stall's own grid applies via its Product query.
      .flatMap((r) => {
        const product = byId.get(String(r.productId));
        const name = merchantName.get(String(r.merchantId));
        if (!product || name === undefined) return [];
        return [{
          ...PosCatalogService.tile(product, r),
          merchantId: String(r.merchantId),
          merchantName: name,
        }];
      })
      // Product first, then stall: the grid is searched by what the guest
      // ordered, and the stalls carrying it sit together under that answer.
      .sort((a, b) => a.name.localeCompare(b.name) || a.merchantName.localeCompare(b.merchantName));
  }
}
