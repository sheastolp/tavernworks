// Val Town HTTP Val — UndercoverBurn (invite page + EventSub webhook + poster, all in one)
// ------------------------------------------------------------------------------------------
//
// Set this val's trigger type to "HTTP". It now does the work of BOTH old vals:
//   - the invite/onboarding/admin site + EventSub webhook (HTTP requests), and
//   - the poster (runs when GET/POST /cron/run?key=<ADMIN_KEY> is hit, OR when
//     Val Town calls this same function with a cron Interval).
//
// A val can only have one trigger type, so to run the poster on a schedule create
// a tiny Cron val (every 5 minutes) containing just:
//
//   export default async function (_interval: Interval) {
//     await fetch("https://burn.tavernworks.dev/cron/run?key=" + Deno.env.get("ADMIN_KEY"));
//   }
//
// (Or point any external pinger / Cloudflare Cron Trigger at that URL.)
//
// PUBLIC URL
// ----------
// All links the bot hands out (Twitch OAuth redirect, EventSub webhook callback,
// admin links) use PUBLIC_BASE_URL, which defaults to https://burn.tavernworks.dev
// instead of whatever *.val.run host the request arrived on. Make sure that
// hostname actually routes to this val (Val Town custom domain, or a Cloudflare
// Worker/proxy in front of the .val.run URL), otherwise Twitch can't reach it.
//
// SETUP:
//
// 1. Register an app at https://dev.twitch.tv/console/apps (Category: Chat Bot).
//    Add "https://burn.tavernworks.dev/auth/callback" as an OAuth Redirect URL.
//
// 2. Env vars (Val Town secrets):
//      TWITCH_CLIENT_ID
//      TWITCH_CLIENT_SECRET
//      ADMIN_KEY                <- any password you make up
//      EVENTSUB_SECRET          <- random 10-100 char string
//      PUBLIC_BASE_URL          <- optional, default https://burn.tavernworks.dev
//      TWITCH_REDIRECT_URI      <- optional, default <PUBLIC_BASE_URL>/auth/callback
//
// 3. Visit https://burn.tavernworks.dev/auth/bot-setup ONCE, logged in as the
//    bot's own Twitch account (scopes user:bot + user:read:chat).
//
// 4. Share https://burn.tavernworks.dev/ as the public invite link.
//
// 5. Admin: https://burn.tavernworks.dev/channels?key=<ADMIN_KEY>
//    Backfill old channels once: /admin/sync-eventsub?key=<ADMIN_KEY>
//
// AD BREAK ALERTS
// ---------------
// The bot announces when an ad break starts (with its length) and welcomes
// chat back when it ends. Twitch only sends a "begin" event, so the end is
// timed by the val itself: the webhook calls /ads/finish on this val, which
// waits out the ad (re-calling itself every AD_TIMER_HOP_MS so no single
// request outlives Val Town's time limit) and then posts. If that timer gets
// cut short, the next poster run posts the welcome-back instead.
//
// Early warning: Twitch's ad event only arrives as the ad starts, so to warn
// chat AD_WARNING_LEAD_MS ahead the bot reads each channel's ad schedule
// (Get Ad Schedule) using the streamer's own token, saved at invite time.
// Each poster run checks the schedule, and once an ad is a few minutes out
// it starts an /ads/warn timer (same self-call trick) that re-checks the
// schedule right before posting, so snoozed or moved ads are followed. Ads
// the schedule can't see coming (a streamer clicking "Run ad") still get
// the notice the moment they start.
// The poster must run every 5 minutes or less for warnings to arm in time.
// Needs the channel:read:ads scope from each streamer. Channels invited before
// ad alerts existed show "re-invite" on the admin page: they just run the
// invite link again (nothing else about their setup changes).
//
// FILES
// -----
// This val is split across several files (Val Town caps a file at 80k
// characters). Keep the names exactly as below; they import each other.
//   main.ts      <- this file: HTTP site, webhooks, entry point (set as HTTP)
//   config.ts    <- env vars and tunable settings
//   messages.ts  <- roast lists and ad break messages
//   twitch.ts    <- database + Twitch API helpers
//   ads.ts       <- ad break alerts, warnings, and timers
//   poster.ts    <- quotes, AI commentary, and the poster
//
// Data lives in the account-wide SQLite database (std/sqlite "global").
// Commentary uses Val Town's built-in std/openai (no API key needed).

import { sqlite } from "https://esm.town/v/std/sqlite/global.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  ADMIN_KEY,
  BASE_URL,
  REDIRECT_URI,
  BOT_NAME,
  AD_TIMER_HOP_MS,
  AD_TIMER_MAX_HOPS,
  AD_WARNING_LEAD_MS,
  AD_WARNING_MAX_HOPS,
} from "./config.ts";
import {
  ensureTables,
  getKv,
  setKv,
  setLiveStatus,
  subscribeChatEvents,
  subscribeStreamEvents,
  subscribeAdEvents,
  verifyEventSubSignature,
  countChatMessage,
} from "./twitch.ts";
import {
  startSelfTimer,
  scheduleAdEnd,
  saveBroadcasterToken,
  postAdWarning,
  handleAdBreakBegin,
  finishAdBreak,
} from "./ads.ts";
import {
  runPoster,
} from "./poster.ts";

// ======================================================================
// HTTP SITE (formerly the invite val)
// ======================================================================

export function page(body: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${BOT_NAME}</title>
    <style>
      body{font-family:system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 20px;line-height:1.5;color:#1a1a1a}
      a.btn{display:inline-block;background:#9146FF;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:12px}
      code{background:#f2f2f2;padding:2px 6px;border-radius:4px}
      table{border-collapse:collapse;width:100%;margin-top:20px}
      th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eee;font-size:0.95em}
      form.remove{display:inline}
      form.inline{display:inline}
      button.remove{background:#e5484d;color:#fff;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.85em}
      button.row-toggle{background:#f2f2f2;color:#1a1a1a;border:1px solid #ddd;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.85em;margin-right:6px}
      button.toggle{border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:0.9em;font-weight:600}
      button.toggle.off{background:#e5484d;color:#fff}
      button.toggle.on{background:#2f9e44;color:#fff}
      .status-banner{display:flex;align-items:center;justify-content:space-between;background:#f7f7f7;border-radius:8px;padding:14px 18px;margin-top:20px}
      .badge{font-weight:600;padding:3px 10px;border-radius:999px;font-size:0.85em}
      .badge.on{background:#e6f6ea;color:#1a7f37}
      .badge.off{background:#fdeceb;color:#c4281c}
    </style></head><body>${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export function authorizeUrl(scope: string, state: string) {
  const u = new URL("https://id.twitch.tv/oauth2/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scope);
  u.searchParams.set("state", state);
  return u.toString();
}

export function adminLink(key: string) {
  return `${BASE_URL}/channels?key=${encodeURIComponent(key)}`;
}

export async function handleHttp(req: Request): Promise<Response> {
  await ensureTables();
  const url = new URL(req.url);

  // ---- Landing page ----
  if (url.pathname === "/" || url.pathname === "") {
    return page(`
      <h1>🥸 ${BOT_NAME}</h1>
      <p>${BOT_NAME} slips into your Twitch chat undercover, then blows
      its own cover with a playful roast, a quote pulled live from
      your own channel's StreamElements <code>!quote</code> list, or a
      one-liner reacting to what chat has been saying. It also gives
      chat a heads-up when an ad break starts and welcomes everyone
      back when it ends.</p>
      <p><a class="btn" href="${BASE_URL}/auth/start">Add ${BOT_NAME} to your channel</a></p>
      <p style="margin-top:16px;font-size:0.9em;color:#666">
        To react to chat, ${BOT_NAME} keeps your channel's most recent
        chat messages for a short time while you're live, and sends a
        handful of them to an AI service to write its one-liners. They're
        cleared when your stream ends.
      </p>
      <p style="margin-top:40px;font-size:0.9em;color:#666">
        First time setting this bot up? The bot account itself needs a
        one-time authorization at <a href="${BASE_URL}/auth/bot-setup">${BASE_URL}/auth/bot-setup</a>
        before any channel invites will work.
      </p>
    `);
  }

  // ---- Streamer invite flow ----
  if (url.pathname === "/auth/start") {
    return Response.redirect(authorizeUrl("channel:bot channel:read:ads", "channel"), 302);
  }

  // ---- Bot's own one-time authorization ----
  if (url.pathname === "/auth/bot-setup") {
    return Response.redirect(
      authorizeUrl("user:bot user:read:chat", "bot"),
      302,
    );
  }

  // ---- Shared OAuth callback ----
  if (url.pathname === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // "bot" or "channel"
    const error = url.searchParams.get("error");

    if (error) {
      return page(`<h1>Not authorized</h1><p>Twitch reported: ${error}</p>`);
    }
    if (!code) {
      return page(
        `<h1>Missing code</h1><p>Something went wrong — try again.</p>`,
      );
    }

    const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      return page(`<h1>Auth failed</h1><pre>${await tokenRes.text()}</pre>`);
    }
    const tokenData = await tokenRes.json();

    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-Id": CLIENT_ID,
        "Authorization": `Bearer ${tokenData.access_token}`,
      },
    });
    const userData = await userRes.json();
    const user = userData.data?.[0];
    if (!user) {
      return page(`<h1>Couldn't identify that account</h1>`);
    }

    // ---- Branch: bot's own one-time setup ----
    if (state === "bot") {
      await setKv("bot_user_id", user.id);
      await setKv("bot_login", user.login);
      return page(`
        <h1>✅ Bot account connected</h1>
        <p><strong>${user.display_name}</strong> is now authorized to send
        chat as ${BOT_NAME}. You only need to do this once.</p>
        <p><a href="${BASE_URL}/">Back home</a></p>
      `);
    }

    // ---- Branch: a streamer inviting the bot to their channel ----
    let seChannelId: string | null = null;
    try {
      const seRes = await fetch(
        `https://api.streamelements.com/kappa/v2/channels/${user.login}`,
      );
      if (seRes.ok) {
        const seData = await seRes.json();
        seChannelId = seData?._id ?? null;
      }
    } catch {
      // No StreamElements channel found — roasts alone still work fine.
    }

    await sqlite.execute({
      sql: `
        INSERT INTO channels (broadcaster_id, broadcaster_login, se_channel_id, enabled, message_count, is_live, added_at)
        VALUES (:id, :login, :se, 1, 0, 0, :now)
        ON CONFLICT(broadcaster_id) DO UPDATE SET
          broadcaster_login = excluded.broadcaster_login,
          se_channel_id = excluded.se_channel_id
      `,
      args: {
        id: user.id,
        login: user.login,
        se: seChannelId,
        now: Date.now(),
      },
    });

    // Keep the streamer's token so the bot can read their ad schedule.
    const grantedScopes: string[] = tokenData.scope ?? [];
    if (tokenData.refresh_token && grantedScopes.includes("channel:read:ads")) {
      await saveBroadcasterToken(user.id, tokenData);
    }

    // Best-effort EventSub subscriptions; don't block the install on failure.
    let adAlerts = false;
    try {
      await subscribeChatEvents(user.id);
      await subscribeStreamEvents(user.id);
      adAlerts = await subscribeAdEvents(user.id);
    } catch (err) {
      console.error("EventSub subscribe error during install:", err);
    }

    return page(`
      <h1>✅ Added!</h1>
      <p>${BOT_NAME} is now live in <strong>${user.display_name}</strong>'s channel.</p>
      <p>${
      seChannelId
        ? "Found your StreamElements channel too — quotes will mix in automatically."
        : "Didn't find a matching StreamElements channel, so it'll stick to roasts and chat reactions for now."
    }</p>
      <p>${
      adAlerts
        ? `Ad break alerts are on: chat gets a heads-up about ${
          Math.round(AD_WARNING_LEAD_MS / 1000)
        } seconds before scheduled ads and a welcome-back when they end.`
        : "Ad break alerts couldn't be turned on. Try the invite link again in a minute."
    }</p>
      <p style="margin-top:12px;font-size:0.9em;color:#666">
        ${BOT_NAME} only posts while you're actually live — it'll go
        quiet automatically when the stream ends and pick back up next
        time you go live. To react to chat, it keeps your most recent
        chat messages for a short time while you're live, sends a
        handful of them to an AI service, and clears them when your
        stream ends.
      </p>
    `);
  }

  // ---- EventSub webhook: receives chat + stream on/off, updates state ----
  if (url.pathname === "/eventsub/callback" && req.method === "POST") {
    const rawBody = await req.text();
    const valid = await verifyEventSubSignature(req, rawBody);
    if (!valid) {
      return new Response("Invalid signature", { status: 403 });
    }

    const messageType = req.headers.get("Twitch-Eventsub-Message-Type");

    if (messageType === "webhook_callback_verification") {
      const body = JSON.parse(rawBody);
      return new Response(body.challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (messageType === "revocation") {
      console.log("EventSub subscription revoked:", rawBody.slice(0, 300));
      const body = JSON.parse(rawBody);
      if (body.subscription?.type === "channel.ad_break.begin") {
        await sqlite.execute({
          sql: `UPDATE channels SET ads_subscribed = 0 WHERE broadcaster_id = :id`,
          args: { id: body.subscription.condition?.broadcaster_user_id ?? "" },
        }).catch((err) => console.error("ads_subscribed reset error:", err));
      }
      return new Response("", { status: 200 });
    }

    if (messageType === "notification") {
      const body = JSON.parse(rawBody);
      const subType = body.subscription?.type;
      if (subType === "channel.chat.message") {
        await countChatMessage(body.event).catch((err) =>
          console.error("countChatMessage error:", err)
        );
      } else if (subType === "stream.online") {
        console.log(`${body.event.broadcaster_user_login} went live`);
        await setLiveStatus(body.event.broadcaster_user_id, true).catch(
          (err) => console.error("setLiveStatus(online) error:", err),
        );
      } else if (subType === "stream.offline") {
        console.log(`${body.event.broadcaster_user_login} ended stream`);
        await setLiveStatus(body.event.broadcaster_user_id, false).catch(
          (err) => console.error("setLiveStatus(offline) error:", err),
        );
      } else if (subType === "channel.ad_break.begin") {
        const eventId = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
        await handleAdBreakBegin(body.event, eventId, url.origin).catch(
          (err) => console.error("handleAdBreakBegin error:", err),
        );
      }
      return new Response("", { status: 200 });
    }

    return new Response("", { status: 200 });
  }

  // ---- Poster trigger: hit by the tiny cron val / external pinger ----
  if (url.pathname === "/cron/run") {
    const key = url.searchParams.get("key");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized — add ?key=<ADMIN_KEY> to the URL.", {
        status: 401,
      });
    }
    await runPoster(url.origin);
    return new Response("poster run complete", { status: 200 });
  }

  // ---- Ad-warning timer: started by scheduleAdWarning ----
  if (url.pathname === "/ads/warn") {
    const key = url.searchParams.get("key");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    const id = url.searchParams.get("id") ?? "";
    const at = Number(url.searchParams.get("at") ?? 0);
    const hop = Number(url.searchParams.get("hop") ?? 0);
    const { rows } = await sqlite.execute({
      sql: `SELECT 1 FROM ad_warnings WHERE broadcaster_id = :id AND next_ad_at = :at`,
      args: { id, at },
    });
    if (!rows.length) return new Response("superseded", { status: 200 });

    const wait = at - AD_WARNING_LEAD_MS - Date.now();
    if (wait > AD_TIMER_HOP_MS && hop < AD_WARNING_MAX_HOPS) {
      await new Promise((r) => setTimeout(r, AD_TIMER_HOP_MS));
      await startSelfTimer(url.origin, "/ads/warn", {
        id,
        at: String(at),
        hop: String(hop + 1),
      });
      return new Response("timer continued", { status: 200 });
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await postAdWarning(id, at, url.origin);
    return new Response("warning checked", { status: 200 });
  }

  // ---- Ad-end timer: started by handleAdBreakBegin, waits out the ad ----
  if (url.pathname === "/ads/finish") {
    const key = url.searchParams.get("key");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    const id = url.searchParams.get("id") ?? "";
    const eventId = url.searchParams.get("event") ?? "";
    const hop = Number(url.searchParams.get("hop") ?? 0);
    const { rows } = await sqlite.execute({
      sql: `SELECT ends_at FROM ad_breaks
            WHERE broadcaster_id = :id AND event_id = :eid AND end_posted = 0`,
      args: { id, eid: eventId },
    });
    if (!rows.length) return new Response("nothing to do", { status: 200 });

    const wait = Number(rows[0][0]) - Date.now();
    if (wait > AD_TIMER_HOP_MS && hop < AD_TIMER_MAX_HOPS) {
      await new Promise((r) => setTimeout(r, AD_TIMER_HOP_MS));
      await scheduleAdEnd(url.origin, id, eventId, hop + 1);
      return new Response("timer continued", { status: 200 });
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await finishAdBreak(id, eventId);
    return new Response("ad break finished", { status: 200 });
  }

  // ---- Admin: subscribe every installed channel (one-time backfill) ----
  if (url.pathname === "/admin/sync-eventsub") {
    const key = url.searchParams.get("key");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized — add ?key=<ADMIN_KEY> to the URL.", {
        status: 401,
      });
    }
    const { rows } = await sqlite.execute(
      "SELECT broadcaster_id, broadcaster_login FROM channels",
    );
    const results: string[] = [];
    for (const row of rows) {
      const id = row[0] as string;
      const login = row[1] as string;
      try {
        await subscribeChatEvents(id);
        await subscribeStreamEvents(id);
        const ads = await subscribeAdEvents(id);
        results.push(
          `${login}: subscribed (or already was)` +
            (ads ? "" : " — ad alerts need a re-invite (channel:read:ads)"),
        );
      } catch (err) {
        results.push(`${login}: FAILED — ${err}`);
      }
    }
    return page(`
      <h1>EventSub sync</h1>
      <p>Attempted to subscribe ${rows.length} channel${
      rows.length === 1 ? "" : "s"
    } to chat, stream on/off, and ad break events.</p>
      <ul>${results.map((r) => `<li>${r}</li>`).join("")}</ul>
      <p style="margin-top:24px"><a href="${
      adminLink(key)
    }">Back to admin</a></p>
    `);
  }

  // ---- Admin: list / remove installed channels ----
  if (url.pathname === "/channels") {
    const key = url.searchParams.get("key");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized — add ?key=<ADMIN_KEY> to the URL.", {
        status: 401,
      });
    }

    const botEnabledRaw = await getKv("bot_enabled");
    const botEnabled = botEnabledRaw !== "0"; // default ON if never set

    const { rows } = await sqlite.execute(
      "SELECT broadcaster_id, broadcaster_login, se_channel_id, added_at, enabled, message_count, is_live, ads_subscribed, user_refresh_token IS NOT NULL FROM channels ORDER BY added_at DESC",
    );

    const tableRows = rows
      .map((row) => {
        const id = row[0] as string;
        const login = row[1] as string;
        const se = row[2] as string | null;
        const addedAt = new Date(row[3] as number).toLocaleString();
        const chEnabled = row[4] === null || row[4] === undefined
          ? true
          : Number(row[4]) === 1;
        const msgCount = row[5] === null || row[5] === undefined
          ? 0
          : Number(row[5]);
        const isLive = row[6] === null || row[6] === undefined
          ? false
          : Number(row[6]) === 1;
        const adsOn = Number(row[7]) === 1;
        const adWarnings = Number(row[8]) === 1;
        return `
          <tr>
            <td>${login}</td>
            <td>${se ? "✅" : "—"}</td>
            <td><span class="badge ${chEnabled ? "on" : "off"}">${
          chEnabled ? "ON" : "OFF"
        }</span></td>
            <td><span class="badge ${isLive ? "on" : "off"}">${
          isLive ? "LIVE" : "OFFLINE"
        }</span></td>
            <td>${
          adsOn && adWarnings
            ? "✅"
            : adsOn
            ? "✅ (re-invite for early warning)"
            : "re-invite"
        }</td>
            <td>${msgCount} new msgs</td>
            <td>${addedAt}</td>
            <td>
              <form class="inline" method="POST" action="${BASE_URL}/channels/toggle">
                <input type="hidden" name="id" value="${id}" />
                <input type="hidden" name="key" value="${ADMIN_KEY}" />
                <button class="row-toggle" type="submit">${
          chEnabled ? "Pause" : "Resume"
        }</button>
              </form>
              <form class="remove" method="POST" action="${BASE_URL}/channels/remove">
                <input type="hidden" name="id" value="${id}" />
                <input type="hidden" name="key" value="${ADMIN_KEY}" />
                <button class="remove" type="submit">Remove</button>
              </form>
            </td>
          </tr>`;
      })
      .join("");

    return page(`
      <h1>Installed channels</h1>
      <div class="status-banner">
        <div>
          <strong>Bot status:</strong>
          <span class="badge ${botEnabled ? "on" : "off"}">${
      botEnabled ? "ON" : "OFF"
    }</span>
          <div style="font-size:0.85em;color:#666;margin-top:4px">
            When OFF, the poster skips every channel until you flip it back on.
          </div>
        </div>
        <form method="POST" action="${BASE_URL}/admin/toggle-bot">
          <input type="hidden" name="key" value="${ADMIN_KEY}" />
          <button class="toggle ${botEnabled ? "off" : "on"}" type="submit">
            Turn bot ${botEnabled ? "OFF" : "ON"}
          </button>
        </form>
      </div>
      <p style="margin-top:20px">${rows.length} channel${
      rows.length === 1 ? "" : "s"
    } currently have ${BOT_NAME}. <strong>Live</strong> reflects each
      broadcaster's actual Twitch stream status via stream.online /
      stream.offline events — the poster only posts to channels that
      are LIVE. <strong>Ad alerts</strong> showing "re-invite" means that
      streamer added the bot before ad alerts existed; they just need to
      run the invite link again to grant <code>channel:read:ads</code>.
      "Re-invite for early warning" means ad alerts work but only arrive as
      the ad starts; re-inviting lets the bot read their ad schedule and warn
      chat about ${Math.round(AD_WARNING_LEAD_MS / 1000)} seconds ahead.</p>
      <table>
        <thead><tr><th>Channel</th><th>StreamElements</th><th>Status</th><th>Live</th><th>Ad alerts</th><th>Chat activity</th><th>Added</th><th></th></tr></thead>
        <tbody>${
      tableRows || `<tr><td colspan="8">No channels yet.</td></tr>`
    }</tbody>
      </table>
      <p style="margin-top:24px"><a href="${BASE_URL}/">Back home</a></p>
    `);
  }

  // ---- Admin: global on/off switch ----
  if (url.pathname === "/admin/toggle-bot" && req.method === "POST") {
    const form = await req.formData();
    const key = form.get("key");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    const current = await getKv("bot_enabled");
    const currentlyEnabled = current !== "0";
    await setKv("bot_enabled", currentlyEnabled ? "0" : "1");
    return Response.redirect(adminLink(key as string), 302);
  }

  // ---- Admin: per-channel pause/resume ----
  if (url.pathname === "/channels/toggle" && req.method === "POST") {
    const form = await req.formData();
    const key = form.get("key");
    const id = form.get("id");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (id) {
      const { rows } = await sqlite.execute({
        sql: "SELECT enabled FROM channels WHERE broadcaster_id = :id",
        args: { id: id as string },
      });
      const currentlyEnabled = rows.length
        ? (rows[0][0] === null || rows[0][0] === undefined
          ? true
          : Number(rows[0][0]) === 1)
        : true;
      await sqlite.execute({
        sql: "UPDATE channels SET enabled = :e WHERE broadcaster_id = :id",
        args: { e: currentlyEnabled ? 0 : 1, id: id as string },
      });
    }
    return Response.redirect(adminLink(key as string), 302);
  }

  // ---- Admin: remove a channel ----
  if (url.pathname === "/channels/remove" && req.method === "POST") {
    const form = await req.formData();
    const key = form.get("key");
    const id = form.get("id");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (id) {
      await sqlite.execute({
        sql: "DELETE FROM channels WHERE broadcaster_id = :id",
        args: { id: id as string },
      });
      await sqlite.execute({
        sql: "DELETE FROM recent_chat WHERE broadcaster_id = :id",
        args: { id: id as string },
      });
      await sqlite.execute({
        sql: "DELETE FROM ad_breaks WHERE broadcaster_id = :id",
        args: { id: id as string },
      });
      await sqlite.execute({
        sql: "DELETE FROM ad_warnings WHERE broadcaster_id = :id",
        args: { id: id as string },
      });
    }
    return Response.redirect(adminLink(key as string), 302);
  }

  return page(`<h1>404</h1><p><a href="${BASE_URL}/">Go home</a></p>`);
}

// ======================================================================
// ENTRY POINT
// ======================================================================

// HTTP trigger -> serve the site/webhooks. If this val is ever run by a cron
// trigger instead, the argument is an Interval and we just run the poster.
export default async function (arg: Request | Interval) {
  if (arg instanceof Request) return await handleHttp(arg);
  await runPoster();
}
