import { PREF_BY_TYPE } from '@services/notificationDispatcher.service';

describe('meetup notification types', () => {
  it('are wired into the social pref bucket', () => {
    expect(PREF_BY_TYPE['meetup_request']).toBe('social');
    expect(PREF_BY_TYPE['meetup_accepted']).toBe('social');
  });
});
