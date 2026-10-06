// ======================================================================
// CONFIG
// ======================================================================

export const CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID")!;
export const CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET")!;
export const ADMIN_KEY = Deno.env.get("ADMIN_KEY")!;
export const EVENTSUB_SECRET = Deno.env.get("EVENTSUB_SECRET")!;

export const BASE_URL = (Deno.env.get("PUBLIC_BASE_URL") ??
  "https://burn.tavernworks.dev").replace(/\/+$/, "");
export const REDIRECT_URI = Deno.env.get("TWITCH_REDIRECT_URI") ??
  `${BASE_URL}/auth/callback`;
export const EVENTSUB_CALLBACK = `${BASE_URL}/eventsub/callback`;

export const BOT_NAME = "UndercoverBurn";

// Chatters whose messages are never saved for commentary.
export const IGNORED_CHATTERS = new Set([
  "nightbot",
  "streamelements",
  "streamlabs",
  "moobot",
  "fossabot",
  "wizebot",
]);

// --- Poster settings ---
// Minimum new chat messages since the bot's last post before it posts again. 0 disables.
export const MIN_NEW_MESSAGES = 5;
// Chance (0-1) a channel gets a quote/roast on runs where commentary isn't due.
export const POST_PROBABILITY = 0.75;
// How often each channel gets a chat-commentary post.
export const COMMENTARY_INTERVAL_MS = 10 * 60 * 1000;
// Of non-commentary posts, chance it tries a quote before a roast.
export const QUOTE_PROBABILITY = 0.35;
// Need at least this many recent chat messages to react to.
export const COMMENTARY_MIN_MESSAGES = 3;
// Only look at chat from the last 10 minutes.
export const COMMENTARY_WINDOW_MS = 10 * 60 * 1000;
// Quotes and roasts are aimed at someone who chatted within this window.
export const CHATTER_WINDOW_MS = 10 * 60 * 1000;
// If true, skip quotes/roasts when nobody has chatted recently.
export const REQUIRE_RECENT_CHATTER = true;
// Twitch categories where roasts are NOT allowed.
export const BLOCKED_ROAST_GAMES: string[] = [
  "Just Chatting",
];

// --- Ad break settings ---
// Master switch for ad start/end messages.
export const AD_ALERTS_ENABLED = true;
// The ad-end timer re-calls itself at most this often, staying well under
// Val Town's per-request time limit.
export const AD_TIMER_HOP_MS = 40 * 1000;
export const AD_TIMER_MAX_HOPS = 10;
// The poster's fallback leaves an ad alone for this long after it ends,
// giving the timer first shot at posting the welcome-back.
export const AD_END_GRACE_MS = 20 * 1000;
// A welcome-back older than this is dropped instead of posted late.
export const AD_END_STALE_MS = 10 * 60 * 1000;
// How far ahead of a scheduled ad the heads-up is posted.
export const AD_WARNING_LEAD_MS = 56 * 1000;
// How long after an ad ends the welcome-back is posted.
export const AD_END_DELAY_MS = 6 * 1000;
// Poster runs arm the warning timer once the warning is this close; keep it
// a bit longer than the poster's cron interval.
export const AD_WARNING_LOOKAHEAD_MS = 6 * 60 * 1000;
export const AD_WARNING_MAX_HOPS = 15;
