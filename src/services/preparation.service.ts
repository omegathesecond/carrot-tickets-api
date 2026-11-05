import { NotificationService } from '@services/notification.service';
import { Preparation } from '@models/preparation.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { IBuyer } from '@models/buyer.model';
import { isTicketHolderForBuyer } from '@utils/ticketHolder.util';
import { VISIBLE_BUSINESS_FILTER } from '@utils/businessVisibility.util';
import { HttpError } from '@utils/httpError.util';

interface RequestInput {
  category: string; budget: number; preferredDate: Date | string; location: string;
  note: string; mode: string; providerIds: string[];
}
interface OfferInput {
  price: number; description: string; availableTime: Date | string; location: string;
  photos: string[]; message: string; deposit: number; cancellationTerms: string;
}
interface RequestFilters { category?: string; eventId?: string; event?: string; location?: string; budget?: number; date?: string }

export class PreparationService {
  // Persist state and its user-facing notifications atomically. Retrying a
  // failed notification must never create an invisible duplicate request/offer.
  static async persist(request: InstanceType<typeof Preparation>, recipients: { type: 'buyer' | 'vendor'; id: string }[]) {
    await Preparation.db.transaction(async session => {
      await request.save({ session });
      const uniqueRecipients = new Map(recipients.map(recipient => [`${recipient.type}:${recipient.id}`, recipient]));
      for (const recipient of uniqueRecipients.values()) {
        await NotificationService.create(recipient.type, recipient.id, 'preparation_update',
          'Event preparation updated', `${request.category.replace(/_/g, ' ')} — ${request.status}`,
          { eventId: String(request.eventId), requestId: String(request._id) }, session);
      }
    });
    return request;
  }

  static async holder(eventId: string, buyer: IBuyer) {
    if (!await isTicketHolderForBuyer(eventId, buyer)) throw new HttpError(403, 'A valid ticket for this event is required');
    const event = await Event.findById(eventId).select('name eventDate currency');
    if (!event) throw new HttpError(404, 'Event not found');
    return event;
  }

  static async provider(vendorId: string) {
    const provider = await Vendor.findOne({ _id: vendorId, ...VISIBLE_BUSINESS_FILTER });
    if (!provider) throw new HttpError(403, 'An active service-provider account is required');
    return provider;
  }

  static eligible(request: { category: string; mode: string; providerIds: unknown[] }, provider: { _id?: unknown; serviceCategories?: string[] }) {
    return (provider.serviceCategories || []).includes(request.category) &&
      (request.mode === 'open' || request.providerIds.some(id => String(id) === String(provider._id)));
  }

  static async mine(eventId: string, buyer: IBuyer) {
    const event = await this.holder(eventId, buyer);
    const requests = await Preparation.find({ eventId, buyerId: buyer._id, status: { $ne: 'removed' } }).sort({ createdAt: -1 });
    return { event, requests };
  }

  static async save(eventId: string, buyer: IBuyer, input: RequestInput, id?: string) {
    await this.holder(eventId, buyer);
    if (input.mode === 'invite') {
      if (input.category === 'event_companion') throw new HttpError(400, 'Companion requests must be open to ticket holders');
      const providers = await Vendor.find({ _id: { $in: input.providerIds }, ...VISIBLE_BUSINESS_FILTER, serviceCategories: input.category }).select('_id');
      if (!input.providerIds.length || providers.length !== input.providerIds.length) throw new HttpError(400, 'Select eligible providers for this service');
    } else input.providerIds = [];
    if (!id) return this.persist(new Preparation({ ...input, buyerId: buyer._id, eventId }), input.providerIds.map((id: string) => ({ type: 'vendor' as const, id })));
    const request = await Preparation.findOne({ _id: id, buyerId: buyer._id, eventId, status: 'looking' });
    if (!request) throw new HttpError(409, 'Only an unbooked request can be edited');
    const recipients = request.offers.map(o => ({ type: o.actorType as 'buyer' | 'vendor', id: String(o.actorId) }));
    request.offers.splice(0);
    request.set(input);
    return this.persist(request, [...recipients, ...input.providerIds.map((id: string) => ({ type: 'vendor' as const, id }))]);
  }

  static async remove(eventId: string, buyer: IBuyer, id: string) {
    await this.holder(eventId, buyer);
    const request = await Preparation.findOne({ _id: id, buyerId: buyer._id, eventId, status: 'looking' });
    if (!request) throw new HttpError(409, 'Booked requests cannot be removed; contact your provider to arrange cancellation');
    request.status = 'removed';
    return this.persist(request, request.offers.map(o => ({ type: o.actorType as 'buyer' | 'vendor', id: String(o.actorId) })));
  }

  static async list(vendorId: string, filters: RequestFilters) {
    const provider = await this.provider(vendorId);
    const query: Record<string, unknown> = {
      category: { $in: provider.serviceCategories },
      status: { $ne: 'removed' },
      $or: [{ mode: 'open' }, { mode: 'invite', providerIds: provider._id }],
    };
    if (filters.category) {
      if (!provider.serviceCategories?.includes(filters.category)) return [];
      query.category = filters.category;
    }
    if (filters.eventId) query.eventId = filters.eventId;
    if (filters.event) {
      const events = await Event.find({ name: { $regex: filters.event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }).select('_id').limit(100);
      query.eventId = { $in: events.map(event => event._id) };
    }
    if (filters.location) query.location = { $regex: filters.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (filters.budget !== undefined) query.budget = { $gte: filters.budget };
    if (filters.date) query.preferredDate = { $gte: new Date(filters.date), $lt: new Date(new Date(filters.date).getTime() + 86400000) };
    const rows = await Preparation.find(query).populate('eventId', 'name eventDate currency').sort({ createdAt: -1 }).limit(100).lean();
    // Never expose other providers' offers, invite lists or buyer contact handles.
    return rows.map(row => ({ ...row, providerIds: undefined, buyerId: undefined, offers: row.offers.filter(o => String(o.actorId) === vendorId) }));
  }

  static async offer(id: string, actor: { id: string; type: 'vendor' | 'buyer'; name: string; buyer?: IBuyer }, input: OfferInput) {
    const request = await Preparation.findById(id);
    if (!request || request.status !== 'looking') throw new HttpError(409, 'This request is no longer looking for offers');
    if (actor.type === 'vendor') {
      const provider = await this.provider(actor.id);
      if (!this.eligible(request, provider)) throw new HttpError(403, 'You are not eligible for this request');
      actor.name = provider.businessName;
    } else {
      if (request.category !== 'event_companion' || request.mode !== 'open' || !actor.buyer || String(request.buyerId) === actor.id) throw new HttpError(403, 'Not eligible for this companion request');
      await this.holder(String(request.eventId), actor.buyer);
    }
    if (request.offers.some(o => String(o.actorId) === actor.id && o.actorType === actor.type)) throw new HttpError(409, 'You already sent an offer');
    request.offers.push({ ...input, actorId: actor.id, actorType: actor.type, name: actor.name });
    await this.persist(request, [{ type: 'buyer', id: String(request.buyerId) }]);
    return { _id: request._id, status: request.status };
  }

  static async accept(eventId: string, buyer: IBuyer, id: string, offerId: string) {
    await this.holder(eventId, buyer);
    const request = await Preparation.findOne({ _id: id, eventId, buyerId: buyer._id, status: 'looking' });
    if (!request) throw new HttpError(409, 'Request is no longer available');
    const offer = request.offers.id(offerId);
    if (!offer) throw new HttpError(404, 'Offer not found');
    if (offer.actorType === 'vendor') {
      if (!this.eligible(request, await this.provider(String(offer.actorId)))) throw new HttpError(409, 'Provider is no longer eligible');
    } else {
      const { Buyer } = await import('@models/buyer.model');
      const companion = await Buyer.findById(offer.actorId);
      if (!companion) throw new HttpError(409, 'Companion is no longer available');
      await this.holder(eventId, companion);
    }
    request.status = 'booked';
    request.acceptedOfferId = offer._id;
    return this.persist(request, [{ type: offer.actorType as 'buyer' | 'vendor', id: String(offer.actorId) }]);
  }

  static async companions(eventId: string, buyer: IBuyer) {
    await this.holder(eventId, buyer);
    const rows = await Preparation.find({ eventId, buyerId: { $ne: buyer._id }, category: 'event_companion', mode: 'open', status: 'looking' }).sort({ createdAt: -1 }).limit(100).lean();
    return rows.map(row => ({ ...row, buyerId: undefined, providerIds: undefined, offers: row.offers.filter(o => String(o.actorId) === String(buyer._id)) }));
  }
}
