import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { distanceKm, NearbyEventsService } from '../nearbyEvents.service';
import { eventLocationSchema } from '@validators/tickets.validator';

describe('Nearby event discovery', () => {
  afterEach(() => jest.restoreAllMocks());
  it('calculates great-circle distance including zero coordinates and the date line', () => {
    expect(distanceKm(0, 0, 0, 0)).toBe(0);
    expect(distanceKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2);
    expect(distanceKm(0, 179.99, 0, -179.99)).toBeCloseTo(2.224, 2);
    expect(distanceKm(0, 0, 0, 180)).toBeCloseTo(20015.087, 2);
  });
  it('validates a complete point, permits explicit removal, rejects invalid/partial points', () => {
    expect(eventLocationSchema.validate({ lat: 0, lng: 0 }).error).toBeUndefined();
    expect(eventLocationSchema.validate(null).error).toBeUndefined();
    for (const value of [{ lat: 1 }, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: NaN, lng: 0 }]) {
      expect(eventLocationSchema.validate(value).error).toBeDefined();
    }
  });
  it('uses published, not-ended events with coordinates, filters radius before limiting, nearest first', async () => {
    const events = [
      { _id: 'far', eventLocation: { lat: 0, lng: 1 } },
      { _id: 'near', eventLocation: { lat: 0, lng: 0.01 } },
      { _id: 'missing' },
      { _id: 'invalid', eventLocation: { lat: null, lng: null } },
      { _id: 'here', eventLocation: { lat: 0, lng: 0 } },
    ];
    const lean = jest.fn().mockResolvedValue(events);
    const find = jest.spyOn(Event, 'find').mockReturnValue({ select: jest.fn().mockReturnValue({ lean }) } as any);
    const rows = await NearbyEventsService.find(0, 0, 25);
    expect(rows.map((e) => e.id)).toEqual(['here', 'near']);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({
      status: EventStatus.PUBLISHED, endTime: { $gte: expect.any(Date) },
      'eventLocation.lat': { $gte: -90, $lte: 90 },
      'eventLocation.lng': { $gte: -180, $lte: 180 },
    }));
  });
  it('propagates dependency failures', async () => {
    jest.spyOn(Event, 'find').mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error('DB unavailable')) }) } as any);
    await expect(NearbyEventsService.find(0, 0, 25)).rejects.toThrow('DB unavailable');
  });
  it('stores no invented coordinates when location is absent', () => {
    const event = new Event({ name: 'No location' });
    expect(event.eventLocation).toBeUndefined();
    event.eventLocation = { lat: 0, lng: 0 };
    expect(event.eventLocation?.lat).toBe(0);
  });
});
