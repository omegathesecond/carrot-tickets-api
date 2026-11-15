import { Buyer } from '@models/buyer.model';
import { FollowService } from '@services/follow.service';
import { SuggestionsService } from '@services/suggestions.service';

it('paginates the entire seeded pool without shifting when follows change', async () => {
  const ids = Array.from({ length: 225 }, (_, i) => String(i));
  let following: string[] = [];
  jest.spyOn(FollowService, 'followingIds').mockImplementation(async () => following);
  jest.spyOn(Buyer, 'find').mockImplementation(((filter: any) => {
    if (!filter._id.$in) return { select: () => ({ sort: () => ({ lean: async () => ids.map((_id) => ({ _id })) }) }) };
    return Promise.resolve(filter._id.$in.filter((id: string) => !filter._id.$nin.includes(id)).map((_id: string) => ({ _id, username: _id })));
  }) as any);
  try {
    const actor = { type: 'buyer' as const, id: 'self' };
    const first = await SuggestionsService.onboardingPeople(actor, { seed: 123 });
    expect(first.people).toHaveLength(20);
    expect((await SuggestionsService.onboardingPeople(actor, { seed: 456 })).people).not.toEqual(first.people);
    following = [first.people[0]!.id];
    expect((await SuggestionsService.onboardingPeople(actor, { seed: 123 })).people.map((p) => p.id)).not.toContain(following[0]);
    const collected = first.people.map((p) => p.id);
    let more = first.hasMore;
    for (let page = 2; more; page++) {
      const result = await SuggestionsService.onboardingPeople(actor, { page, seed: 123 });
      collected.push(...result.people.map((p) => p.id));
      more = result.hasMore;
      expect(page).toBeLessThan(20);
    }
    expect(collected).toHaveLength(225);
    expect(new Set(collected).size).toBe(225);
  } finally { jest.restoreAllMocks(); }
});
