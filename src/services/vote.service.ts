import { Types } from 'mongoose';
import { Event } from '@models/event.model';
import { IEvent } from '@interfaces/event.interface';
import { VoteQuestion, IVoteQuestion, VoteQuestionKind, IVoteOption } from '@models/voteQuestion.model';
import { VoteResponse } from '@models/voteResponse.model';
import { SongSuggestion } from '@models/songSuggestion.model';
import { AttendeeTag } from '@models/attendeeTag.model';
import { Buyer } from '@models/buyer.model';
import { getVoteWindow, VoteWindow } from '@utils/voteWindow.util';
import { assertActorNotSuspended } from '@services/socialAuthor.service';
import { BlockService } from '@services/block.service';
import { HttpError } from '@utils/httpError.util';
import type { SocialActor } from '@utils/socialActor.util';

const ATTENDING_WITH_OPTIONS: IVoteOption[] = [
  { key: 'friends', label: 'Friends' },
  { key: 'partner', label: 'Partner' },
  { key: 'family', label: 'Family' },
  { key: 'solo', label: 'Solo' },
  { key: 'not_sure', label: 'Not sure yet' },
];

const BUSY_OPTIONS: IVoteOption[] = [
  { key: 'packed', label: "It'll be packed" },
  { key: 'busy', label: 'Pretty busy' },
  { key: 'moderate', label: 'Moderate crowd' },
  { key: 'chill', label: 'Nice and chill' },
  { key: 'quiet', label: 'Quiet' },
];

const BUMP_INTO_OPTIONS: IVoteOption[] = [
  { key: 'ex', label: 'My ex' },
  { key: 'crush', label: 'My crush' },
  { key: 'friends_ex', label: "My friend's ex" },
  { key: 'boyfriends_ex', label: "My boyfriend's ex" },
  { key: 'girlfriends_ex', label: "My girlfriend's ex" },
  { key: 'partners_ex', label: "My partner's ex" },
  { key: 'someone_new', label: 'Someone new' },
  { key: 'old_friend', label: 'An old friend' },
  { key: 'havent_seen_in_a_while', label: "Someone I haven't seen in a while" },
  { key: 'no_one_in_particular', label: 'No one in particular' },
  { key: 'prefer_not_to_say', label: 'Prefer not to say' },
];

const CUP_OPTIONS: IVoteOption[] = [
  { key: 'green', label: 'Green Cup — Single' },
  { key: 'yellow', label: "Yellow Cup — It's complicated" },
  { key: 'red', label: 'Red Cup — Taken' },
];

/**
 * Canonical Attendance Status question order (per the client's latest
 * revision: the standalone "Are you planning to attend?" question is
 * removed entirely — see ensureVoteQuestions, which also filters any
 * already-persisted 'attend' rows from earlier events out of every read
 * path so it never displays or contributes results anywhere). "Who are you
 * attending with?" is now first, then "How busy…", then "Who do you hope to
 * bump into?", then "Choose Your Cup" — with the event-conditional
 * artist/song/outfit questions trailing so they never interrupt that fixed
 * chain. Used both to build `defs` below AND to sort already-persisted
 * questions at read time (sortQuestionsCanonically) so an event whose
 * questions were materialized before this ordering shipped still displays
 * correctly without a data migration.
 */
const KIND_DISPLAY_ORDER: VoteQuestionKind[] = ['attending_with', 'busy', 'bump_into', 'cup', 'artist', 'song', 'outfit'];

function sortQuestionsCanonically<T extends { kind: VoteQuestionKind }>(questions: T[]): T[] {
  return [...questions].sort((a, b) => KIND_DISPLAY_ORDER.indexOf(a.kind) - KIND_DISPLAY_ORDER.indexOf(b.kind));
}

const slugify = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'option';

/**
 * What questions THIS event qualifies for, and what their options would be,
 * derived live from the event's current data. Used by:
 *   - the organizer preview (ephemeral — never persisted, so an organizer can
 *     keep tuning the lineup/outfit options before Vote opens)
 *   - ensureVoteQuestions (persisted — snapshotted the first time each
 *     question is materialized)
 * "Only display questions that are relevant to that event" (spec §2): a
 * question is included only when the event actually carries the data it
 * needs — nothing here is ever fabricated.
 */
export function deriveQuestionDefinitions(
  event: Pick<IEvent, 'lineup' | 'outfitThemeOptions' | 'category'>
): Array<{ kind: VoteQuestionKind; prompt: string; options: IVoteOption[] }> {
  const defs: Array<{ kind: VoteQuestionKind; prompt: string; options: IVoteOption[] }> = [];

  // Universal — relevant to every event, and always the fixed chain in this
  // exact order. No standalone "are you attending" question — that was
  // removed per the client's latest revision; see ensureVoteQuestions.
  defs.push({ kind: 'attending_with', prompt: 'Who are you attending with?', options: ATTENDING_WITH_OPTIONS });
  defs.push({ kind: 'busy', prompt: 'How busy do you expect the event to be?', options: BUSY_OPTIONS });
  defs.push({ kind: 'bump_into', prompt: 'Who do you hope to bump into?', options: BUMP_INTO_OPTIONS });
  defs.push({ kind: 'cup', prompt: 'Choose Your Cup', options: CUP_OPTIONS });

  if (event.lineup && event.lineup.length > 0) {
    defs.push({
      kind: 'artist',
      prompt: 'Which artist will perform best?',
      options: event.lineup.map((name) => ({ key: slugify(name), label: name })),
    });
  }

  // DJ/music-relevant events only — a theatre or food festival has no DJ set.
  if (event.category === 'Music' || (event.lineup && event.lineup.length > 0)) {
    defs.push({ kind: 'song', prompt: 'What song must the DJ play?', options: [] });
  }

  if (event.outfitThemeOptions && event.outfitThemeOptions.length > 0) {
    defs.push({
      kind: 'outfit',
      prompt: 'Which outfit theme should attendees wear?',
      options: event.outfitThemeOptions.map((theme) => ({ key: slugify(theme), label: theme })),
    });
  }

  return defs;
}

async function loadEventOr404(eventId: string): Promise<IEvent> {
  const event = await Event.findById(eventId);
  if (!event) throw new HttpError(404, 'Event not found');
  return event;
}

/**
 * Idempotently create this event's VoteQuestion rows from its CURRENT data,
 * skipping any (eventId, kind) pair that already exists — a question's
 * options are frozen the instant it's first materialized (see
 * voteQuestion.model's doc comment) and never re-synced, so calling this
 * repeatedly as the event/lineup changes never mutates an existing question.
 * Safe to call on every read; the unique (eventId, kind) index absorbs a
 * concurrent double-create race.
 *
 * Filters out any legacy 'attend' row before returning: events materialized
 * before the client removed that question may still carry one, and it must
 * never display, or contribute to results, anywhere — removing it here (the
 * single choke point every caller reads through) rather than deleting the
 * row leaves past responses and ticket status untouched, exactly as
 * required.
 */
export async function ensureVoteQuestions(event: IEvent): Promise<IVoteQuestion[]> {
  const existing = await VoteQuestion.find({ eventId: event._id });
  const existingKinds = new Set(existing.map((q) => q.kind));
  const defs = deriveQuestionDefinitions(event);
  const missing = defs.filter((d) => !existingKinds.has(d.kind));
  if (missing.length === 0) return sortQuestionsCanonically(existing.filter((q) => q.kind !== 'attend'));

  for (const def of missing) {
    try {
      const order = KIND_DISPLAY_ORDER.indexOf(def.kind);
      await VoteQuestion.create({ eventId: event._id, kind: def.kind, prompt: def.prompt, order, options: def.options });
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // lost the create race — another request already materialized it
    }
  }
  const all = await VoteQuestion.find({ eventId: event._id });
  return sortQuestionsCanonically(all.filter((q) => q.kind !== 'attend'));
}

export interface VoteSelectorRef {
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
}

export interface VoteQuestionView {
  id: string;
  kind: VoteQuestionKind;
  prompt: string;
  order: number;
  options: Array<{ key: string; label: string }>;
  totalVotes: number;
  viewerHasVoted: boolean;
  viewerSelection: string | null;
  results: {
    totalVotes: number;
    leadingKey: string | null;
    options: Array<{
      key: string;
      label: string;
      count: number;
      percent: number;
      /** A small recent sample of buyers who picked this option — "show
       *  compact profile pictures of the users who selected each option,
       *  before the current user answers" follow-up. Vendor/organizer
       *  responses are never included (no public avatar to show), and any
       *  actor blocked (either direction) by the viewer is excluded — see
       *  excludedSelectorActorIds. Present as soon as the window is open
       *  (no vote-to-reveal gate) — see buildQuestionView. Use `count` for
       *  the "+N" overflow past this sample and getOptionVoters for the
       *  full clickable list. */
      selectors: VoteSelectorRef[];
    }>;
  } | null;
  allowSuggestions?: boolean;
  suggestions?: Array<{ id: string; title: string; artist: string | null; count: number | null }>;
  viewerTags?: Array<{ id: string; status: string; user: { id: string; name: string | null; username: string | null; avatarUrl: string | null } }>;
  incomingTagRequests?: Array<{ id: string; user: { id: string; name: string | null; username: string | null; avatarUrl: string | null } }>;
  /** "Confirmed tagged attendees where applicable" (spec §6) — every CONFIRMED
   *  attending-with pair for this question, publicly visible as soon as the
   *  window is open. Pending/declined tags are never included here — those
   *  stay private to the two parties (see viewerTags/incomingTagRequests
   *  above), matching "only confirmed tags should become publicly visible"
   *  (spec §2). */
  confirmedTags?: Array<{
    id: string;
    tagger: { id: string; name: string | null; username: string | null; avatarUrl: string | null };
    taggedUser: { id: string; name: string | null; username: string | null; avatarUrl: string | null };
  }>;
}

export interface VotePayload {
  eventId: string;
  eventName: string;
  posterUrl: string | null;
  window: { opensAt: string | null; closesAt: string; hasOpened: boolean; hasClosed: boolean };
  questions: VoteQuestionView[];
}

/** Tally a fixed-option question's genuine results via a live aggregate — see
 *  VoteResponse's doc comment on why this is never a maintained counter. */
async function tallyOptions(
  questionId: string,
  options: Array<{ key: string; label: string }>
): Promise<{ totalVotes: number; leadingKey: string | null; options: Array<{ key: string; label: string; count: number; percent: number; selectors: VoteSelectorRef[] }> }> {
  const rows = await VoteResponse.aggregate([{ $match: { questionId: new Types.ObjectId(questionId) } }, { $group: { _id: '$optionKey', count: { $sum: 1 } } }]);
  const countByKey = new Map(rows.map((r: any) => [String(r._id), r.count as number]));
  const totalVotes = rows.reduce((sum: number, r: any) => sum + r.count, 0);
  let leadingKey: string | null = null;
  let leadingCount = -1;
  const out = options.map((o) => {
    const count = countByKey.get(o.key) ?? 0;
    if (count > leadingCount) {
      leadingCount = count;
      leadingKey = o.key;
    }
    // `selectors` is filled in by buildQuestionView (sampleSelectorsByOption)
    // once it knows this tally is actually going to be revealed — never
    // queried here for a question the viewer hasn't unlocked results for.
    return { key: o.key, label: o.label, count, percent: totalVotes > 0 ? Math.round((count / totalVotes) * 1000) / 10 : 0, selectors: [] as VoteSelectorRef[] };
  });
  return { totalVotes, leadingKey: totalVotes > 0 ? leadingKey : null, options: out };
}

async function hydrateBuyerRefs(ids: string[]): Promise<Map<string, any>> {
  if (ids.length === 0) return new Map();
  const buyers = await Buyer.find({ _id: { $in: [...new Set(ids)] } }).select('name username avatarUrl').lean();
  return new Map(buyers.map((b: any) => [String(b._id), b]));
}

function buyerRef(map: Map<string, any>, id: string) {
  const b = map.get(id);
  return { id, name: b?.name ?? null, username: b?.username ?? null, avatarUrl: b?.avatarUrl ?? null };
}

/** Ids to keep out of any buyer-facing list of who-selected-what: blocked in
 *  EITHER direction (mirrors story.service#listForViewer / nearby.service),
 *  so a blocked relationship hides that person's avatar/name from results
 *  regardless of who blocked whom. Anonymous viewers have nothing to hide
 *  from and vendors aren't buyers, so only a buyer actor yields exclusions. */
async function excludedSelectorActorIds(actor: SocialActor | null): Promise<string[]> {
  if (!actor || actor.type !== 'buyer') return [];
  const [iBlocked, blockedMe] = await Promise.all([BlockService.listBlockedIds(actor.id), BlockService.listBlockerIds(actor.id)]);
  return [...new Set([...iBlocked, ...blockedMe])];
}

/** How many avatars to show under each option before collapsing into "+N" —
 *  see VoteSelectorRef's doc comment. */
const SELECTOR_SAMPLE_SIZE = 6;

/** One query for the whole question (not one per option) — most-recent
 *  responder first per option, buyer actors only. Backs the `selectors`
 *  sample attached to `results.options` in buildQuestionView. Excludes any
 *  actor blocked (either direction) by the viewer — the total `count` stays
 *  genuine/unfiltered, only the visible avatar sample respects the block. */
async function sampleSelectorsByOption(
  questionId: string,
  optionKeys: string[],
  excludedActorIds: string[],
  limit = SELECTOR_SAMPLE_SIZE
): Promise<Map<string, VoteSelectorRef[]>> {
  if (optionKeys.length === 0) return new Map();
  const rows = await VoteResponse.find({
    questionId,
    actorType: 'buyer',
    optionKey: { $in: optionKeys },
    ...(excludedActorIds.length > 0 ? { actorId: { $nin: excludedActorIds } } : {}),
  })
    .sort({ updatedAt: -1 })
    .select('actorId optionKey')
    .lean();
  const idsByOption = new Map<string, string[]>();
  for (const r of rows as any[]) {
    const ids = idsByOption.get(r.optionKey) ?? [];
    if (ids.length < limit) ids.push(String(r.actorId));
    idsByOption.set(r.optionKey, ids);
  }
  const buyerMap = await hydrateBuyerRefs([...idsByOption.values()].flat());
  const out = new Map<string, VoteSelectorRef[]>();
  for (const [key, ids] of idsByOption) out.set(key, ids.map((id) => buyerRef(buyerMap, id)));
  return out;
}

/**
 * The full buyer/public-facing Vote payload for one event (event-detail page
 * spec §3, Home feed card spec §4). Materializes questions lazily — before
 * the window opens there is nothing to materialize yet, so `questions` is
 * simply empty and the client shows "opens in Xd".
 */
export async function getVotePayload(eventId: string, actor: SocialActor | null): Promise<VotePayload> {
  const event = await loadEventOr404(eventId);
  const window = getVoteWindow(event);
  const questions = window.opensAt && window.hasOpened ? await ensureVoteQuestions(event) : [];

  const views = await Promise.all(questions.map((q) => buildQuestionView(q, window, actor)));

  return {
    eventId: String(event._id),
    eventName: event.name,
    posterUrl: event.posterUrl ?? null,
    window: {
      opensAt: window.opensAt ? window.opensAt.toISOString() : null,
      closesAt: window.closesAt.toISOString(),
      hasOpened: window.hasOpened,
      hasClosed: window.hasClosed,
    },
    questions: views,
  };
}

async function buildQuestionView(q: IVoteQuestion, window: VoteWindow, actor: SocialActor | null): Promise<VoteQuestionView> {
  const questionId = String(q._id);
  let viewerResponse: any = null;
  if (actor) {
    viewerResponse = await VoteResponse.findOne({ questionId, actorType: actor.type, actorId: actor.id }).lean();
  }
  const viewerHasVoted = !!viewerResponse;
  // Results are visible to everyone once the window is open — "see other
  // users' selections before answering" (no vote-to-reveal gate). A closed
  // window still reveals (there's nothing left to protect by then either).
  const reveal = window.hasOpened;

  let options: Array<{ key: string; label: string }> = q.options.map((o) => ({ key: o.key, label: o.label }));
  let totalVotes = 0;
  let results: VoteQuestionView['results'] = null;
  let suggestions: VoteQuestionView['suggestions'];

  if (q.kind === 'song') {
    const songs = await SongSuggestion.find({ questionId }).sort({ createdAt: -1 }).lean();
    options = songs.map((s: any) => ({ key: String(s._id), label: s.artist ? `${s.title} — ${s.artist}` : s.title }));
    const tally = await tallyOptions(questionId, options);
    totalVotes = tally.totalVotes;
    suggestions = songs.map((s: any) => ({
      id: String(s._id),
      title: s.title,
      artist: s.artist ?? null,
      count: reveal ? tally.options.find((o) => o.key === String(s._id))?.count ?? 0 : null,
    }));
    if (reveal) results = tally;
  } else {
    const tally = await tallyOptions(questionId, options);
    totalVotes = tally.totalVotes;
    if (reveal) results = tally;
  }

  if (results) {
    const excludedActorIds = await excludedSelectorActorIds(actor);
    const selectorMap = await sampleSelectorsByOption(questionId, results.options.map((o) => o.key), excludedActorIds);
    results = { ...results, options: results.options.map((o) => ({ ...o, selectors: selectorMap.get(o.key) ?? [] })) };
  }

  const view: VoteQuestionView = {
    id: questionId,
    kind: q.kind,
    prompt: q.prompt,
    order: q.order,
    options,
    totalVotes,
    viewerHasVoted,
    viewerSelection: viewerResponse ? viewerResponse.optionKey : null,
    results,
    ...(q.kind === 'song' ? { allowSuggestions: true, suggestions } : {}),
  };

  if (q.kind === 'attending_with') {
    if (reveal) {
      const confirmed = await AttendeeTag.find({ questionId, status: 'confirmed' }).lean();
      if (confirmed.length > 0) {
        const buyerMap = await hydrateBuyerRefs(confirmed.flatMap((t: any) => [String(t.taggedById), String(t.taggedUserId)]));
        view.confirmedTags = confirmed.map((t: any) => ({
          id: String(t._id),
          tagger: buyerRef(buyerMap, String(t.taggedById)),
          taggedUser: buyerRef(buyerMap, String(t.taggedUserId)),
        }));
      }
    }
    if (actor && actor.type === 'buyer') {
      const [mine, incoming] = await Promise.all([
        AttendeeTag.find({ questionId, taggedById: actor.id }).lean(),
        AttendeeTag.find({ questionId, taggedUserId: actor.id, status: 'pending' }).lean(),
      ]);
      const ids = [...mine.map((t: any) => String(t.taggedUserId)), ...incoming.map((t: any) => String(t.taggedById))];
      const buyerMap = await hydrateBuyerRefs(ids);
      view.viewerTags = mine.map((t: any) => ({ id: String(t._id), status: t.status, user: buyerRef(buyerMap, String(t.taggedUserId)) }));
      view.incomingTagRequests = incoming.map((t: any) => ({ id: String(t._id), user: buyerRef(buyerMap, String(t.taggedById)) }));
    }
  }

  return view;
}

/** Cast/change a vote (spec §5) — an upsert makes duplicate taps/refreshes a
 *  no-op re-set rather than a duplicate row, and "change vote until closes"
 *  falls out of the same upsert. */
export async function castVote(eventId: string, questionId: string, actor: SocialActor, optionKey: string): Promise<VoteQuestionView> {
  if (actor.type === 'buyer') await assertActorNotSuspended(actor);
  const event = await loadEventOr404(eventId);
  const window = getVoteWindow(event);
  if (!window.hasOpened) throw new HttpError(409, 'Attendance Status is not open yet');
  if (window.hasClosed) throw new HttpError(409, 'Attendance Status has closed');

  const question = await VoteQuestion.findOne({ _id: questionId, eventId });
  if (!question || question.kind === 'attend') throw new HttpError(404, 'Attendance Status question not found');

  const trimmedKey = String(optionKey || '').trim();
  if (!trimmedKey) throw new HttpError(400, 'optionKey is required');

  if (question.kind === 'song') {
    if (!(await SongSuggestion.exists({ _id: trimmedKey, questionId }))) {
      throw new HttpError(400, 'That song is not a valid option for this question');
    }
  } else if (!question.options.some((o) => o.key === trimmedKey)) {
    throw new HttpError(400, 'That option is not valid for this question');
  }

  await VoteResponse.findOneAndUpdate(
    { questionId, actorType: actor.type, actorId: actor.id },
    { $set: { optionKey: trimmedKey, eventId: event._id } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return buildQuestionView(question, window, actor);
}

export interface VoteVotersPage {
  voters: VoteSelectorRef[];
  nextCursor: string | null;
}

const VOTERS_PAGE_SIZE = 30;

/**
 * "Clicking the count should open the complete list of those users" follow-up
 * — the full, paginated (cursor = last row's _id) list of buyers who picked
 * one option on one question. Visible as soon as the window is open (no
 * vote-to-reveal gate — matches buildQuestionView) and excludes any actor
 * blocked (either direction) by the viewer, same as sampleSelectorsByOption.
 */
export async function getOptionVoters(
  eventId: string,
  questionId: string,
  optionKey: string,
  actor: SocialActor | null,
  cursor?: string,
  limit = VOTERS_PAGE_SIZE
): Promise<VoteVotersPage> {
  const event = await loadEventOr404(eventId);
  const window = getVoteWindow(event);
  const question = await VoteQuestion.findOne({ _id: questionId, eventId });
  if (!question || question.kind === 'attend') throw new HttpError(404, 'Attendance Status question not found');

  if (!window.hasOpened) {
    throw new HttpError(409, 'Attendance Status is not open yet');
  }

  const excludedActorIds = await excludedSelectorActorIds(actor);
  const boundedLimit = Math.min(50, Math.max(1, limit));
  const query: Record<string, unknown> = { questionId, optionKey, actorType: 'buyer' };
  if (excludedActorIds.length > 0) query['actorId'] = { $nin: excludedActorIds };
  if (cursor) query['_id'] = { $lt: new Types.ObjectId(cursor) };
  const rows = await VoteResponse.find(query).sort({ _id: -1 }).limit(boundedLimit + 1).select('actorId').lean();
  const hasMore = rows.length > boundedLimit;
  const page = hasMore ? rows.slice(0, boundedLimit) : rows;
  const buyerMap = await hydrateBuyerRefs(page.map((r: any) => String(r.actorId)));

  return {
    voters: page.map((r: any) => buyerRef(buyerMap, String(r.actorId))),
    nextCursor: hasMore ? String(page[page.length - 1]!._id) : null,
  };
}

/**
 * Home feed card (spec §4, plus the follow-up: "apply the same [auto-
 * progression] functionality... to the Attendance Status card on both the
 * Home feed and the Event Detail page"). Returns EVERY materialized
 * question, not just one — the feed card drives the same in-place
 * auto-advance-through-all-questions flow as the event-detail page (see
 * landing's useVoteProgression), so it needs the whole set to advance
 * through, just like getVotePayload. Returns null for an event whose window
 * isn't currently open — callers pre-filter for this, but it's cheap
 * insurance against a stale candidate list surfacing a closed Vote.
 */
export async function getVoteFeedCard(event: IEvent, actor: SocialActor | null) {
  const window = getVoteWindow(event);
  if (!window.hasOpened || window.hasClosed) return null;
  const questions = await ensureVoteQuestions(event);
  if (questions.length === 0) return null;

  const views = await Promise.all(questions.map((q) => buildQuestionView(q, window, actor)));
  return {
    eventId: String(event._id),
    eventName: event.name,
    posterUrl: event.posterUrl ?? null,
    eventDate: event.eventDate,
    closesAt: window.closesAt.toISOString(),
    questions: views,
  };
}

async function loadOwnedEventOr403(eventId: string, vendorId: string, isSuperAdmin: boolean): Promise<IEvent> {
  const event = await loadEventOr404(eventId);
  if (!isSuperAdmin && String(event.vendorId) !== String(vendorId)) {
    throw new HttpError(403, 'You can only manage Attendance Status for your own events');
  }
  return event;
}

/**
 * Organizer dashboard §9: "Preview the Vote before activation." Purely
 * derived from the event's CURRENT data — never persisted, so tuning the
 * lineup/outfit options keeps re-previewing accurately right up until the
 * window actually opens and ensureVoteQuestions freezes the real thing.
 */
export async function previewVote(eventId: string, vendorId: string, isSuperAdmin: boolean) {
  const event = await loadOwnedEventOr403(eventId, vendorId, isSuperAdmin);
  const window = getVoteWindow(event);
  const defs = deriveQuestionDefinitions(event);
  return {
    eventId: String(event._id),
    window: {
      opensAt: window.opensAt ? window.opensAt.toISOString() : null,
      closesAt: window.closesAt.toISOString(),
      hasOpened: window.hasOpened,
      hasClosed: window.hasClosed,
    },
    questions: defs.map((d, i) => ({ kind: d.kind, prompt: d.prompt, order: i, options: d.options })),
  };
}

/**
 * Organizer dashboard §9: genuine participation stats + results for every
 * question + song suggestions. Always shows full results (an organizer isn't
 * subject to the buyer's "vote to reveal" gate) but — per spec — this is
 * READ-ONLY: nothing here lets an organizer edit totals, selections,
 * questions or options once voting has started (there is simply no write
 * path from this function).
 */
export async function getOrganizerSummary(eventId: string, vendorId: string, isSuperAdmin: boolean) {
  const event = await loadOwnedEventOr403(eventId, vendorId, isSuperAdmin);
  const window = getVoteWindow(event);
  const questions = window.opensAt ? await ensureVoteQuestions(event) : [];

  const questionSummaries = await Promise.all(
    questions.map(async (q) => {
      const questionId = String(q._id);
      if (q.kind === 'song') {
        const songs = await SongSuggestion.find({ questionId }).sort({ createdAt: -1 }).lean();
        const options = songs.map((s: any) => ({ key: String(s._id), label: s.artist ? `${s.title} — ${s.artist}` : s.title }));
        const tally = await tallyOptions(questionId, options);
        return {
          id: questionId,
          kind: q.kind,
          prompt: q.prompt,
          totalVotes: tally.totalVotes,
          leadingKey: tally.leadingKey,
          options: tally.options,
          songSuggestions: songs.map((s: any) => ({
            id: String(s._id),
            title: s.title,
            artist: s.artist ?? null,
            count: tally.options.find((o) => o.key === String(s._id))?.count ?? 0,
            suggestedAt: s.createdAt,
          })),
        };
      }
      const tally = await tallyOptions(questionId, q.options);
      return { id: questionId, kind: q.kind, prompt: q.prompt, totalVotes: tally.totalVotes, leadingKey: tally.leadingKey, options: tally.options };
    })
  );

  return {
    eventId: String(event._id),
    eventName: event.name,
    window: {
      opensAt: window.opensAt ? window.opensAt.toISOString() : null,
      closesAt: window.closesAt.toISOString(),
      hasOpened: window.hasOpened,
      hasClosed: window.hasClosed,
    },
    questions: questionSummaries,
  };
}

/** "Allow users to suggest songs... prevent duplicate song suggestions where
 *  possible" (spec §2) — a near-identical title/artist resolves to the
 *  existing suggestion (and votes the suggester onto it) instead of forking
 *  the tally. */
export async function suggestSong(eventId: string, questionId: string, actor: SocialActor, title: string, artist?: string): Promise<VoteQuestionView> {
  if (actor.type === 'buyer') await assertActorNotSuspended(actor);
  const event = await loadEventOr404(eventId);
  const window = getVoteWindow(event);
  if (!window.hasOpened) throw new HttpError(409, 'Attendance Status is not open yet');
  if (window.hasClosed) throw new HttpError(409, 'Attendance Status has closed');

  const question = await VoteQuestion.findOne({ _id: questionId, eventId, kind: 'song' });
  if (!question) throw new HttpError(404, 'Song question not found for this event');

  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) throw new HttpError(400, 'A song title is required');
  if (trimmedTitle.length > 150) throw new HttpError(400, 'Song title is too long');
  const trimmedArtist = artist ? String(artist).trim().slice(0, 150) : undefined;
  const normalizedKey = `${trimmedTitle}|${trimmedArtist ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim();

  let suggestion = await SongSuggestion.findOne({ questionId, normalizedKey });
  if (!suggestion) {
    try {
      suggestion = await SongSuggestion.create({
        eventId: event._id,
        questionId,
        suggestedByType: actor.type,
        suggestedById: actor.id,
        title: trimmedTitle,
        artist: trimmedArtist,
        normalizedKey,
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      suggestion = await SongSuggestion.findOne({ questionId, normalizedKey });
      if (!suggestion) throw err;
    }
  }

  await VoteResponse.findOneAndUpdate(
    { questionId, actorType: actor.type, actorId: actor.id },
    { $set: { optionKey: String(suggestion._id), eventId: event._id } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  return buildQuestionView(question, window, actor);
}
