import { validateCreateItems } from '@utils/updateCreate.util';

const img = { ext: 'jpg', contentType: 'image/jpeg' };
const vid = { ext: 'mp4', contentType: 'video/mp4' };

it('rejects unknown kind', () => expect(validateCreateItems('gif', [img]).ok).toBe(false));
it('rejects empty items', () => expect(validateCreateItems('image', []).ok).toBe(false));
it('rejects 6 photos', () => expect(validateCreateItems('image', Array(6).fill(img)).ok).toBe(false));
it('rejects a non-image in a photo set', () => expect(validateCreateItems('image', [img, vid]).ok).toBe(false));
it('rejects a video post with 2 items', () => expect(validateCreateItems('video', [vid, vid]).ok).toBe(false));
it('accepts 1 photo', () => expect(validateCreateItems('image', [img]).ok).toBe(true));
it('accepts 5 photos', () => expect(validateCreateItems('image', Array(5).fill(img)).ok).toBe(true));
it('accepts 1 video', () => expect(validateCreateItems('video', [vid]).ok).toBe(true));
