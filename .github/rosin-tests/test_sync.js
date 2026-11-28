// Rosin: settings sync between devices, Twitch status and answering, the stream view, the mic picker and "Rosin, …",
// against the real gate (local-ai/gate/server.mjs) running on this machine, at phone, Legion Go 2 and PC sizes.
// Run: GATE on 127.0.0.1:18900 (GATE_KEY=testkey1234567890, GATE_ORIGINS=http://127.0.0.1:8099, STATE_DIRECTORY set),
// the repo root served on 127.0.0.1:8099, then: node test_sync.js
const { chromium } = require("playwright");
const SHOTS = process.env.SHOTS;
const SITE = "http://127.0.0.1:8099", GATE = "http://127.0.0.1:18900", KEY = "testkey1234567890";
const TAILNET = "https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:10000";
let pass = 0, fail = 0;
const ok = (c, n, x = "") => { c ? (pass++, console.log("PASS", n)) : (fail++, console.log("FAIL", n, x)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const LEGION = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const WINAPP = LEGION + " RosinApp/Windows Rosin/1.0.12";

// A fake Twitch chat: confirms channels in `known`, and lets a test send chat lines.
function fakeTwitch(known = ["stonedsheamus"]) {
  const T = { sockets: [], joins: [] };
  T.say = (user, text) => { for (const ws of T.sockets) for (const ch of ws.chans) ws.send(`@badge-info=;display-name=${user};id=${Math.random().toString(36).slice(2)};mod=0;subscriber=0 :${user.toLowerCase()}!${user.toLowerCase()}@x.tmi.twitch.tv PRIVMSG #${ch} :${text}\r\n`); };
  T.attach = async (ctx) => ctx.routeWebSocket(/irc-ws\.chat\.twitch\.tv/, (ws) => {
    ws.chans = []; T.sockets.push(ws);
    ws.onMessage((m) => {
      for (const line of String(m).split("\r\n")) {
        const j = /^JOIN #(\w+)/.exec(line);
        if (j) { T.joins.push(j[1]); if (known.includes(j[1])) { ws.chans.push(j[1]); ws.send(`@emote-only=0;room-id=1 :tmi.twitch.tv ROOMSTATE #${j[1]}\r\n`); } }
      }
    });
  });
  return T;
}

async function device(browser, { w, h, mob, ua, start = "/rosin/", seed = {}, twitch, perms = true }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: !!mob, hasTouch: !!mob || /Edg/.test(ua || ""), userAgent: ua,
    permissions: perms ? ["microphone"] : [] });
  // The page talks to the laptop's gate; here that's the real gate on this machine.
  await ctx.route(TAILNET + "/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/chat" || u.pathname.startsWith("/api/models") || u.pathname === "/api/voices") return r.fulfill({ status: 503, contentType: "application/json", headers: { "Access-Control-Allow-Origin": SITE }, body: '{"error":"no model here"}' });
    try {
      const resp = await r.fetch({ url: GATE + u.pathname + u.search, timeout: 40000 });
      return r.fulfill({ response: resp });
    } catch { return r.abort(); }
  });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)(?!sheamus-tuf)/, (r) => r.abort());
  if (twitch) await twitch.attach(ctx);
  await ctx.addInitScript(([seed, KEY]) => {
    if (sessionStorage.getItem("seeded")) return; sessionStorage.setItem("seeded", "1");
    localStorage.setItem("tavernworks.gateKey", KEY);
    localStorage.setItem("rosin.web.voiceOn", "false");
    for (const [k, v] of Object.entries(seed)) localStorage.setItem("rosin.web." + k, JSON.stringify(v));
  }, [seed, KEY]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR", w + "x" + h, e.message));
  await page.goto(SITE + start);
  await page.evaluate(() => document.getElementById("wake")?.click());
  await page.waitForTimeout(800);
  return { ctx, page };
}
const get = (page, k) => page.evaluate((k) => JSON.parse(localStorage.getItem("rosin.web." + k)), k);
const openTwitch = async (page) => {
  await page.evaluate(() => { if (document.getElementById("twitch").hidden) { if (document.getElementById("more").hidden) document.querySelector('[aria-controls="more"]').click(); document.getElementById("btn-twitch").click(); } });
  await page.waitForTimeout(400);
};
const fits = (page, id) => page.evaluate((id) => {
  const m = document.getElementById(id), r = m.getBoundingClientRect(), bad = [];
  for (const b of m.querySelectorAll("button, select, input")) {
    if (!b.offsetParent) continue;
    const x = b.getBoundingClientRect();
    if (x.right > innerWidth + 1 || x.left < -1) bad.push((b.textContent || b.tagName) + " off screen");
    if ((b.tagName === "BUTTON" || b.tagName === "SELECT") && x.height < (innerHeight <= 500 ? 40 : 44)) bad.push((b.textContent || b.tagName).slice(0, 30) + " short " + x.height);
  }
  return { bad, hscroll: document.documentElement.scrollWidth > innerWidth, inView: r.top >= -1 && r.bottom <= innerHeight + 1, h: Math.round(r.height) };
}, id);

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, executablePath: process.env.CHROME || undefined,
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });

  // 1. A change on the phone shows up on the Windows app within a couple of seconds, and the other way round.
  const tw = fakeTwitch();
  const phone = await device(browser, { w: 360, h: 740, mob: true, ua: PHONE + " RosinApp/Android Rosin/1.0.12", start: "/rosin/?app=android&device=android-app", twitch: tw,
    seed: { name: "Sheamus", channel: "", twitchOn: false } });
  await phone.page.waitForTimeout(1500);
  const win = await device(browser, { w: 1280, h: 800, ua: WINAPP, start: "/rosin/?app=desktop&device=windows-app", twitch: tw });
  await win.page.waitForTimeout(1500);
  ok((await get(win.page, "name")) === "Sheamus", "the Windows app picks up settings the phone already had", await get(win.page, "name"));
  ok(await win.page.evaluate(() => document.querySelector('#more input[autocomplete="nickname"]').value) === "Sheamus", "…and its ⋯ menu shows them");

  let t0 = Date.now();
  await phone.page.evaluate(() => { const m = document.getElementById("more"); if (m.hidden) document.querySelector('[aria-controls="more"]').click(); });
  await phone.page.fill('#more input[placeholder="channel name"]', "stonedsheamus");
  await phone.page.press('#more input[placeholder="channel name"]', "Tab");
  await phone.page.evaluate(() => { const b = [...document.querySelectorAll("#more label.chk")].find((l) => /Answer this Twitch chat/.test(l.textContent))?.querySelector("input"); if (b && !b.checked) b.click(); });
  let got = false;
  for (let i = 0; i < 40 && !got; i++) { await wait(100); got = (await get(win.page, "channel")) === "stonedsheamus" && (await get(win.page, "twitchOn")) === true; }
  ok(got && Date.now() - t0 < 4000, `phone sets the Twitch channel: the Windows app has it in ${Date.now() - t0} ms`);
  ok(await win.page.evaluate(() => document.querySelector('#more input[placeholder="channel name"]').value) === "stonedsheamus", "the Windows app's ⋯ shows the new channel");

  t0 = Date.now();
  await win.page.evaluate(() => { const I = window.RosinBrain.initiative.settings; window.RosinBrain._hooks.store.set("init.level", 3); });
  got = false;
  for (let i = 0; i < 40 && !got; i++) { await wait(100); got = (await phone.page.evaluate(() => window.RosinBrain.initiative.settings.level)) === 3; }
  ok(got, `Windows app changes Initiative: the phone's Initiative follows in ${Date.now() - t0} ms`);
  await win.page.evaluate(() => window.RosinBrain._hooks.store.set("voice", "Microsoft Aria Online"));
  await wait(1500);
  ok((await get(phone.page, "voice")) !== "Microsoft Aria Online", "a voice only the PC has doesn't sync to the phone");
  await win.page.evaluate(() => window.RosinBrain._hooks.store.set("mic.device", "abc"));
  await wait(1200);
  ok((await get(phone.page, "mic.device")) !== "abc", "the microphone pick stays on its own device");

  // 2. Twitch: both watch, Twitch confirms the channel, the Windows app answers and the phone shows that.
  await wait(3000);
  const chipW = await win.page.evaluate(() => { const c = document.getElementById("twchip"); return { hidden: c.hidden, text: c.textContent, state: c.dataset.state }; });
  ok(!chipW.hidden && chipW.state === "watching" && /#stonedsheamus/.test(chipW.text), "Windows app: chip says it's watching #stonedsheamus", JSON.stringify(chipW));
  tw.say("ViewerOne", "hey rosin how's the grove today");
  await wait(16000);   // one heartbeat round
  await openTwitch(phone.page); await openTwitch(win.page);
  const pW = await win.page.evaluate(() => [...document.querySelectorAll("#twitch p")].map((p) => p.textContent).join(" | "));
  const pP = await phone.page.evaluate(() => [...document.querySelectorAll("#twitch p")].map((p) => p.textContent).join(" | "));
  ok(/Watching #stonedsheamus\. Twitch confirmed the channel/.test(pW) && /ViewerOne: “hey rosin how's the grove today”/.test(pW), "Windows app: ⋯ → Twitch shows the channel confirmed and the last message", pW);
  ok(/Answering chat from this device \(Windows app\)/.test(pW), "Windows app answers chat", pW);
  ok(/Windows app is answering chat\. This device just watches\./.test(pP), "phone says the Windows app is answering", pP);
  ok(await phone.page.evaluate(() => window.RosinBrain._hooks.answerHere()) === false, "the phone doesn't answer chat itself");
  for (const [name, d] of [["phone", phone], ["Legion Go 2 (Windows app)", win]]) {
    const f = await fits(d.page, "twitch");
    ok(!f.bad.length && !f.hscroll && f.inView, `${name}: ⋯ → Twitch fits, buttons big enough`, JSON.stringify(f));
    if (SHOTS) await d.page.screenshot({ path: `${SHOTS}/twitch-${name.split(" ")[0]}.png` });
  }
  // "Answer chat from here" on the phone, and the Windows app doesn't grab it back.
  await phone.page.click("#twitch button:has-text('Answer chat from here')");
  await wait(17000);
  ok(await phone.page.evaluate(() => window.RosinBrain._hooks.answerHere()) === true && await win.page.evaluate(() => window.RosinBrain._hooks.answerHere()) === false, "Answer chat from here moves answering to the phone, and it stays there");

  // Mention-only mode: lines that don't name Rosin aren't queued.
  await phone.page.evaluate(() => { document.querySelector("#twitch select").value = "mention"; document.querySelector("#twitch select").dispatchEvent(new Event("change")); });
  await wait(1500);
  ok((await get(win.page, "chat.mode")) === "mention", "answer mode syncs to the other device");
  await phone.page.evaluate(() => { window.__p0 = window.RosinBrain._hooks.twitchStatus().seen; });
  tw.say("ViewerTwo", "what game is this");
  tw.say("ViewerThree", "@rosin do you like pizza");
  await wait(600);
  const st = await phone.page.evaluate(() => ({ s: window.RosinBrain._hooks.twitchStatus(), p0: window.__p0 }));
  ok(st.s.seen - st.p0 === 2, "both lines are seen and counted", JSON.stringify(st));
  ok(st.s.waiting <= 1, "only the line naming Rosin waits to be answered", JSON.stringify(st.s));

  // A channel Twitch doesn't know: the chip warns and the panel says to check the name.
  const bad = await device(browser, { w: 1920, h: 1080, start: "/rosin/?sync=0", seed: { channel: "notachannelzz", twitchOn: true }, twitch: tw });
  await wait(13500);
  const b = await bad.page.evaluate(() => ({ chip: document.getElementById("twchip").textContent, state: document.getElementById("twchip").dataset.state, status: document.getElementById("status").textContent }));
  ok(b.state === "error" && /⚠/.test(b.chip) && /Check the channel name/.test(b.status), "PC: a wrong channel name shows a warning to check it", JSON.stringify(b));
  await bad.ctx.close();

  // 3. The stream view: Rosin only, copying the main window.
  const s = await win.ctx.newPage();
  s.on("pageerror", (e) => console.log("PAGE ERROR stream", e.message));
  await s.goto(SITE + "/rosin/?app=desktop&device=windows-app&view=stream&bg=green");
  await wait(1500);
  await win.page.evaluate(() => { window.Rosin.setExpression("laugh", 8000); window.Rosin.subs("Only Rosin shows in this window."); window.Rosin.talking(true); });
  await wait(600);
  const sv = await s.evaluate(() => ({ face: window.Rosin.expression, subs: document.getElementById("subs").textContent,
    visible: [...document.querySelectorAll("button, input, select, .tray, #badge, #status, #twchip")].filter((e) => e.offsetParent || getComputedStyle(e).display !== "none" && e.getClientRects().length).map((e) => e.id || e.className || e.tagName),
    bg: getComputedStyle(document.body).backgroundColor, title: document.title }));
  ok(sv.face === "laugh" && sv.subs === "Only Rosin shows in this window.", "stream view copies Rosin's face and subtitles", JSON.stringify(sv));
  ok(sv.visible.length === 0, "stream view shows no buttons, menus or status", JSON.stringify(sv.visible));
  ok(sv.bg === "rgb(0, 177, 64)" && sv.title === "Rosin – Stream", "green background for Chroma Key, window titled Rosin – Stream", JSON.stringify(sv));
  if (SHOTS) await s.screenshot({ path: `${SHOTS}/stream-green.png` });
  const s2 = await win.ctx.newPage(); await s2.goto(SITE + "/rosin/?app=desktop&device=windows-app&view=stream"); await wait(1500);
  ok(await s2.evaluate(() => window.Rosin.expression) === "laugh", "a stream view opened later catches up straight away");
  if (SHOTS) await s2.screenshot({ path: `${SHOTS}/stream-grove.png` });
  ok(await s2.evaluate(() => !window.RosinBrain), "the stream view doesn't run a second Rosin brain");
  await s.close(); await s2.close();

  // 4. Microphone picker and "Rosin, …"
  await win.page.evaluate(() => { const m = document.getElementById("more"); document.getElementById("twitch").hidden = true; if (m.hidden) document.querySelector('[aria-controls="more"]').click(); });
  const mic = await win.page.evaluate(async () => { await window.RosinBrain.ear.mics(); const sel = [...document.querySelectorAll("#more .field")].find((f) => /^Microphone/.test(f.textContent))?.querySelector("select"); return sel ? [...sel.options].map((o) => o.textContent) : null; });
  ok(mic && mic.length >= 2 && /Default/.test(mic[0]), "⋯ → Microphone lists the mics", JSON.stringify(mic));
  const A = (t) => win.page.evaluate((t) => window.RosinBrain.ear.afterName(t), t);
  ok((await A("Rosin, what's the weather?")) === "what's the weather?", "“Rosin, what's the weather?” is for Rosin");
  ok((await A("Hey Rosen skip this song")) === "skip this song", "Whisper's “Rosen” counts too");
  ok((await A("I was talking about rosin bags")) === null, "a sentence that doesn't start with Rosin's name is ignored");
  ok((await A("Rosin.")) === "", "just “Rosin” waits for the rest");
  await win.page.evaluate(() => window.RosinBrain.ear.command("stop answering chat"));
  await wait(1500);
  ok((await get(win.page, "twitchOn")) === false && (await get(phone.page, "twitchOn")) === false, "“Rosin, stop answering chat” turns Twitch off, on every device");
  await win.page.evaluate(() => window.RosinBrain.ear.command("look surprised"));
  ok(await win.page.evaluate(() => window.Rosin.expression) === "surprise", "“Rosin, look surprised” changes the face");
  await win.page.evaluate(() => document.querySelector("#more .ear-box input[type=checkbox]").click());
  await wait(1500);
  ok(await win.page.evaluate(() => window.RosinBrain.ear.listening()), "Listen for “Rosin” opens the mic");
  if (SHOTS) { await win.page.evaluate(() => document.querySelector("#more .ear-box").scrollIntoView()); await win.page.screenshot({ path: `${SHOTS}/mic-Legion.png` }); }

  // 5. Layout at every size: the chip and the Twitch panel.
  for (const [name, w, h, mob, ua] of [["phone 360", 360, 740, true, PHONE], ["phone 320", 320, 640, true, PHONE], ["phone sideways", 740, 360, true, PHONE],
    ["Legion Go 2", 1280, 800, false, LEGION], ["Legion Go 2 portrait", 800, 1280, false, LEGION], ["PC", 1920, 1080, false, undefined]]) {
    const d = await device(browser, { w, h, mob, ua, start: "/rosin/?sync=0", seed: { channel: "stonedsheamus", twitchOn: true }, twitch: tw });
    await wait(1500);
    const chip = await d.page.evaluate(() => { const r = document.getElementById("twchip").getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, vis: !!document.getElementById("twchip").offsetParent }; });
    ok(chip.vis && chip.right <= w && chip.h >= 32, `${name}: Twitch chip shows and fits`, JSON.stringify(chip));
    await d.page.click("#twchip"); await wait(400);
    const f = await fits(d.page, "twitch");
    ok(!f.bad.length && !f.hscroll && f.inView, `${name}: tapping the chip opens ⋯ → Twitch and it fits`, JSON.stringify(f));
    if (SHOTS) await d.page.screenshot({ path: `${SHOTS}/layout-${name.replace(/ /g, "-")}.png` });
    await d.ctx.close();
  }

  await phone.ctx.close(); await win.ctx.close();
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(2); });
