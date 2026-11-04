import mongoose from 'mongoose';
import { scopeIds, scopeMatch, scopeOfDoc, requireScopeOf, belongsToScope, ownerWord } from '@utils/tradingScope.util';

const E = new mongoose.Types.ObjectId().toHexString();
const V = new mongoose.Types.ObjectId().toHexString();

describe('tradingScope util', () => {
  it('an event scope becomes an eventId filter', () => {
    const m = scopeMatch(scopeIds({ kind: 'event', eventId: E }));
    expect(Object.keys(m)).toEqual(['eventId']);
    expect(String((m as { eventId: unknown }).eventId)).toBe(E);
  });

  it('a venue scope becomes a venueId filter', () => {
    const m = scopeMatch({ venueId: V });
    expect(Object.keys(m)).toEqual(['venueId']);
    expect(String((m as { venueId: unknown }).venueId)).toBe(V);
  });

  it('refuses an owner with neither id', () => {
    expect(() => scopeMatch({} as never)).toThrow('scope requires an eventId or a venueId');
  });

  it('reads the owner of a document', () => {
    expect(scopeOfDoc({ eventId: E })).toEqual({ kind: 'event', eventId: E });
    expect(scopeOfDoc({ venueId: new mongoose.Types.ObjectId(V) })).toEqual({ kind: 'venue', venueId: V });
    expect(scopeOfDoc({})).toBeNull();
    expect(scopeOfDoc(null)).toBeNull();
  });

  it('requireScopeOf throws loudly for an ownerless document', () => {
    expect(() => requireScopeOf({})).toThrow('document has neither an eventId nor a venueId');
  });

  it('belongsToScope needs the same kind AND the same id', () => {
    const venue = { kind: 'venue', venueId: V } as const;
    expect(belongsToScope({ venueId: V }, venue)).toBe(true);
    expect(belongsToScope({ venueId: new mongoose.Types.ObjectId().toHexString() }, venue)).toBe(false);
    expect(belongsToScope({ eventId: V }, venue)).toBe(false); // same hex, wrong kind
    expect(belongsToScope({ eventId: E }, { kind: 'event', eventId: E })).toBe(true);
    expect(belongsToScope(null, venue)).toBe(false);
  });

  it('ownerWord names the owner kind in a refusal', () => {
    expect(ownerWord({ kind: 'event', eventId: E })).toBe('this event');
    expect(ownerWord({ kind: 'venue', venueId: V })).toBe('this venue');
  });
});
