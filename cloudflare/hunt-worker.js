// Cloudflare Worker for hunt.tavernworks.dev.
// Serves the Wandering Clerk (Hunt & Hoard) val from our own domain without Val Town's
// paid custom-domain feature: every request is forwarded to the val and
// the response is passed back, so the address bar stays on tavernworks.dev.
//
// One exception: a bare GET /onboard is answered here with the onboarding
// page below. Any /onboard request carrying a query string (the page's own
// "Connect with Twitch" button, and Twitch's ?code=/?error= callback) still
// goes to the val, so its existing channel:bot OAuth flow is untouched.
const VAL_ORIGIN = "https://huntandhoardbot.val.run";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && /^\/onboard\/?$/.test(url.pathname) && !url.search) {
      return new Response(ONBOARD_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }

    const target = new URL(url.pathname + url.search, VAL_ORIGIN);

    const upstream = await fetch(new Request(target, request), { redirect: "manual" });

    // Keep redirects that point back at the val on our domain. Redirects to
    // anywhere else (e.g. Twitch login) pass through untouched.
    const location = upstream.headers.get("Location");
    if (location) {
      const loc = new URL(location, VAL_ORIGIN);
      if (loc.origin === VAL_ORIGIN) {
        const headers = new Headers(upstream.headers);
        headers.set("Location", url.origin + loc.pathname + loc.search + loc.hash);
        return new Response(upstream.body, { status: upstream.status, headers });
      }
    }
    return upstream;
  },
};

const TWITCH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.3 3 3 6.4v13.4h4.6V22h2.6l2.2-2.2h3.5l4.6-4.6V3H4.3Zm14.6 11.4-2.7 2.7h-4.3L9.6 19.4v-2.3H6V4.7h12.9v9.7ZM16.2 7.9v4.7h-1.7V7.9h1.7Zm-4.6 0v4.7H9.9V7.9h1.7Z"/></svg>`;

const ONBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bring the Clerk Home · Tavernworks</title>
<meta name="description" content="Add The Wandering Clerk, the Hunt &amp; Hoard chat RPG, to your Twitch channel in one click.">
<meta property="og:title" content="Bring the Clerk Home · Tavernworks">
<meta property="og:description" content="Add The Wandering Clerk to your Twitch channel in one click. Enlist, hunt, fill bounties and spend your gold, all from chat.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗝️</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#15100c; --bg2:#1e1611; --card:#241a13; --line:#3a2a1d;
    --text:#f1e6d6; --muted:#b9a68f; --gold:#e0a84a; --gold2:#f5c873;
    --ember:#c9572b; --green:#7fb069; --twitch:#9146ff; --arcane:#9b7bd8;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{
    font-family:Inter,system-ui,sans-serif;color:var(--text);line-height:1.6;
    background:
      radial-gradient(ellipse 80% 50% at 50% -10%, rgba(224,120,60,.16), transparent 70%),
      radial-gradient(ellipse 60% 40% at 50% 110%, rgba(201,87,43,.12), transparent 70%),
      var(--bg);
    min-height:100vh;
  }
  a{color:inherit;text-decoration:none}
  .wrap{max-width:860px;margin:0 auto;padding:0 16px}

  nav{padding:22px 0 0}
  .back{font-size:14px;color:var(--muted);transition:.15s}
  .back:hover{color:var(--gold2)}

  header{padding:44px 0 8px;text-align:center}
  .orb{font-size:60px;line-height:1;filter:drop-shadow(0 0 24px rgba(155,123,216,.45))}
  .sign{
    display:inline-block;font-family:Cinzel,serif;font-size:13px;letter-spacing:.3em;
    color:var(--gold);border:1px solid var(--line);padding:6px 16px;border-radius:999px;
    background:rgba(0,0,0,.25);margin:20px 0 18px
  }
  h1{
    font-family:Cinzel,serif;font-weight:800;font-size:clamp(28px,7.5vw,60px);overflow-wrap:anywhere;line-height:1.08;
    background:linear-gradient(180deg,var(--gold2),var(--gold) 55%,#a8722a);
    -webkit-background-clip:text;background-clip:text;color:transparent
  }
  .tag{margin:16px auto 0;color:var(--muted);font-size:18px;max-width:600px}
  .tag b{color:var(--text);font-weight:600}

  .hero-cta{margin-top:28px;display:flex;flex-direction:column;align-items:center;gap:12px}
  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:12px 22px;border-radius:12px;
    font-weight:600;border:1px solid var(--line);background:var(--bg2);transition:.15s
  }
  .btn:hover{transform:translateY(-2px);border-color:var(--gold)}
  .btn.twitch{background:var(--twitch);border-color:var(--twitch);color:#fff}
  .btn.twitch:hover{filter:brightness(1.1);border-color:#fff}
  .btn.big{font-size:17px;padding:15px 28px}
  .btn svg{width:20px;height:20px;fill:currentColor}
  .fine{font-size:13.5px;color:var(--muted)}
  .fine b{color:var(--text);font-weight:600}

  .divider{
    display:flex;align-items:center;gap:14px;margin:52px 0 22px;
    font-family:Cinzel,serif;color:var(--gold);letter-spacing:.15em;font-size:15px;text-align:center
  }
  .divider::before,.divider::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,transparent,var(--line),transparent)}

  .steps{list-style:none;display:flex;flex-direction:column;gap:14px;counter-reset:step}
  .steps li{
    counter-increment:step;position:relative;padding:20px 22px 20px 74px;
    background:linear-gradient(180deg,var(--card),var(--bg2));border:1px solid var(--line);border-radius:16px
  }
  .steps li::before{
    content:counter(step);position:absolute;left:22px;top:20px;width:36px;height:36px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;font-family:Cinzel,serif;font-weight:800;
    color:var(--bg);background:linear-gradient(180deg,var(--gold2),var(--gold))
  }
  .steps h3{font-family:Cinzel,serif;font-size:18px;color:var(--gold2);margin-bottom:4px}
  .steps p{color:var(--muted);font-size:15px}
  .steps b{color:var(--text);font-weight:600}
  .opt{font-family:Inter,sans-serif;font-size:11px;font-weight:600;letter-spacing:.05em;padding:2px 9px;border-radius:999px;
    background:rgba(255,255,255,.06);color:var(--muted);vertical-align:middle;margin-left:6px;white-space:nowrap}

  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}
  .card{
    background:linear-gradient(180deg,var(--card),var(--bg2));
    border:1px solid var(--line);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:10px
  }
  .card h3{font-family:Cinzel,serif;font-size:17px;color:var(--gold2)}
  .card ul{list-style:none;display:flex;flex-direction:column;gap:7px}
  .card li{font-size:14.5px;padding-left:22px;position:relative;color:var(--muted)}
  .card li::before{position:absolute;left:0;top:0}
  .yes li::before{content:"✓";color:var(--green);font-weight:700}
  .no li::before{content:"✕";color:var(--ember);font-weight:700}

  .scroll{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px}
  .scroll p{color:var(--muted)}
  .scroll b{color:var(--text);font-weight:600}

  .cmds{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:10px;margin-top:16px}
  .cmd{background:rgba(0,0,0,.22);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px;color:var(--muted)}
  .cmd code{display:block;font-weight:600;margin-bottom:2px}

  code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;color:var(--gold2);overflow-wrap:anywhere}

  .faq details{border-bottom:1px solid var(--line);padding:14px 0}
  .faq details:first-child{padding-top:0}
  .faq details:last-child{border-bottom:0;padding-bottom:0}
  .faq summary{cursor:pointer;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:12px}
  .faq summary::-webkit-details-marker{display:none}
  .faq summary::after{content:"+";color:var(--gold);font-weight:400;font-size:20px;line-height:1}
  .faq details[open] summary::after{content:"−"}
  .faq details p{color:var(--muted);font-size:14.5px;margin-top:8px}
  .scroll a{color:var(--gold2)}
  .scroll a:hover{text-decoration:underline}
  .scroll a.btn{color:#fff;text-decoration:none}

  .final{text-align:center}
  .final p{margin-bottom:18px}

  footer{text-align:center;color:var(--muted);font-size:13px;padding:56px 0 40px}
  footer span{color:var(--gold)}
  footer a:hover{color:var(--gold2)}

  @media (max-width:520px){
    .steps li{padding:66px 18px 18px}
    .steps li::before{left:18px;top:18px}
    .tag{font-size:16.5px}
  }
</style>
</head>
<body>
<div class="wrap">

  <nav><a class="back" href="https://tavernworks.dev/wandering-clerk/">← About the Wandering Clerk</a></nav>

  <header>
    <div class="orb">🗝️</div>
    <div class="sign">ONBOARDING</div>
    <h1>Bring the Clerk to Your Channel</h1>
    <p class="tag">The Wandering Clerk runs <b>GuildBreak: Hunt &amp; Hoard</b>, a hunt-and-loot RPG played entirely in Twitch chat. Setting up takes one click and about a minute.</p>
    <div class="hero-cta">
      <a class="btn twitch big" href="/onboard?connect=1">${TWITCH_ICON} Connect with Twitch</a>
      <span class="fine">Sign in as the <b>broadcaster</b>. Twitch asks for one permission: <code>channel:bot</code>.</span>
    </div>
  </header>

  <div class="divider">FOUR STEPS TO AN OPEN DESK</div>
  <ol class="steps">
    <li>
      <h3>Connect with Twitch</h3>
      <p>Press the button above while signed in to the channel you want the Clerk in. Twitch shows you exactly one permission, <code>channel:bot</code>, which lets the Clerk's own account read and post in your chat. Approve it and the hard part is over.</p>
    </li>
    <li>
      <h3>Wait for the Clerk to arrive</h3>
      <p>The Clerk checks for new channels every few minutes. Once it finds yours it posts <b>"The Wandering Clerk has set up a desk here!"</b> in your chat. Allow up to about 15 minutes if the bot happens to be between runs.</p>
    </li>
    <li>
      <h3>Make the Clerk a moderator <span class="opt">RECOMMENDED</span></h3>
      <p>Type <code>/mod</code> followed by the Clerk's username in your chat. Without it, Twitch can quietly drop the Clerk's replies in slow mode, unique-chat mode or followers-only mode, or when AutoMod holds them.</p>
    </li>
    <li>
      <h3>Tune it to your stream <span class="opt">OPTIONAL</span></h3>
      <p>Type <code>!clerkadmin</code> in your chat. The Clerk replies with a link to the <b>Back Room</b>, where you sign in with Twitch and switch parts on or off for your channel: characters, combat, the shop, quests and each kind of announcement.</p>
    </li>
  </ol>

  <div class="divider">WHAT YOU'RE GRANTING</div>
  <div class="grid">
    <div class="card yes">
      <h3>The Clerk can</h3>
      <ul>
        <li>Read chat messages in your channel</li>
        <li>Post replies in your chat under its own name</li>
        <li>Answer <code>!commands</code> and post an occasional announcement while you're live</li>
      </ul>
    </div>
    <div class="card no">
      <h3>The Clerk can't</h3>
      <ul>
        <li>Post or act as you</li>
        <li>See your email, stream key, subs or payouts</li>
        <li>Change your stream title, category or settings</li>
      </ul>
    </div>
  </div>

  <div class="divider">TELL YOUR CHAT</div>
  <div class="scroll">
    <p>Once the Clerk is in, viewers can jump straight in. <b>Characters follow each viewer's Twitch account</b>, so anyone who already plays in another channel keeps their adventurer.</p>
    <div class="cmds">
      <div class="cmd"><code>!start</code>Where you stand and what to do next</div>
      <div class="cmd"><code>!enlist random</code>Get sworn in with a rolled character</div>
      <div class="cmd"><code>!hunt</code>Fight a monster matched to your level</div>
      <div class="cmd"><code>!quests</code>The shared bounty board</div>
      <div class="cmd"><code>!merchant</code>Potions, weapons and armor for sale</div>
      <div class="cmd"><code>!help</code>The full charter of commands</div>
    </div>
    <p class="fine" style="margin-top:14px">Every command is listed in the <a href="/commands">command guide</a>.</p>
  </div>

  <div class="divider">QUESTIONS AT THE BAR</div>
  <div class="scroll faq">
    <details>
      <summary>Does it cost anything?</summary>
      <p>No. The Clerk is free to add and free to play.</p>
    </details>
    <details>
      <summary>Will it spam my chat?</summary>
      <p>No. Besides answering commands, the Clerk only posts the odd announcement (new stall wares, fresh bounties, a bit of item lore, a nudge to <code>!start</code>), only while you're live, and never more than once per 30 minutes or 5 chat messages. Each kind of announcement can be switched off in the Back Room.</p>
    </details>
    <details>
      <summary>Who can change the Clerk's settings in my channel?</summary>
      <p>You and your moderators. <code>!clerkadmin</code> only answers the broadcaster and mods, and the Back Room checks your Twitch sign-in before it lets you change anything.</p>
    </details>
    <details>
      <summary>The Clerk never showed up. What now?</summary>
      <p>Give it 15 minutes first. If it still hasn't greeted your chat, make sure you signed in as the broadcaster account (not a mod or an alt) and approved the permission, then press <b>Connect with Twitch</b> again. Still nothing? Drop by <a href="https://twitch.tv/stonedsheamus" target="_blank" rel="noopener">the stream</a> and ask.</p>
    </details>
    <details>
      <summary>How do I remove the Clerk?</summary>
      <p>You or a mod can type <code>!clerkleave</code> followed by your channel name in chat, and the Clerk stops replying there. To revoke the permission entirely, open <a href="https://www.twitch.tv/settings/connections" target="_blank" rel="noopener">Twitch Settings → Connections</a> and disconnect the app.</p>
    </details>
    <details>
      <summary>What happens to my viewers' characters if I remove it?</summary>
      <p>Nothing. Characters belong to each viewer's Twitch account, not to your channel, so they keep their level, gold and gear for the next time they play.</p>
    </details>
  </div>

  <div class="divider">READY?</div>
  <div class="scroll final">
    <p>One click, one permission, and the Clerk opens a ledger in your chat.</p>
    <a class="btn twitch big" href="/onboard?connect=1">${TWITCH_ICON} Connect with Twitch</a>
  </div>

  <footer><a href="https://tavernworks.dev/">Tavernworks</a> · <span>hunt.tavernworks.dev</span> · Brewed by Stoned Sheamus</footer>
</div>
</body>
</html>`;
