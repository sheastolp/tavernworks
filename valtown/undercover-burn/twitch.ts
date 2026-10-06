import { sqlite } from "https://esm.town/v/std/sqlite/global.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  EVENTSUB_SECRET,
  EVENTSUB_CALLBACK,
  IGNORED_CHATTERS,
  CHATTER_WINDOW_MS,
} from "./config.ts";

// ======================================================================
// DATABASE HELPERS
// ======================================================================

export async function ensureTables() {
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS channels (
      broadcaster_id TEXT PRIMARY KEY,
      broadcaster_login TEXT,
      se_channel_id TEXT,
      se_jwt_token TEXT,
      enabled INTEGER DEFAULT 1,
      message_count INTEGER DEFAULT 0,
      is_live INTEGER DEFAULT 0,
      added_at INTEGER
    )
  `);
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS recent_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcaster_id TEXT,
      chatter TEXT,
      text TEXT,
      ts INTEGER
    )
  `);
  // One row per channel: its most recent ad break.
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ad_breaks (
      broadcaster_id TEXT PRIMARY KEY,
      event_id TEXT,
      ends_at INTEGER,
      end_posted INTEGER DEFAULT 0
    )
  `);
  // One row per channel: the scheduled ad its warning timer is waiting for.
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ad_warnings (
      broadcaster_id TEXT PRIMARY KEY,
      next_ad_at INTEGER,
      warned_for INTEGER,
      warned_at INTEGER
    )
  `);
  // Migrations for tables created before these columns existed.
  for (
    const stmt of [
      `ALTER TABLE channels ADD COLUMN se_jwt_token TEXT`,
      `ALTER TABLE channels ADD COLUMN enabled INTEGER DEFAULT 1`,
      `ALTER TABLE channels ADD COLUMN message_count INTEGER DEFAULT 0`,
      `ALTER TABLE channels ADD COLUMN is_live INTEGER DEFAULT 0`,
      `ALTER TABLE channels ADD COLUMN ads_subscribed INTEGER DEFAULT 0`,
      `ALTER TABLE channels ADD COLUMN user_access_token TEXT`,
      `ALTER TABLE channels ADD COLUMN user_refresh_token TEXT`,
      `ALTER TABLE channels ADD COLUMN user_token_expires_at INTEGER`,
    ]
  ) {
    try {
      await sqlite.execute(stmt);
    } catch {
      // Column already exists — fine.
    }
  }
}

export async function getKv(key: string): Promise<string | null> {
  const result = await sqlite.execute({
    sql: "SELECT value FROM kv WHERE key = :k",
    args: { k: key },
  });
  return result.rows.length ? (result.rows[0][0] as string) : null;
}

export async function setKv(key: string, value: string) {
  await sqlite.execute({
    sql: `INSERT INTO kv (key, value) VALUES (:k, :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: { k: key, v: value },
  });
}

// Flips the live flag. When a stream ends, also wipes that channel's
// saved chat so old messages never get commented on next stream, and
// drops any ad break in progress so no welcome-back posts after the end.
export async function setLiveStatus(broadcasterId: string, live: boolean) {
  await sqlite.execute({
    sql: `UPDATE channels SET is_live = :live WHERE broadcaster_id = :id`,
    args: { live: live ? 1 : 0, id: broadcasterId },
  });
  if (!live) {
    await sqlite.execute({
      sql: `DELETE FROM recent_chat WHERE broadcaster_id = :id`,
      args: { id: broadcasterId },
    });
    await sqlite.execute({
      sql: `DELETE FROM ad_breaks WHERE broadcaster_id = :id`,
      args: { id: broadcasterId },
    });
    await sqlite.execute({
      sql: `DELETE FROM ad_warnings WHERE broadcaster_id = :id`,
      args: { id: broadcasterId },
    });
  }
}

// Resets a channel's new-message counter after the bot posts there.
export async function resetMessageCount(broadcasterId: string) {
  await sqlite.execute({
    sql: `UPDATE channels SET message_count = 0 WHERE broadcaster_id = :id`,
    args: { id: broadcasterId },
  });
}

// Picks a random chatter who spoke recently in this channel.
export async function getRecentChatter(
  broadcasterId: string,
): Promise<string | null> {
  const { rows } = await sqlite.execute({
    sql: `SELECT chatter FROM recent_chat
          WHERE broadcaster_id = :id AND ts > :cutoff
          ORDER BY RANDOM() LIMIT 1`,
    args: { id: broadcasterId, cutoff: Date.now() - CHATTER_WINDOW_MS },
  });
  return rows.length ? (rows[0][0] as string) : null;
}

// ======================================================================
// TWITCH HELPERS
// ======================================================================

export async function getAppAccessToken(): Promise<string> {
  const cachedRaw = await getKv("app_token");
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw);
    if (cached.expires_at > Date.now() + 60_000) return cached.access_token;
  }
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `App access token fetch failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = await res.json();
  const token = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await setKv("app_token", JSON.stringify(token));
  return token.access_token;
}

// Subscribes the bot to this channel's chat messages via EventSub webhook.
// A 409 means already subscribed, which we ignore.
export async function subscribeChatEvents(broadcasterId: string) {
  const botUserId = await getKv("bot_user_id");
  if (!botUserId) {
    console.log("Skipping EventSub subscribe — bot not authorized yet.");
    return;
  }
  const accessToken = await getAppAccessToken();
  const res = await fetch(
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    {
      method: "POST",
      headers: {
        "Client-Id": CLIENT_ID,
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId, user_id: botUserId },
        transport: {
          method: "webhook",
          callback: EVENTSUB_CALLBACK,
          secret: EVENTSUB_SECRET,
        },
      }),
    },
  );
  if (!res.ok && res.status !== 409) {
    console.error(
      `EventSub subscribe failed for ${broadcasterId}:`,
      res.status,
      await res.text(),
    );
  }
}

// Subscribes to stream.online / stream.offline. A 409 means already subscribed.
export async function subscribeStreamEvents(broadcasterId: string) {
  const accessToken = await getAppAccessToken();
  for (const type of ["stream.online", "stream.offline"] as const) {
    const res = await fetch(
      "https://api.twitch.tv/helix/eventsub/subscriptions",
      {
        method: "POST",
        headers: {
          "Client-Id": CLIENT_ID,
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type,
          version: "1",
          condition: { broadcaster_user_id: broadcasterId },
          transport: {
            method: "webhook",
            callback: EVENTSUB_CALLBACK,
            secret: EVENTSUB_SECRET,
          },
        }),
      },
    );
    if (!res.ok && res.status !== 409) {
      console.error(
        `EventSub subscribe (${type}) failed for ${broadcasterId}:`,
        res.status,
        await res.text(),
      );
    }
  }
}

// Subscribes to channel.ad_break.begin. Twitch answers 403 when the
// broadcaster hasn't granted channel:read:ads (channels invited before ad
// alerts existed), so the result is saved for the admin page.
// Returns whether the subscription exists.
export async function subscribeAdEvents(broadcasterId: string): Promise<boolean> {
  const accessToken = await getAppAccessToken();
  const res = await fetch(
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    {
      method: "POST",
      headers: {
        "Client-Id": CLIENT_ID,
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "channel.ad_break.begin",
        version: "1",
        condition: { broadcaster_user_id: broadcasterId },
        transport: {
          method: "webhook",
          callback: EVENTSUB_CALLBACK,
          secret: EVENTSUB_SECRET,
        },
      }),
    },
  );
  const ok = res.ok || res.status === 409;
  if (!ok) {
    console.error(
      `EventSub subscribe (channel.ad_break.begin) failed for ${broadcasterId}:`,
      res.status,
      await res.text(),
    );
  }
  await sqlite.execute({
    sql: `UPDATE channels SET ads_subscribed = :s WHERE broadcaster_id = :id`,
    args: { s: ok ? 1 : 0, id: broadcasterId },
  });
  return ok;
}

export async function verifyEventSubSignature(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  const messageId = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = req.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = req.headers.get("Twitch-Eventsub-Message-Signature") ?? "";
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(EVENTSUB_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(messageId + timestamp + rawBody),
  );
  const hex = [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}` === signature;
}

// Handles one channel.chat.message event: bumps the counter, then saves
// the message to the rolling recent_chat window (skipping commands/bots).
export async function countChatMessage(event: {
  broadcaster_user_id: string;
  chatter_user_id: string;
  chatter_user_login?: string;
  chatter_user_name?: string;
  message?: { text?: string };
}) {
  const botUserId = await getKv("bot_user_id");
  if (botUserId && event.chatter_user_id === botUserId) return;

  await sqlite.execute({
    sql: `UPDATE channels SET message_count = COALESCE(message_count, 0) + 1
          WHERE broadcaster_id = :id`,
    args: { id: event.broadcaster_user_id },
  });

  const login = (event.chatter_user_login ?? "").toLowerCase();
  const text = (event.message?.text ?? "").trim();
  if (!text || text.startsWith("!") || IGNORED_CHATTERS.has(login)) return;

  await sqlite.execute({
    sql: `INSERT INTO recent_chat (broadcaster_id, chatter, text, ts)
          VALUES (:id, :chatter, :text, :ts)`,
    args: {
      id: event.broadcaster_user_id,
      chatter: event.chatter_user_name ?? login,
      text: text.slice(0, 200),
      ts: Date.now(),
    },
  });

  // Keep only the newest 30 messages for this channel.
  await sqlite.execute({
    sql: `DELETE FROM recent_chat WHERE broadcaster_id = :id AND id NOT IN (
            SELECT id FROM recent_chat WHERE broadcaster_id = :id
            ORDER BY id DESC LIMIT 30
          )`,
    args: { id: event.broadcaster_user_id },
  });
}

// Looks up the current Twitch category for a batch of broadcaster ids.
export async function getGameNames(
  accessToken: string,
  broadcasterIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let i = 0; i < broadcasterIds.length; i += 100) {
    const chunk = broadcasterIds.slice(i, i + 100);
    const params = new URLSearchParams();
    for (const id of chunk) params.append("user_id", id);
    params.set("first", "100");
    try {
      const res = await fetch(
        `https://api.twitch.tv/helix/streams?${params.toString()}`,
        {
          headers: {
            "Client-Id": CLIENT_ID,
            "Authorization": `Bearer ${accessToken}`,
          },
        },
      );
      if (!res.ok) {
        console.error(
          "Twitch streams lookup failed:",
          res.status,
          await res.text(),
        );
        continue;
      }
      const data = await res.json();
      for (const s of data?.data ?? []) {
        if (s?.user_id && s?.game_name) result.set(s.user_id, s.game_name);
      }
    } catch (err) {
      console.error("Twitch streams lookup error:", err);
    }
  }
  return result;
}

// Sends one chat message. Returns true only when Twitch confirms it was sent.
export async function sendChatMessage(
  accessToken: string,
  botUserId: string,
  broadcasterId: string,
  message: string,
): Promise<boolean> {
  const res = await fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      "Client-Id": CLIENT_ID,
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: botUserId,
      message,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.data?.[0]?.is_sent === false) {
    console.error(
      `Failed to send to ${broadcasterId}:`,
      res.status,
      JSON.stringify(body),
    );
    return false;
  }
  console.log(`Sent to ${broadcasterId}: ${message}`);
  return true;
}
