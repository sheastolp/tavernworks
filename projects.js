// Tavernworks projects: the cards on the home page and every change on
// The Path So Far. Edit by hand or at /workshop/.
//
// projects: one per lane on the path, in card order. dir is the project's
//   folder in this repo ("." for the whole repo, "" if it lives
//   elsewhere); card is null for projects without a card in The Bots or
//   The Workbench.
// changes: [project key, date, what changed, where it lives], oldest first.
// shown: how many of the most recently changed projects get a lane.
//
// Everything after "window.TAVERN_PROJECTS =" must stay plain JSON.
window.TAVERN_PROJECTS = {
  "shown": 7,
  "projects": [
    {
      "key": "home",
      "icon": "🍺",
      "name": "The Tavern",
      "href": "/",
      "dir": ".",
      "card": null
    },
    {
      "key": "guildscribe",
      "icon": "📜",
      "name": "GuildScribe",
      "href": "https://guildscribe.tavernworks.dev/",
      "dir": "",
      "card": {
        "section": "bots",
        "title": "GuildScribe",
        "text": "The D&amp;D chat bot behind the stream. Dice rolls, saves and skill checks, spell and monster lookups, and full character sheets with HP tracking.",
        "href": "",
        "url": "guildscribe.tavernworks.dev",
        "pill": "LIVE",
        "pillKind": "live",
        "links": [
          {
            "label": "🏠 Homepage",
            "href": "https://guildscribe.tavernworks.dev/"
          },
          {
            "label": "📖 Guide",
            "href": "https://guildscribe.tavernworks.dev/guide"
          }
        ]
      }
    },
    {
      "key": "discord",
      "icon": "🎲",
      "name": "GuildScribe Discord",
      "href": "https://discord.gg/BmdDXCrAzK",
      "dir": "",
      "card": {
        "section": "bots",
        "title": "GuildScribe for Discord",
        "text": "GuildScribe in your Discord server. Dice rolls, saves and skill checks, spell and monster lookups, and full character sheets with HP tracking, all as slash commands.",
        "href": "https://discord.gg/BmdDXCrAzK",
        "url": "Try it on Discord →",
        "pill": "BETA",
        "pillKind": "beta",
        "links": []
      }
    },
    {
      "key": "sound",
      "icon": "🔊",
      "name": "Sound Bytes",
      "href": "/soundbytes/",
      "dir": "soundbytes",
      "card": {
        "section": "bots",
        "title": "Sound Bytes",
        "text": "Tavern sound effects fired from Twitch chat with GuildScribe's <code>!sound</code>. Nat 20 fanfares, sad trombones and dragon roars, played on stream by an OBS browser source.",
        "href": "/soundbytes/",
        "url": "tavernworks.dev/soundbytes",
        "pill": "BETA",
        "pillKind": "beta",
        "links": []
      }
    },
    {
      "key": "clerk",
      "icon": "🗝️",
      "name": "Wandering Clerk",
      "href": "/wandering-clerk/",
      "dir": "wandering-clerk",
      "card": {
        "section": "bots",
        "title": "The Wandering Clerk",
        "text": "<b>Killing this off. The features are all a part of guildscribe and that is being maintained.</b> Guild receptionist for <i>GuildBreak: Hunt &amp; Hoard</i>, a hunt-and-loot RPG that runs right in Twitch chat. Enlist a character, hunt monsters, claim bounties and spend your gold at the merchant's stall.",
        "href": "/wandering-clerk/",
        "url": "tavernworks.dev/wandering-clerk",
        "pill": "DEPRECATED",
        "pillKind": "beta",
        "links": []
      }
    },
    {
      "key": "burn",
      "icon": "🥸",
      "name": "UndercoverBurn",
      "href": "https://burn.tavernworks.dev/",
      "dir": "",
      "card": {
        "section": "bots",
        "title": "UndercoverBurn",
        "text": "Slips into your Twitch chat undercover, then blows its cover with a playful roast, a quote from your StreamElements <code>!quote</code> list, or a one-liner riffing on what chat is saying. Also calls out ad breaks and welcomes chat back. Only talks while you're live.",
        "href": "",
        "url": "burn.tavernworks.dev",
        "pill": "LIVE",
        "pillKind": "live",
        "links": [
          {
            "label": "🚪 Onboarding",
            "href": "https://burn.tavernworks.dev/"
          },
          {
            "label": "📊 Dashboard",
            "href": "https://burn.tavernworks.dev/dashboard"
          }
        ]
      }
    },
    {
      "key": "journal",
      "icon": "📖",
      "name": "Journal",
      "href": "/journal/",
      "dir": "journal",
      "card": null
    },
    {
      "key": "hush",
      "icon": "🌧️",
      "name": "Hushwave",
      "href": "/hushwave/",
      "dir": "hushwave",
      "card": {
        "section": "workbench",
        "title": "Hushwave",
        "text": "An ambient sound player for Windows. Rain, fire and tavern noise to focus or chill to.",
        "href": "/hushwave/",
        "url": "tavernworks.dev/hushwave",
        "pill": "V1.0.13",
        "pillKind": "live",
        "links": []
      }
    },
    {
      "key": "localai",
      "icon": "🔮",
      "name": "Local AI",
      "href": "/local-ai/",
      "dir": "local-ai",
      "card": {
        "section": "workbench",
        "title": "Local AI",
        "text": "A self-hosted LLM on an old laptop. Ollama and Open WebUI on headless Ubuntu, CPU only, no cloud.",
        "href": "/local-ai/",
        "url": "tavernworks.dev/local-ai",
        "pill": "RUNNING",
        "pillKind": "live",
        "links": []
      }
    },
    {
      "key": "sandbox",
      "icon": "🧪",
      "name": "TwitchBotSandbox",
      "href": "/bot-sandbox/",
      "dir": "bot-sandbox",
      "card": {
        "section": "workbench",
        "title": "TwitchBotSandbox",
        "text": "Write and test Twitch chat bot commands against a simulated chat, without going live. On Windows, or right in your browser.",
        "href": "/bot-sandbox/",
        "url": "tavernworks.dev/bot-sandbox",
        "pill": "V1.9.3",
        "pillKind": "live",
        "links": []
      }
    },
    {
      "key": "assistants",
      "icon": "🧭",
      "name": "Game Assistants",
      "href": "/assistants/",
      "dir": "assistants",
      "card": {
        "section": "workbench",
        "title": "Game Assistants",
        "text": "Browser companions for the games we play: guides, references, planners and calculators. Now with <i>Stationeers</i>, <i>Oddsparks: An Automation Adventure</i>, <i>Icarus</i>, <i>How to Fish</i>, <i>Raft</i>, <i>PEAK</i> and <i>Minecraft</i> (Bedrock with Realms, and Java), and a companion for every game you link from Steam, Epic Games, GOG, the Xbox app or Windows.",
        "href": "/assistants/",
        "url": "tavernworks.dev/assistants",
        "pill": "BETA",
        "pillKind": "beta",
        "links": []
      }
    },
    {
      "key": "station",
      "icon": "🛰️",
      "name": "Stationeers Assistant",
      "href": "/assistants/stationeers/",
      "dir": "assistants/stationeers",
      "card": null
    },
    {
      "key": "sparks",
      "icon": "✨",
      "name": "Oddsparks Assistant",
      "href": "/assistants/oddsparks/",
      "dir": "assistants/oddsparks",
      "card": null
    },
    {
      "key": "icarus",
      "icon": "🪂",
      "name": "Icarus Assistant",
      "href": "/assistants/icarus/",
      "dir": "assistants/icarus",
      "card": null
    },
    {
      "key": "fish",
      "icon": "🎣",
      "name": "How to Fish Assistant",
      "href": "/assistants/how-to-fish/",
      "dir": "assistants/how-to-fish",
      "card": null
    },
    {
      "key": "raft",
      "icon": "🛶",
      "name": "Raft Assistant",
      "href": "/assistants/raft/",
      "dir": "assistants/raft",
      "card": null
    },
    {
      "key": "peak",
      "icon": "🏔️",
      "name": "PEAK Assistant",
      "href": "/assistants/peak/",
      "dir": "assistants/peak",
      "card": null
    },
    {
      "key": "minecraft",
      "icon": "⛏️",
      "name": "Minecraft Assistants",
      "href": "/assistants/minecraft/",
      "dir": "assistants/minecraft",
      "card": null
    },
    {
      "key": "tips",
      "icon": "🪙",
      "name": "Tip jar & Company",
      "href": "#support",
      "dir": "tips",
      "card": null
    }
  ],
  "changes": [
    ["home","2026-10-05","The tavern opens: GuildScribe live, Hushwave on GitHub","/"],
    ["guildscribe","2026-10-06","Moves in at guildscribe.tavernworks.dev","https://guildscribe.tavernworks.dev/"],
    ["localai","2026-10-06","Local AI gets its own page","/local-ai/"],
    ["localai","2026-10-06","Local AI page describes the real setup","/local-ai/"],
    ["sandbox","2026-10-06","TwitchBotSandbox page and Workbench card","/bot-sandbox/"],
    ["tips","2026-10-06","Tip jar and Discord","#support"],
    ["guildscribe","2026-10-06","Public channel list, with opt-out","https://guildscribe.tavernworks.dev/"],
    ["tips","2026-10-06","The Company: live list of GuildScribe channels","#guilds"],
    ["tips","2026-10-06","Company list hides GuildScribeBot","#guilds"],
    ["home","2026-10-06","Example GuildScribe chat under the header","#chatfeed"],
    ["home","2026-10-06","Header chat: duels, autohunt, fading messages","#chatfeed"],
    ["home","2026-10-06","Header chat covers every GuildScribe feature","#chatfeed"],
    ["localai","2026-10-06","Browser chat over Tailscale","/local-ai/chat/"],
    ["localai","2026-10-06","Setup steps, troubleshooting, clearer chat errors","/local-ai/"],
    ["localai","2026-10-06","Chat never leaves a reply blank","/local-ai/chat/"],
    ["localai","2026-10-06","Chat gets Stop and Resend","/local-ai/chat/"],
    ["localai","2026-10-06","Optional Claude Code models via a private bridge","/local-ai/chat/"],
    ["localai","2026-10-06","Move chat settings between devices by link or QR","/local-ai/chat/"],
    ["hush","2026-10-06","Hushwave page with a suggestion box","/hushwave/"],
    ["hush","2026-10-06","Suggestions stored on the laptop, one admin login","/hushwave/"],
    ["hush","2026-10-06","Suggestion box points at the laptop's Funnel address","/hushwave/"],
    ["hush","2026-10-06","Suggestion box defaults to port 8790","/hushwave/"],
    ["hush","2026-10-06","Friendly message when the server is away","/hushwave/"],
    ["hush","2026-10-06","Inbox link to the suggestions","/hushwave/"],
    ["tips","2026-10-06","Twitch subs, Bits and more tip platforms","#support"],
    ["tips","2026-10-06","Locked /tips/ page to set the tip links","/tips/"],
    ["tips","2026-10-06","Edit links button","#support"],
    ["tips","2026-10-06","Working Cash App links from a cashtag","#support"],
    ["burn","2026-10-06","UndercoverBurn card","https://burn.tavernworks.dev/"],
    ["burn","2026-10-06","Card links to the invite page","https://burn.tavernworks.dev/"],
    ["burn","2026-10-06","Moves in at burn.tavernworks.dev","https://burn.tavernworks.dev/"],
    ["burn","2026-10-06","Cloudflare Worker for burn.tavernworks.dev","https://burn.tavernworks.dev/"],
    ["clerk","2026-10-06","The Wandering Clerk project page","/wandering-clerk/"],
    ["guildscribe","2026-10-06","Auto-ban catches two spam bots at once","https://guildscribe.tavernworks.dev/"],
    ["clerk","2026-10-06","Command groups as folders","/wandering-clerk/"],
    ["clerk","2026-10-06","Dashboard and Back Room links","/wandering-clerk/"],
    ["clerk","2026-10-06","The val served at hunt.tavernworks.dev","/wandering-clerk/"],
    ["clerk","2026-10-06","Dashboard opens the feature toggles","/wandering-clerk/"],
    ["clerk","2026-10-06","Back Room opens the ledger","/wandering-clerk/"],
    ["clerk","2026-10-06","Quieter side-by-side links","/wandering-clerk/"],
    ["clerk","2026-10-06","Onboarding replaces the Back Room link","/wandering-clerk/"],
    ["clerk","2026-10-06","Onboarding page at hunt.tavernworks.dev/onboard","https://hunt.tavernworks.dev/onboard"],
    ["clerk","2026-10-06","hunt Worker deployed from GitHub Actions","/wandering-clerk/"],
    ["discord","2026-10-06","GuildScribe for Discord joins The Bots (beta)","https://discord.gg/BmdDXCrAzK"],
    ["clerk","2026-10-06","Dashboard links straight to the val","/wandering-clerk/"],
    ["journal","2026-10-06","Adventurer's Journal: notes, attachments, ComfyUI art","/journal/"],
    ["sound","2026-10-06","Sound Bytes: chat-fired sound effects","/soundbytes/"],
    ["home","2026-10-06","The Path So Far","#path"],
    ["sound","2026-10-06","Suggests !kaboom instead of !fireball","/soundbytes/"],
    ["guildscribe","2026-10-06","Sound Bytes: !sound and a stream overlay","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-06","Sound Bytes built into all three scenes","https://guildscribe.tavernworks.dev/"],
    ["sound","2026-10-06","\"fireball\" anywhere in chat plays the sound","/soundbytes/"],
    ["guildscribe","2026-10-06","Sound Bytes pop up in the Dungeon Gate","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-06","Overlays page starts every overlay minimized","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-06","Saving Throws tally in the brb and chat scenes","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-06","Now playing moves under the Battle Tracker","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-06","Starting soon and Ending soon scenes","https://guildscribe.tavernworks.dev/"],
    ["sound","2026-10-06","Matches GuildScribe's built-in !sound","/soundbytes/"],
    ["clerk","2026-10-06","The Wandering Clerk goes live","/wandering-clerk/"],
    ["guildscribe","2026-10-06","Public Gear page","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-06","!gear list links the Gear page from chat","https://guildscribe.tavernworks.dev/"],
    ["burn","2026-10-07","burn Worker deployed from GitHub Actions","https://burn.tavernworks.dev/"],
    ["burn","2026-10-07","Deploy moves to the UndercoverBurn repo","https://burn.tavernworks.dev/"],
    ["clerk","2026-10-07","hunt Worker deploy retired","/wandering-clerk/"],
    ["guildscribe","2026-10-07","Connection health on the dashboard","https://guildscribe.tavernworks.dev/"],
    ["burn","2026-10-07","Admin dashboard: feature toggles and data purge","https://burn.tavernworks.dev/"],
    ["burn","2026-10-07","Removed channels stop being recorded","https://burn.tavernworks.dev/"],
    ["burn","2026-10-07","Onboarding and Dashboard links","https://burn.tavernworks.dev/"],
    ["burn","2026-10-07","Dashboard signs in with Twitch","https://burn.tavernworks.dev/"],
    ["burn","2026-10-07","Card expands to show its links","https://burn.tavernworks.dev/"],
    ["guildscribe","2026-10-07","!save: a d20 saving throw against the bot","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","!save @user calls for another chatter's save","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","No gold earned while the stream is offline","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Dashboard starts collapsed, Quick setup folds up","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Ad alerts catch more ad breaks","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Ad alerts say when the break ends","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Two replies per person per minute","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Classic duels skip the reply limit","https://guildscribe.tavernworks.dev/"],
    ["localai","2026-10-07","Attach images and files in chat","/local-ai/chat/"],
    ["localai","2026-10-07","Attach zips, tarballs and folders","/local-ai/chat/"],
    ["sandbox","2026-10-07","Live in-browser sandbox","/bot-sandbox/app/"],
    ["sandbox","2026-10-07","Sign in to keep projects, with backups","/bot-sandbox/app/"],
    ["sandbox","2026-10-07","Sign in with Google, one account each","/bot-sandbox/app/"],
    ["sandbox","2026-10-07","Google sign-in switched on","/bot-sandbox/app/"],
    ["home","2026-10-07","Privacy policy and terms","/privacy/"],
    ["sandbox","2026-10-07","Deno mode runs in the browser","/bot-sandbox/app/"],
    ["sandbox","2026-10-07","Env vars save on older servers too","/bot-sandbox/app/"],
    ["home","2026-10-07","The path becomes one lane per project","#path"],
    ["sandbox","2026-10-07","Resizable log under the editor","/bot-sandbox/app/"],
    ["home","2026-10-07","The path turns between projects","#path"],
    ["sandbox","2026-10-07","Deno mode: node:async_hooks, clearer load errors","/bot-sandbox/app/"],
    ["sandbox","2026-10-07","Deno mode names the import that failed","/bot-sandbox/app/"],
    ["sandbox","2026-10-07","Val Town's std/openai works in Deno mode","/bot-sandbox/app/"],
    ["sandbox","2026-10-07","Saved env vars reach running code","/bot-sandbox/app/"],
    ["tips","2026-10-07","Sign in with Google to edit the tip links","/tips/"],
    ["hush","2026-10-07","Sign in with Google to open the suggestion box","/hushwave/suggestions/"],
    ["home","2026-10-07","Privacy policy and terms cover Google sign-in","/privacy/"],
    ["guildscribe","2026-10-07","Reconnect advice only when it would help","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Keeps EventSub subscriptions after a revocation","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Card expands to Homepage and Guide links","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","Reply limit lifted, command cooldown stays","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-07","!raid becomes !rally","https://guildscribe.tavernworks.dev/"],
    ["journal","2026-10-08","Syncs across devices with Google Drive","/journal/"],
    ["journal","2026-10-08","Character sheet: portrait, stats, gold and inventory","/journal/"],
    ["journal","2026-10-08","Dice roller, with or without modifiers","/journal/"],
    ["guildscribe","2026-10-08","Ability saves move to !save <ability>","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Plain !save rolls count on the saves tally","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","!spell lookups suggest the matching !save","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","!save <stat> rolls against the raid boss","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Gear page sorts by Carried by","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Pokéball advisor for PokemonCommunityGame spawns","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Pokéball advisor: per-channel ball list and mod page","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Pokéball advisor answers to !ball","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Pokéball advisor switch on the dashboard","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Balls list their catch chance, one shared ball list","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Heavy Ball and Quick Ball bonuses scale","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-08","Runs on the Yoga laptop instead of Val Town","https://guildscribe.tavernworks.dev/"],
    ["burn","2026-10-08","Runs on the Yoga laptop instead of Val Town","https://burn.tavernworks.dev/"],
    ["home","2026-10-08","Bot host kit: the Twitch bots on our own laptop","https://github.com/sheastolp/tavernworks/tree/main/bot-host"],
    ["home","2026-10-08","Privacy policy says where each bot runs","/privacy/"],
    ["burn","2026-10-09","Friendlier AI commentary that sticks to what chat said","https://burn.tavernworks.dev/"],
    ["guildscribe","2026-10-09","Battle math uses each character's own modifiers","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","Class abilities and racial traits in every fight","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","!abilities shows a character's combat kit","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","Autohunt reports list every bout of the trip","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","Duel d20 rolls count toward !rollcall","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","Attacking or robbing the peddler always fails","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","!bribe: it never works, and it costs you","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","Answers Twitch right away, even in a burst of commands","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","Reply pages keep each viewer's last 15 replies","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","EventSub admin page moves every channel to the laptop","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-09","The peddler's timed visits work again on the laptop","https://guildscribe.tavernworks.dev/"],
    ["hush","2026-10-09","Friendlier player: seek bar, shortcuts, media keys (v1.0.11)","/hushwave/"],
    ["hush","2026-10-09","Prompt studio layers up to five sounds in seamless loops (v1.0.12)","/hushwave/"],
    ["hush","2026-10-09","No more silent playback from a missing device (v1.0.13)","/hushwave/"],
    ["hush","2026-10-09","Setup guide in the README","https://github.com/sheastolp/Hushwave#setup-guide"],
    ["hush","2026-10-09","Hushwave page catches up to v1.0.13","/hushwave/"],
    ["hush","2026-10-09","Step-by-step guide to getting the installer","/hushwave/#install"],
    ["hush","2026-10-09","Install guide: fork the repo and build your own installer","/hushwave/#install"],
    ["hush","2026-10-09","More realistic fire and water sounds","/hushwave/"],
    ["burn","2026-10-10","!status is VALORANT-only, with a default Riot ID","https://burn.tavernworks.dev/"],
    ["guildscribe","2026-10-10","Autohunt reports: one message per channel with every hunter's W/L","https://guildscribe.tavernworks.dev/"],
    ["burn","2026-10-10","Ad-start notice posts even after an early warning","https://burn.tavernworks.dev/"],
    ["guildscribe","2026-10-10","The Division 2 companion: builds, loot, missions and lookups","https://guildscribe.tavernworks.dev/"],
    ["guildscribe","2026-10-10","!rob @GuildScribeBot fines the robber into the swear jar","https://guildscribe.tavernworks.dev/"],
    ["burn","2026-10-10","Smarter AI: sharper commentary and roasts from what you said","https://burn.tavernworks.dev/"],
    ["station","2026-10-10","Stationeers Assistant: guides, IC10 tutorial, linter and emulator","/assistants/stationeers/"],
    ["home","2026-10-10","The Workshop: edit projects, the path and every project's files in the browser","/workshop/"],
    ["station","2026-10-10","created web implemented version","/assistants/stationeers/"],
    ["home","2026-10-10","The Guild: barkeep and guild list share one section","#guilds"],
    ["tips","2026-10-10","Crypto addresses fold into tap-to-copy chips","#support"],
    ["station","2026-10-10","Moves into the Game Assistants folder","/assistants/stationeers/"],
    ["sparks","2026-10-10","Oddsparks Assistant: Spark guide, logistics, quests, planner and calculators","/assistants/oddsparks/"],
    ["assistants","2026-10-10","Game Assistants: one card for every game companion","/assistants/"],
    ["assistants","2026-10-10","Link Steam, Epic Games and GOG: a companion app for every installed game","/assistants/library/"],
    ["minecraft","2026-10-10","Minecraft Assistants: Bedrock Edition with Realms, and Java Edition","/assistants/minecraft/"],
    ["minecraft","2026-10-10","Minecraft Assistants: auto farm guides, a tutorial finder, mobs, food and six new guides","/assistants/minecraft/"],
    ["minecraft","2026-10-10","Minecraft Assistants: crafting guide with recipe grids and a materials planner","/assistants/minecraft/java/#crafting"],
    ["icarus","2026-10-10","Icarus Assistant: survival guides, creature mechanics, tech tiers, maps and a prospect timer","/assistants/icarus/"],
    ["minecraft","2026-10-10","Minecraft Assistants: tap a mob for its health, attack, spawning and mechanics","/assistants/minecraft/java/#mobs"],
    ["fish","2026-10-10","How to Fish Assistant: island walkthrough, boss summons, bait, a money planner and a sales log","/assistants/how-to-fish/"],
    ["raft","2026-10-10","Raft Assistant: story islands, shark defence, creature mechanics and fishing","/assistants/raft/"],
    ["peak","2026-10-10","PEAK Assistant: biomes, afflictions, items, Ascents and a run log","/assistants/peak/"],
    ["assistants","2026-10-10","Link the Xbox app, Microsoft Store and installed Windows apps and games","/assistants/library/"]
  ]
};
