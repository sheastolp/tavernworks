// The tip jar's platforms, shared by the homepage and the /tips/ admin page.
// The links themselves are set on /tips/ and kept on the suggestion box
// server; `url` here is only the fallback when that server can't be reached.
// An entry with no link stays hidden. An optional `fix` turns what was
// typed into a working link.
window.TIPS = [
  { id: "twitch-sub", icon: "💜", name: "Twitch sub", sub: "Sub, gift one, or use Prime", url: "https://www.twitch.tv/subs/stonedsheamus", hint: "https://www.twitch.tv/subs/<channel>" },
  { id: "twitch-bits", icon: "💎", name: "Twitch Bits", sub: "Cheer in chat on stream", url: "https://twitch.tv/stonedsheamus", hint: "https://twitch.tv/<channel>" },
  { id: "kofi", icon: "☕", name: "Ko-fi", sub: "One-off tip, no account needed", url: "", hint: "https://ko-fi.com/<name>" },
  { id: "bmac", icon: "🍺", name: "Buy Me a Coffee", sub: "Buy the barkeep a round", url: "", hint: "https://buymeacoffee.com/<name>" },
  { id: "patreon", icon: "🛡️", name: "Patreon", sub: "Monthly support, with perks", url: "", hint: "https://patreon.com/<name>" },
  { id: "github-sponsors", icon: "🐙", name: "GitHub Sponsors", sub: "Back the bots and tools", url: "", hint: "https://github.com/sponsors/<name>" },
  { id: "stream-tip", icon: "🔔", name: "Stream tip", sub: "Tip with an on-stream alert", url: "", hint: "Streamlabs or StreamElements tip page" },
  { id: "paypal", icon: "🅿️", name: "PayPal", sub: "Send via PayPal", url: "", hint: "https://paypal.me/<name>" },
  { id: "cashapp", icon: "💵", name: "Cash App", sub: "Send via Cash App", url: "", hint: "$cashtag or cash.app link",
    // Cash App profiles only open as https://cash.app/$tag, so accept the
    // tag on its own or a link missing the $, and build the right link.
    fix: (v) => { const tag = v.replace(/^(https?:\/\/)?(www\.)?cash\.app\/?/i, "").replace(/^[$£]+/, "").split(/[/?#\s]/)[0]; return tag ? "https://cash.app/$" + tag : ""; } },
  { id: "venmo", icon: "💸", name: "Venmo", sub: "Send via Venmo", url: "", hint: "https://venmo.com/u/<name>" },
  { id: "wishlist", icon: "🎁", name: "Wishlist", sub: "Gift something from the list", url: "", hint: "Throne or Amazon wishlist link" },
];
window.fixTipUrl = (t, v) => { v = String(v || "").trim(); return v && t.fix ? t.fix(v) : v; };
