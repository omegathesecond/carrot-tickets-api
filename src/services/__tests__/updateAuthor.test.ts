import { resolveUpdateAuthor } from '@services/updateAuthor';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

jest.mock('@models/vendor.model', () => ({ Vendor: { findById: jest.fn() } }));
jest.mock('@models/buyer.model', () => ({ Buyer: { findById: jest.fn() } }));

const lean = (v: unknown) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });

describe('resolveUpdateAuthor', () => {
  it('maps a vendor author to organizer shape', async () => {
    (Vendor.findById as jest.Mock).mockReturnValue(lean({ businessName: 'Bushfire', slug: 'bushfire', logoUrl: 'https://cdn/l.png' }));
    const a = await resolveUpdateAuthor('vendor', 'v1');
    expect(a).toEqual({ type: 'organizer', id: 'v1', name: 'Bushfire', avatarUrl: 'https://cdn/l.png', slug: 'bushfire' });
  });

  it('maps a buyer author to buyer shape', async () => {
    (Buyer.findById as jest.Mock).mockReturnValue(lean({ name: 'Thabo', username: 'thabo', avatarUrl: null }));
    const a = await resolveUpdateAuthor('buyer', 'b1');
    expect(a).toEqual({ type: 'buyer', id: 'b1', name: 'Thabo', username: 'thabo', avatarUrl: null });
  });

  it('falls back to a safe organizer name when the vendor is missing', async () => {
    (Vendor.findById as jest.Mock).mockReturnValue(lean(null));
    const a = await resolveUpdateAuthor('vendor', 'gone');
    expect(a).toEqual({ type: 'organizer', id: 'gone', name: 'Organizer', avatarUrl: null, slug: undefined });
  });
});
