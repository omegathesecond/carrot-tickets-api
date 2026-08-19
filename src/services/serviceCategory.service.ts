import { ServiceCategory, IServiceCategory } from '@models/serviceCategory.model';
import { HttpError } from '@utils/httpError.util';

export interface ServiceCategoryView {
  value: string;
  label: string;
  icon: string | null;
  order: number;
}

export interface ServiceCategoryAdminView extends ServiceCategoryView {
  id: string;
  isActive: boolean;
}

function toView(doc: IServiceCategory): ServiceCategoryView {
  return { value: doc.value, label: doc.label, icon: doc.icon ?? null, order: doc.order };
}

function toAdminView(doc: IServiceCategory): ServiceCategoryAdminView {
  return { id: String(doc._id), ...toView(doc), isActive: doc.isActive };
}

/**
 * DB-backed replacement for the hardcoded SERVICE_CATEGORIES constant. The
 * constant (src/constants/serviceCategories.ts) is now only the SEED source
 * (src/scripts/seed-service-categories.ts) — every read here goes through
 * the `servicecategories` collection so an admin can add/edit categories
 * with no code deploy.
 */
export class ServiceCategoryService {
  /**
   * Active categories for public pickers (SERVICES signup form, /services
   * directory filter), sorted by admin-controlled order then label.
   */
  static async listActive(): Promise<ServiceCategoryView[]> {
    const rows = await ServiceCategory.find({ isActive: true }).sort({ order: 1, label: 1 }).lean();
    return rows.map((r) => ({ value: r.value, label: r.label, icon: r.icon ?? null, order: r.order }));
  }

  /**
   * Whether `value` is a currently-active category — the gate
   * TicketsAuthService.registerBusiness applies before creating a services
   * Vendor. An inactive or unknown value is invalid.
   */
  static async isValidActive(value: string): Promise<boolean> {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    const row = await ServiceCategory.exists({ value: normalized, isActive: true });
    return !!row;
  }

  /** All categories, including inactive — the admin manager's list view. */
  static async list(): Promise<ServiceCategoryAdminView[]> {
    const rows = await ServiceCategory.find({}).sort({ order: 1, label: 1 });
    return rows.map(toAdminView);
  }

  /**
   * Admin create. `value` is normalized (trim + lowercase) the same way the
   * schema does, so the friendly 409 fires before a duplicate-key error can
   * leak out of the schema's unique index.
   */
  static async create(input: { value: string; label: string; icon?: string; order?: number }): Promise<ServiceCategoryAdminView> {
    const value = input.value.trim().toLowerCase();
    const existing = await ServiceCategory.findOne({ value });
    if (existing) throw new HttpError(409, 'A service category with this value already exists');

    try {
      const doc = await ServiceCategory.create({
        value,
        label: input.label,
        icon: input.icon,
        order: input.order ?? 0,
      });
      return toAdminView(doc);
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'A service category with this value already exists');
      throw err;
    }
  }

  /**
   * Admin update. `value` is deliberately NOT accepted here — it is
   * immutable once created (it's what's persisted on Vendor.serviceCategory
   * and matched by the /services `?category=` filter; renaming it out from
   * under existing vendors would silently orphan them).
   */
  static async update(
    id: string,
    input: { label?: string; icon?: string; order?: number; isActive?: boolean }
  ): Promise<ServiceCategoryAdminView> {
    const doc = await ServiceCategory.findById(id);
    if (!doc) throw new HttpError(404, 'Service category not found');

    if (input.label !== undefined) doc.label = input.label;
    if (input.icon !== undefined) doc.icon = input.icon;
    if (input.order !== undefined) doc.order = input.order;
    if (input.isActive !== undefined) doc.isActive = input.isActive;
    await doc.save();

    return toAdminView(doc);
  }
}
