import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { notEndedFilter } from '@utils/eventVisibility.util';

/** Great-circle distance; no venue-text geocoding or invented coordinates. */
export function distanceKm(lat: number, lng: number, toLat: number, toLng: number): number {
  const rad = (n: number) => n * Math.PI / 180;
  const a = Math.sin(rad(toLat - lat) / 2) ** 2 +
    Math.cos(rad(lat)) * Math.cos(rad(toLat)) * Math.sin(rad(toLng - lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export class NearbyEventsService {
  static async find(lat: number, lng: number, radiusKm: number) {
    // Compute before limiting: a chronological page can omit the closest event.
    // No new geo index or data migration is required for this discovery query.
    const events = await Event.find({
      status: EventStatus.PUBLISHED,
      ...notEndedFilter(),
      'eventLocation.lat': { $gte: -90, $lte: 90 },
      'eventLocation.lng': { $gte: -180, $lte: 180 },
    }).select('eventLocation').lean();
    return events.flatMap((e) => {
      const point = e.eventLocation;
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return [];
      const distance = distanceKm(lat, lng, point.lat, point.lng);
      return distance <= radiusKm ? [{ id: String(e._id), distanceKm: distance }] : [];
    }).sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id)).slice(0, 50);
  }
}
