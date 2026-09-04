import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { awardStoryPointsIfEligible, totalStoryPoints, STORY_POINTS, MAX_DAILY_STORY_AWARDS } from '@services/storyPoints.service';
import { StoryPointsAward } from '@models/storyPointsAward.model';

describe('storyPoints.service', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const buyerId = () => new mongoose.Types.ObjectId().toString();
  const storyId = () => new mongoose.Types.ObjectId().toString();

  it('awards STORY_POINTS for a fresh story and totals it for the buyer', async () => {
    const b = buyerId();
    await awardStoryPointsIfEligible(b, storyId());
    expect(await totalStoryPoints(b)).toBe(STORY_POINTS);
  });

  it('is idempotent per story — re-finalizing the same story never double-credits', async () => {
    const b = buyerId();
    const s = storyId();
    await awardStoryPointsIfEligible(b, s);
    await awardStoryPointsIfEligible(b, s);
    expect(await totalStoryPoints(b)).toBe(STORY_POINTS);
    expect(await StoryPointsAward.countDocuments({ buyerId: b })).toBe(1);
  });

  it(`stops paying out after ${MAX_DAILY_STORY_AWARDS} stories in one UTC day`, async () => {
    const b = buyerId();
    for (let i = 0; i < MAX_DAILY_STORY_AWARDS + 2; i++) {
      await awardStoryPointsIfEligible(b, storyId());
    }
    expect(await totalStoryPoints(b)).toBe(STORY_POINTS * MAX_DAILY_STORY_AWARDS);
    expect(await StoryPointsAward.countDocuments({ buyerId: b })).toBe(MAX_DAILY_STORY_AWARDS);
  });

  it('keeps each buyer\'s daily cap independent of other buyers', async () => {
    const a = buyerId();
    const c = buyerId();
    for (let i = 0; i < MAX_DAILY_STORY_AWARDS; i++) await awardStoryPointsIfEligible(a, storyId());
    await awardStoryPointsIfEligible(c, storyId());
    expect(await totalStoryPoints(a)).toBe(STORY_POINTS * MAX_DAILY_STORY_AWARDS);
    expect(await totalStoryPoints(c)).toBe(STORY_POINTS);
  });

  it('is zero for a buyer with no awards', async () => {
    expect(await totalStoryPoints(buyerId())).toBe(0);
  });

  it(`enforces the daily cap atomically under concurrent finalizeStory() calls (TOCTOU regression)`, async () => {
    const b = buyerId();
    await Promise.all(
      Array.from({ length: MAX_DAILY_STORY_AWARDS + 1 }, () => awardStoryPointsIfEligible(b, storyId())),
    );
    expect(await totalStoryPoints(b)).toBe(STORY_POINTS * MAX_DAILY_STORY_AWARDS);
    expect(await StoryPointsAward.countDocuments({ buyerId: b })).toBe(MAX_DAILY_STORY_AWARDS);
  });
});
