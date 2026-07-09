import { Buyer, IBuyer } from '@models/buyer.model';

export const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

export const RESERVED_USERNAMES = [
  'admin', 'administrator', 'carrot', 'carrottickets', 'support', 'help',
  'moderator', 'mod', 'organizer', 'system', 'root',
];

const ADJECTIVES = [
  'neon', 'cosmic', 'electric', 'golden', 'midnight', 'solar', 'crimson',
  'lucky', 'wild', 'silver', 'turbo', 'velvet', 'blazing', 'frosty', 'sonic', 'retro',
];
const NOUNS = [
  'fox', 'tiger', 'falcon', 'panda', 'lion', 'otter', 'raven', 'wolf',
  'gecko', 'puma', 'heron', 'bison', 'mamba', 'ibis', 'koala', 'lynx',
];

/** Slugify a display name into username-legal characters. */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 16);
}

function randomCandidate(name?: string): string {
  const suffix = Math.floor(Math.random() * 900 + 100); // 100-999
  const base = name ? slugifyName(name) : '';
  if (base && base.length >= 3) return `${base}_${suffix}`;
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}_${noun}_${suffix}`;
}

/**
 * Generate a username not currently taken. Uniqueness is ultimately enforced
 * by the unique index on Buyer.username — a race between two first logins
 * surfaces as a duplicate-key error in ensureUsername and is retried there.
 */
export async function generateUniqueUsername(name?: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomCandidate(name);
    if (RESERVED_USERNAMES.includes(candidate)) continue;
    const taken = await Buyer.exists({ username: candidate });
    if (!taken) return candidate;
  }
  throw new Error('Could not generate a unique username, please try again');
}

/**
 * Lazily backfill a username on a buyer that predates the social release.
 * Retries the duplicate-key race so concurrent first requests both succeed.
 */
export async function ensureUsername(buyer: IBuyer): Promise<IBuyer> {
  if (buyer.username) return buyer;
  for (let attempt = 0; attempt < 3; attempt++) {
    buyer.username = await generateUniqueUsername(buyer.name);
    try {
      await buyer.save();
      return buyer;
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // only retry duplicate-key races
    }
  }
  throw new Error('Could not assign a username, please try again');
}
