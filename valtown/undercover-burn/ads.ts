import { sqlite } from "https://esm.town/v/std/sqlite/global.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  ADMIN_KEY,
  AD_ALERTS_ENABLED,
  AD_END_GRACE_MS,
  AD_END_STALE_MS,
  AD_WARNING_LEAD_MS,
  AD_END_DELAY_MS,
  AD_WARNING_LOOKAHEAD_MS,
} from "./config.ts";
import {
  AD_START_MESSAGES,
  AD_WARNING_MESSAGES,
  AD_END_MESSAGES,
  pick,
  formatAdLength,
} from "./messages.ts";
import {
  getKv,
  getAppAccessToken,
  sendChatMessage,
} from "./twitch.ts";

// ======================================================================
// AD BREAK ALERTS
// ======================================================================

// Ad messages follow the global and per-channel on/off switches but not the
// live flag: an ad break is proof the channel is live.
export async function adAlertsAllowed(broadcasterId: string): Promise<boolean> {
  if (!AD_ALERTS_ENABLED) return false;
  if ((await getKv("bot_enabled")) === "0") return false;
  const { rows } = await sqlite.execute({
    sql: "SELECT enabled FROM channels WHERE broadcaster_id = :id",
    args: { id: broadcasterId },
  });
  if (!rows.length) return false;
  return rows[0][0] === null || rows[0][0] === undefined ||
    Number(rows[0][0]) === 1;
}

export async function postAdMessage(broadcasterId: string, message: string) {
  const botUserId = await getKv("bot_user_id");
  if (!botUserId) return;
  const accessToken = await getAppAccessToken();
  await sendChatMessage(accessToken, botUserId, broadcasterId, message);
}

// Starts a timer by calling one of this val's /ads/* endpoints. That request
// sleeps, so don't wait for it; just give it a moment to go out.
export async function startSelfTimer(
  selfOrigin: string,
  path: string,
  params: Record<string, string>,
) {
  const u = new URL(path, selfOrigin);
  u.searchParams.set("key", ADMIN_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  fetch(u).then((r) => r.body?.cancel()).catch((err) =>
    console.error(`Timer request ${path} failed:`, err)
  );
  await new Promise((r) => setTimeout(r, 1000));
}

// Starts the ad-end timer (/ads/finish), which sleeps through the ad.
export async function scheduleAdEnd(
  selfOrigin: string,
  broadcasterId: string,
  eventId: string,
  hop = 0,
) {
  await startSelfTimer(selfOrigin, "/ads/finish", {
    id: broadcasterId,
    event: eventId,
    hop: String(hop),
  });
}

export async function saveBroadcasterToken(
  broadcasterId: string,
  token: { access_token: string; refresh_token: string; expires_in: number },
) {
  await sqlite.execute({
    sql: `UPDATE channels SET user_access_token = :a, user_refresh_token = :r,
            user_token_expires_at = :e
          WHERE broadcaster_id = :id`,
    args: {
      a: token.access_token,
      r: token.refresh_token,
      e: Date.now() + Number(token.expires_in) * 1000,
      id: broadcasterId,
    },
  });
}

// The streamer's own token (needed to read their ad schedule), refreshed as
// needed. Null when they haven't re-invited since early warnings existed,
// or revoked the bot.
export async function getBroadcasterToken(
  broadcasterId: string,
): Promise<string | null> {
  const { rows } = await sqlite.execute({
    sql: `SELECT user_access_token, user_refresh_token, user_token_expires_at
          FROM channels WHERE broadcaster_id = :id`,
    args: { id: broadcasterId },
  });
  if (!rows.length || !rows[0][1]) return null;
  if (Number(rows[0][2]) > Date.now() + 60_000) return rows[0][0] as string;

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: rows[0][1] as string,
    }),
  });
  if (!res.ok) {
    console.error(
      `Token refresh failed for ${broadcasterId}:`,
      res.status,
      await res.text(),
    );
    // 400/401 means the streamer revoked access; forget the dead token.
    if (res.status === 400 || res.status === 401) {
      await sqlite.execute({
        sql: `UPDATE channels SET user_access_token = NULL,
                user_refresh_token = NULL, user_token_expires_at = NULL
              WHERE broadcaster_id = :id`,
        args: { id: broadcasterId },
      });
    }
    return null;
  }
  const data = await res.json();
  await saveBroadcasterToken(broadcasterId, data);
  return data.access_token;
}

// Twitch has returned next_ad_at both as RFC3339 and as epoch seconds.
export function parseTwitchTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === 0) return null;
  const n = Number(v);
  if (!isNaN(n)) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(String(v));
  return isNaN(t) ? null : t;
}

// The channel's next scheduled ad, or null if none is scheduled.
export async function getAdSchedule(
  broadcasterId: string,
): Promise<{ nextAdAt: number; duration: number } | null> {
  const token = await getBroadcasterToken(broadcasterId);
  if (!token) return null;
  const res = await fetch(
    `https://api.twitch.tv/helix/channels/ads?broadcaster_id=${broadcasterId}`,
    {
      headers: { "Client-Id": CLIENT_ID, "Authorization": `Bearer ${token}` },
    },
  );
  if (!res.ok) {
    console.error(
      `Ad schedule lookup failed for ${broadcasterId}:`,
      res.status,
      await res.text(),
    );
    return null;
  }
  const d = (await res.json())?.data?.[0];
  const nextAdAt = parseTwitchTime(d?.next_ad_at);
  if (!nextAdAt) return null;
  return { nextAdAt, duration: Math.max(0, Number(d?.duration) || 0) };
}

// Arms the early-warning timer when this channel's next ad is close enough.
// Only one timer runs per scheduled ad.
export async function scheduleAdWarning(broadcasterId: string, selfOrigin: string) {
  const sched = await getAdSchedule(broadcasterId);
  if (!sched) return;
  const untilAd = sched.nextAdAt - Date.now();
  // Too far out: a later poster run will check again. Too close: the
  // start-of-ad notice covers it.
  if (untilAd - AD_WARNING_LEAD_MS > AD_WARNING_LOOKAHEAD_MS) return;
  if (untilAd < 15_000) return;

  // A schedule that moved by only a few seconds is the same ad.
  const { rowsAffected } = await sqlite.execute({
    sql: `INSERT INTO ad_warnings (broadcaster_id, next_ad_at)
          VALUES (:id, :at)
          ON CONFLICT(broadcaster_id) DO UPDATE SET next_ad_at = excluded.next_ad_at
          WHERE ad_warnings.next_ad_at IS NULL
             OR abs(ad_warnings.next_ad_at - excluded.next_ad_at) > 5000`,
    args: { id: broadcasterId, at: sched.nextAdAt },
  });
  if (!rowsAffected) return;
  console.log(
    `Ad warning armed for ${broadcasterId}: ad in ${Math.round(untilAd / 1000)}s`,
  );
  await startSelfTimer(selfOrigin, "/ads/warn", {
    id: broadcasterId,
    at: String(sched.nextAdAt),
    hop: "0",
  });
}

// Runs when a warning timer wakes up: re-checks the schedule and posts the
// heads-up if the ad is still coming when expected.
export async function postAdWarning(
  broadcasterId: string,
  expectedAt: number,
  selfOrigin: string,
) {
  const sched = await getAdSchedule(broadcasterId);
  if (!sched || Math.abs(sched.nextAdAt - expectedAt) > 5000) {
    // Snoozed, moved, or cancelled: drop this timer and re-arm for the new time.
    await sqlite.execute({
      sql: `UPDATE ad_warnings SET next_ad_at = NULL
            WHERE broadcaster_id = :id AND next_ad_at = :at`,
      args: { id: broadcasterId, at: expectedAt },
    });
    if (sched) await scheduleAdWarning(broadcasterId, selfOrigin);
    return;
  }
  const untilAd = sched.nextAdAt - Date.now();
  if (untilAd < 10_000) return; // too late, the start-of-ad notice will cover it

  const { rowsAffected } = await sqlite.execute({
    sql: `UPDATE ad_warnings SET warned_for = :at, warned_at = :now
          WHERE broadcaster_id = :id AND next_ad_at = :at
            AND (warned_for IS NULL OR warned_for != :at)`,
    args: { id: broadcasterId, at: expectedAt, now: Date.now() },
  });
  if (!rowsAffected || !(await adAlertsAllowed(broadcasterId))) return;

  const secs = Math.max(10, Math.round(untilAd / 5000) * 5);
  await postAdMessage(
    broadcasterId,
    pick(AD_WARNING_MESSAGES)
      .replaceAll("{secs}", String(secs))
      .replaceAll("{length}", formatAdLength(sched.duration)),
  );
}

// Poster pass: arm warning timers for every live channel that shared its token.
export async function armAdWarnings(selfOrigin: string) {
  if (!AD_ALERTS_ENABLED) return;
  const { rows } = await sqlite.execute(
    `SELECT broadcaster_id FROM channels
     WHERE is_live = 1 AND COALESCE(enabled, 1) = 1
       AND user_refresh_token IS NOT NULL`,
  );
  for (const row of rows) {
    await scheduleAdWarning(row[0] as string, selfOrigin).catch((err) =>
      console.error(`scheduleAdWarning error for ${row[0]}:`, err)
    );
  }
}

// Handles one channel.ad_break.begin event: records the break, announces it,
// and starts the timer for the welcome-back message.
export async function handleAdBreakBegin(
  event: {
    broadcaster_user_id: string;
    broadcaster_user_login?: string;
    duration_seconds?: number;
    started_at?: string;
    is_automatic?: boolean;
  },
  eventId: string,
  selfOrigin: string,
) {
  const broadcasterId = event.broadcaster_user_id;
  const durationSec = Math.max(0, Math.round(Number(event.duration_seconds) || 0));
  const startedAt = Date.parse(event.started_at ?? "") || Date.now();
  // "Ends" here means when the welcome-back is due.
  const endsAt = startedAt + durationSec * 1000 + AD_END_DELAY_MS;

  // Twitch re-delivers events it thinks failed; only act on the first copy.
  const { rowsAffected } = await sqlite.execute({
    sql: `INSERT INTO ad_breaks (broadcaster_id, event_id, ends_at, end_posted)
          VALUES (:id, :eid, :ends, 0)
          ON CONFLICT(broadcaster_id) DO UPDATE SET
            event_id = excluded.event_id,
            ends_at = excluded.ends_at,
            end_posted = 0
          WHERE ad_breaks.event_id IS NOT excluded.event_id`,
    args: { id: broadcasterId, eid: eventId, ends: endsAt },
  });
  if (!rowsAffected) return;

  console.log(
    `Ad break in ${event.broadcaster_user_login ?? broadcasterId}: ${durationSec}s` +
      (event.is_automatic ? " (automatic)" : ""),
  );
  if (!(await adAlertsAllowed(broadcasterId))) return;

  // Skip the start notice when chat already got the heads-up for this ad.
  const { rows } = await sqlite.execute({
    sql: `SELECT warned_at FROM ad_warnings WHERE broadcaster_id = :id`,
    args: { id: broadcasterId },
  });
  const warnedAt = rows.length ? Number(rows[0][0]) || 0 : 0;
  if (Date.now() - warnedAt > AD_WARNING_LEAD_MS + 2 * 60 * 1000) {
    await postAdMessage(
      broadcasterId,
      pick(AD_START_MESSAGES).replaceAll(
        "{length}",
        formatAdLength(durationSec),
      ),
    );
  }
  await scheduleAdEnd(selfOrigin, broadcasterId, eventId);
}

// Posts the welcome-back for one ad break, at most once no matter how many
// timers or poster runs reach it. With post=false it's just marked done.
export async function finishAdBreak(
  broadcasterId: string,
  eventId: string,
  post = true,
) {
  const { rowsAffected } = await sqlite.execute({
    sql: `UPDATE ad_breaks SET end_posted = 1
          WHERE broadcaster_id = :id AND event_id = :eid AND end_posted = 0`,
    args: { id: broadcasterId, eid: eventId },
  });
  if (!rowsAffected || !post) return;
  if (!(await adAlertsAllowed(broadcasterId))) return;
  await postAdMessage(broadcasterId, pick(AD_END_MESSAGES));
}

// Poster fallback: welcome chat back after any ad whose timer didn't finish.
export async function postOverdueAdEnds() {
  const now = Date.now();
  const { rows } = await sqlite.execute({
    sql: `SELECT broadcaster_id, event_id, ends_at FROM ad_breaks
          WHERE end_posted = 0 AND ends_at < :cutoff`,
    args: { cutoff: now - AD_END_GRACE_MS },
  });
  for (const row of rows) {
    const stale = now - Number(row[2]) > AD_END_STALE_MS;
    await finishAdBreak(row[0] as string, row[1] as string, !stale);
  }
}
