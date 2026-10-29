import type { RideList } from '../domain/rideList';

// ============================================================================
// Where a traveller posts a ride to fill it (owner, 2026-10-28), in the order that works:
// Facebook groups first, WhatsApp groups second, a story and Reddit as extras. These go
// into a CUSTOMER email, so every link here is public forever — a group is listed only
// because the owner chose it. Changing one is a PR, deliberately: no config, no ops page.
// ============================================================================

export interface ShareGroup {
  name: string;
  url: string;
  /** One line under the name: who is in it, why it works. */
  blurb: string;
}

export const FACEBOOK_GROUPS: readonly ShareGroup[] = [
  {
    name: 'Sri Lanka Travel Tours',
    url: 'https://www.facebook.com/groups/srilanka.travel.tours',
    blurb: 'Travellers planning the same routes, every day.',
  },
  {
    name: 'Sri Lanka Travel & Tourism Original Group',
    url: 'https://www.facebook.com/groups/768589830171708',
    blurb: 'The big one.',
  },
  {
    name: 'Sri Lanka Backpackers',
    url: 'https://www.facebook.com/groups/127581811296848',
    blurb: 'Hostel crowd, lots of "anyone heading to…" posts.',
  },
];

// A WhatsApp invite link: the canonical form only. The tracking tail WhatsApp's share
// sheet appends (?s=…&p=…) is noise in a customer email.
export const WHATSAPP_GROUPS: readonly ShareGroup[] = [
  {
    name: 'DN Sri Lanka Main group',
    url: 'https://chat.whatsapp.com/Bg5gS9z3iGI4luXDvFHKys',
    blurb: 'Backpackers and people living here. Post the same message.',
  },
];

export interface Subreddit {
  name: string;
  blurb: string;
}

// r/srilanka's automod steers travel posts into its monthly travel thread, so the blurb
// says to ask there; r/backpacking takes Sri Lanka trip posts directly.
export const SUBREDDITS: readonly Subreddit[] = [
  { name: 'srilanka', blurb: 'Ask in the monthly travel thread.' },
  { name: 'backpacking', blurb: 'Sri Lanka trip posts land here every week.' },
];

export const INSTAGRAM_HANDLE = 'ceylonhop';

export type ShareSource = 'whatsapp' | 'facebook' | 'reddit' | 'instagram';

const CAMPAIGN = 'ride_fill_tip';

/** The ride's public link, tagged per channel so GA4 on the board can say which post sent the joiner. */
export function taggedRideLink(shareBaseUrl: string, code: string, source: ShareSource): string {
  return `${shareBaseUrl.replace(/\/+$/, '')}/r/${encodeURIComponent(code)}?utm_source=${source}&utm_medium=social&utm_campaign=${CAMPAIGN}`;
}

/** The ride's public link with no tags: what a traveller sees and pastes. */
export function cleanRideLink(shareBaseUrl: string, code: string): string {
  return `${shareBaseUrl.replace(/\/+$/, '')}/r/${encodeURIComponent(code)}`;
}

/** The 9:16 story image the share route already renders. */
export function storyImageLink(shareBaseUrl: string, code: string): string {
  return `${shareBaseUrl.replace(/\/+$/, '')}/r/${encodeURIComponent(code)}/story.png`;
}

/** Back to the ride on the board, tagged as the email's own click. */
export function boardRideLink(boardBaseUrl: string, code: string): string {
  return `${boardBaseUrl.replace(/\/+$/, '')}/board.html?utm_source=email&utm_medium=email&utm_campaign=${CAMPAIGN}#/${encodeURIComponent(code)}`;
}

// "Fri 14 Aug" — the day as it reads in a chat message.
function chatDay(iso: string): string {
  const dt = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(dt);
}

/**
 * The post, written for them. Same bones as the board's own share button
 * (ride-fomo.js shareMessage): the starter says "I've started", a joiner "join me".
 * Counts and places only, never another traveller's name — this goes on a public wall.
 */
export function sharePost(list: RideList, need: number, isStarter: boolean, link: string): string {
  const seat = Math.round(list.seatPrice / 100);
  const opener = isStarter
    ? `I've started a shared taxi ${list.fromPlace} → ${list.toPlace} on ${chatDay(list.date)}.`
    : `I'm on a shared taxi ${list.fromPlace} → ${list.toPlace} on ${chatDay(list.date)}.`;
  const ask = need > 0
    ? `${need} more ${need === 1 ? 'person' : 'people'} and it runs, about $${seat} a seat. Nothing to pay unless it runs.`
    : `It's running with seats left, about $${seat} a seat.`;
  // Both are on the ride, so both say "join me"; only the opener differs.
  return `${opener} ${ask} Join me: ${link}`;
}

export function whatsappShareLink(post: string): string {
  return `https://wa.me/?text=${encodeURIComponent(post)}`;
}

/** Reddit's submit page takes a title and body; written as a question, which is what the subs allow. */
export function redditSubmitLink(sub: string, list: RideList, post: string): string {
  const title = `Anyone travelling ${list.fromPlace} → ${list.toPlace} on ${chatDay(list.date)}? Sharing a taxi`;
  return `https://www.reddit.com/r/${sub}/submit?selftext=true&title=${encodeURIComponent(title)}&text=${encodeURIComponent(post)}`;
}
