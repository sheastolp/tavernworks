// Tavernworks launcher links: reads what Steam, the Epic Games Launcher,
// GOG Galaxy, the Xbox app / Microsoft Store and Windows itself have
// installed, and keeps the list in this browser so every installed game (and
// app) gets a companion. Nothing here talks to a server.
//
// Sources, all read locally:
//   Steam    steamapps/appmanifest_<appid>.acf (+ libraryfolders.vdf for other libraries)
//   Epic     ProgramData/Epic/EpicGamesLauncher/Data/Manifests/*.item
//   GOG      <game folder>/goggame-<id>.info, or the registry via the scan script
//   Xbox     XboxGames/<game>/Content/MicrosoftGame.config, or Get-AppxPackage via the scan script
//   Windows  the registry's Uninstall keys, via the scan script only
(function () {
  const LIB_KEY = 'tw.library';
  const COMP_KEY = 'tw.companion.';

  const LAUNCHERS = {
    steam: { name: 'Steam', icon: '🚂' },
    epic: { name: 'Epic Games', icon: '🛡️' },
    gog: { name: 'GOG Galaxy', icon: '🌌' },
    xbox: { name: 'Xbox & Microsoft Store', icon: '🎮' },
    win: { name: 'Windows apps', icon: '🪟' },
  };

  // Games with a hand-built assistant; everything else gets the generated one.
  const DEDICATED = [
    { re: /^stationeers/, href: '/assistants/stationeers/', icon: '🛰️' },
    { re: /^oddsparks/, href: '/assistants/oddsparks/', icon: '✨' },
    { re: /^icarus/, href: '/assistants/icarus/', icon: '🪂' },
    { re: /^raft$/, href: '/assistants/raft/', icon: '🛶' },
    { re: /^peak$/, href: '/assistants/peak/', icon: '🏔️' },
    { re: /^howtofish/, href: '/assistants/how-to-fish/', icon: '🎣' },
    { re: /^minecraft(launcher|forwindows|uwp|javaedition|bedrock(edition)?)?$/, href: '/assistants/minecraft/', icon: '⛏️' },
  ];

  // Steam tools and runtimes that show up as apps but aren't games.
  const STEAM_SKIP_IDS = new Set(['228980', '1070560', '1391110', '1628350', '1493710', '2180100', '250820', '1826330']);
  const STEAM_SKIP_NAME = /^(Proton\b|Steam Linux Runtime|Steamworks Common|SteamVR\b)/i;

  // Windows Uninstall entries that are plumbing rather than something you'd open.
  const WIN_SKIP_NAME = /redistributable|runtime|\bsdk\b|driver|update for|hotfix|\(kb\d+\)|vcredist|directx|\.net (framework|desktop|host|core)|webview2|visual c\+\+|edge update|bonjour|physx|vulkan|easy ?anti-?cheat|battleye|service pack|language pack|prerequisite|^microsoft (update|xna)|windows (software development|driver|assessment)/i;
  // Uninstall keys the launchers create for their own games: covered by those launchers.
  const WIN_SKIP_ID = /^(Steam App \d+|\d+_is1|\{?[0-9a-f-]+\}?_is1_GOG)$/i;
  // Hints that a Windows program is a game rather than an app.
  const GAME_PATH = /[\\/](xboxgames|games|riot games|rockstar games|battle\.net|blizzard|ea games|origin games|itch[\\/]apps|amazon games|ubisoft game launcher[\\/]games)([\\/]|$)/i;
  const GAME_PUB = /^(riot games|blizzard|ubisoft|electronic arts|rockstar|mojang|bethesda|square enix|bandai namco|sega\b|capcom|cd projekt|paradox|devolver|activision|epic games, inc\. ?\(fortnite\)|valve|landfall|aggro crab|redbeet|dazed games|rocketwerkz|surgent)/i;

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // "Microsoft.MinecraftUWP" -> "Minecraft UWP"; for packages without a readable display name.
  const prettyPkg = s => String(s || '').replace(/^[^.]+\./, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[._]+/g, ' ').trim();

  /* ---------- parsers ---------- */

  // Valve KeyValues (VDF/ACF). Keys come back lowercased.
  function parseVDF(text) {
    const toks = [];
    const re = /"((?:\\.|[^"\\])*)"|([{}])|\/\/[^\n]*/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2]) toks.push(m[2]);
      else if (m[1] !== undefined) toks.push({ s: m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)) });
    }
    let i = 0;
    function obj() {
      const o = {};
      while (i < toks.length) {
        const k = toks[i++];
        if (k === '}') return o;
        if (typeof k !== 'object') continue;
        const v = toks[i++];
        if (v === '{') o[k.s.toLowerCase()] = obj();
        else if (v && typeof v === 'object') o[k.s.toLowerCase()] = v.s;
      }
      return o;
    }
    return obj();
  }

  function fromACF(text, libPath) {
    const st = parseVDF(text).appstate;
    if (!st || !st.appid || !st.name) return null;
    if (STEAM_SKIP_IDS.has(st.appid) || STEAM_SKIP_NAME.test(st.name)) return null;
    const p = libPath && st.installdir ? libPath.replace(/[\\/]+$/, '') + '\\steamapps\\common\\' + st.installdir : (st.installdir || '');
    return { l: 'steam', id: st.appid, n: st.name, p };
  }

  // Library folder paths listed in libraryfolders.vdf.
  function steamLibraries(text) {
    const lf = parseVDF(text).libraryfolders || {};
    return Object.values(lf).map(v => (typeof v === 'object' ? v.path : v)).filter(Boolean);
  }

  function fromEpicItem(text) {
    let j;
    try { j = JSON.parse(text); } catch { return null; }
    if (!j || !j.AppName || !j.DisplayName) return null;
    const cats = (j.AppCategories || []).map(String);
    if (cats.length && !cats.includes('games')) return null;
    if (j.bIsIncompleteInstall) return null;
    return { l: 'epic', id: j.AppName, n: j.DisplayName, p: j.InstallLocation || '', ns: j.CatalogNamespace || '', c: j.CatalogItemId || '' };
  }

  function fromGogInfo(text, folder) {
    let j;
    try { j = JSON.parse(text); } catch { return null; }
    if (!j || !j.gameId || !j.name) return null;
    // DLC info files point at their base game through rootGameId.
    if (j.rootGameId && String(j.rootGameId) !== String(j.gameId)) return null;
    return { l: 'gog', id: String(j.gameId), n: j.name, p: folder || '' };
  }

  // MicrosoftGame.config from an Xbox app (Game Pass / Microsoft Store) game folder.
  function fromGameConfig(text, folder) {
    const attr = (tag, a) => { const m = new RegExp('<' + tag + '\\b[^>]*\\b' + a + '="([^"]*)"', 'i').exec(text); return m ? m[1] : ''; };
    const id = attr('Identity', 'Name');
    if (!id) return null;
    const sid = (/<StoreId>\s*([^<\s]+)\s*<\/StoreId>/i.exec(text) || [])[1] || '';
    let n = attr('ShellVisuals', 'DefaultDisplayName');
    if (!n || /^ms-resource:/i.test(n)) n = folder || prettyPkg(id);
    return { l: 'xbox', id, n, p: '', sid, t: 'game' };
  }

  function winKind(g) {
    return GAME_PATH.test(g.p || '') || GAME_PATH.test(g.ex || '') || GAME_PUB.test(g.pub || '') || dedicated(g) ? 'game' : 'app';
  }

  // Output of the Windows scan script: {"tavernworks":1,"games":[{l,id,n,p,...}]}
  function fromScan(text) {
    const j = JSON.parse(text.trim().replace(/^\uFEFF/, ''));
    const list = Array.isArray(j) ? j : (j.games || []);
    const out = [], wins = [];
    for (const g of [].concat(list)) {
      if (!g || !LAUNCHERS[g.l] || !g.id) continue;
      if (g.l === 'xbox' && (!g.n || /^ms-resource:/i.test(g.n))) g.n = prettyPkg(g.pk || g.id);
      if (!g.n) continue;
      const game = { l: g.l, id: String(g.id), n: String(g.n).trim(), p: g.p || '' };
      if (g.l === 'steam' && (STEAM_SKIP_IDS.has(game.id) || STEAM_SKIP_NAME.test(game.n))) continue;
      if (g.l === 'epic') {
        if (g.cat && !String(g.cat).split(',').includes('games')) continue;
        game.ns = g.ns || ''; game.c = g.c || '';
      }
      if (g.l === 'xbox') {
        game.sid = g.sid || ''; game.pfn = g.pfn || '';
        game.t = g.t === 'game' || dedicated(game) ? 'game' : 'app';
      }
      if (g.l === 'win') {
        if (WIN_SKIP_ID.test(game.id) || WIN_SKIP_NAME.test(game.n)) continue;
        game.t = winKind({ n: game.n, p: game.p, ex: g.ex, pub: g.pub });
        if (g.pub) game.pub = String(g.pub);
        wins.push(game);
        continue;
      }
      out.push(game);
    }
    // Windows lists most launcher games again under Uninstall; keep the launcher's copy.
    const seen = new Set(out.map(g => norm(g.n)));
    for (const g of wins) {
      if (seen.has(norm(g.n))) continue;
      seen.add(norm(g.n));
      out.push(g);
    }
    return out;
  }

  /* ---------- reading files and folders ---------- */

  // Files from <input type=file multiple>: any mix of .acf, .item, .info, .vdf.
  async function readFiles(files) {
    const games = [], libraries = [];
    for (const f of files) {
      const name = f.name.toLowerCase();
      const text = await f.text();
      let g = null;
      if (/^appmanifest_\d+\.acf$/.test(name)) g = fromACF(text);
      else if (name.endsWith('.item')) g = fromEpicItem(text);
      else if (/^goggame-\d+\.info$/.test(name)) g = fromGogInfo(text);
      else if (name === 'microsoftgame.config') g = fromGameConfig(text);
      else if (name === 'libraryfolders.vdf') libraries.push(...steamLibraries(text));
      if (g) games.push(g);
    }
    return { games, libraries };
  }

  async function child(dir, name, kind) {
    try { return kind === 'file' ? await dir.getFileHandle(name) : await dir.getDirectoryHandle(name); } catch { return null; }
  }
  async function readText(fh) { return (await fh.getFile()).text(); }

  // Folder from showDirectoryPicker(). Accepts the launcher's own folder or
  // any folder above the manifests, and walks down to them.
  async function readFolder(launcher, dir) {
    const games = [], libraries = [];
    if (launcher === 'steam') {
      let apps = dir;
      const sa = await child(dir, 'steamapps');
      if (sa) apps = sa;
      for await (const [name, h] of apps.entries()) {
        if (h.kind !== 'file') continue;
        if (/^appmanifest_\d+\.acf$/i.test(name)) { const g = fromACF(await readText(h)); if (g) games.push(g); }
        else if (name.toLowerCase() === 'libraryfolders.vdf') libraries.push(...steamLibraries(await readText(h)));
      }
    } else if (launcher === 'epic') {
      let d = dir;
      for (const step of ['EpicGamesLauncher', 'Data', 'Manifests']) { const c = await child(d, step); if (c) d = c; }
      for await (const [name, h] of d.entries()) {
        if (h.kind === 'file' && name.toLowerCase().endsWith('.item')) { const g = fromEpicItem(await readText(h)); if (g) games.push(g); }
      }
    } else if (launcher === 'gog') {
      // Either one game's folder or the folder that holds the game folders.
      const scan = async (d, folder) => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'file' && /^goggame-\d+\.info$/i.test(name)) { const g = fromGogInfo(await readText(h), folder); if (g) games.push(g); }
        }
      };
      await scan(dir, dir.name);
      if (!games.length) {
        for await (const [name, h] of dir.entries()) if (h.kind === 'directory') await scan(h, name);
      }
    } else if (launcher === 'xbox') {
      // XboxGames, one game's folder, or its Content folder.
      const config = async (d, folder) => {
        const c = (await child(d, 'Content')) || d;
        const fh = await child(c, 'MicrosoftGame.config', 'file');
        if (fh) { const g = fromGameConfig(await readText(fh), folder); if (g) games.push(g); }
      };
      await config(dir, dir.name === 'Content' ? '' : dir.name);
      if (!games.length) {
        for await (const [name, h] of dir.entries()) if (h.kind === 'directory') await config(h, name);
      }
    }
    return { games, libraries };
  }

  /* ---------- the library ---------- */

  const keyOf = g => g.l + '-' + g.id;

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
      if (v && Array.isArray(v.games)) return { games: v.games, linked: v.linked || {} };
    } catch {}
    return { games: [], linked: {} };
  }
  function save(lib) {
    try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch {}
    return lib;
  }

  // Adds or refreshes games. With replace, each launcher that appears in
  // `launchers` loses the games it no longer reports (a full scan).
  function merge(found, opts = {}) {
    const lib = load();
    const now = new Date().toISOString();
    const replace = new Set(opts.replace || []);
    const byKey = new Map(lib.games.filter(g => !replace.has(g.l)).map(g => [g.key, g]));
    const old = new Map(lib.games.map(g => [g.key, g]));
    let added = 0;
    for (const f of found) {
      const key = keyOf(f);
      const prev = byKey.get(key) || old.get(key);
      if (!prev) added++;
      byKey.set(key, Object.assign({}, prev, f, { key, added: prev ? prev.added : now }));
    }
    for (const l of new Set(found.map(g => g.l).concat([...replace]))) lib.linked[l] = now;
    lib.games = [...byKey.values()].sort((a, b) => a.n.localeCompare(b.n));
    save(lib);
    return { lib, added };
  }

  function unlink(launcher) {
    const lib = load();
    lib.games = lib.games.filter(g => g.l !== launcher);
    delete lib.linked[launcher];
    return save(lib);
  }

  function remove(key) {
    const lib = load();
    lib.games = lib.games.filter(g => g.key !== key);
    return save(lib);
  }

  function find(key) { return load().games.find(g => g.key === key) || null; }

  // Everything from the game launchers is a game; Xbox and Windows entries carry t.
  const isGame = g => (g.t || 'game') === 'game';

  /* ---------- per-game links ---------- */

  function dedicated(g) {
    const n = norm(g.n);
    return DEDICATED.find(d => d.re.test(n)) || null;
  }

  function companionHref(g) {
    const d = dedicated(g);
    return d ? d.href : '/assistants/companion/?game=' + encodeURIComponent(g.key);
  }

  function launchURI(g) {
    if (g.l === 'steam') return 'steam://rungameid/' + g.id;
    if (g.l === 'epic') {
      const app = g.ns && g.c ? [g.ns, g.c, g.id].map(encodeURIComponent).join('%3A') : encodeURIComponent(g.id);
      return 'com.epicgames.launcher://apps/' + app + '?action=launch&silent=true';
    }
    if (g.l === 'gog') return 'goggalaxy://openGameView/' + g.id;
    // The Store page of an installed title has its Play / Open button.
    if (g.l === 'xbox') {
      if (g.sid) return 'ms-windows-store://pdp/?productid=' + encodeURIComponent(g.sid);
      if (g.pfn) return 'ms-windows-store://pdp/?PFN=' + encodeURIComponent(g.pfn);
      return 'ms-windows-store://search/?query=' + encodeURIComponent(g.n);
    }
    // Browsers can't start a Windows program, so these have no launch link.
    return '';
  }

  function art(g) {
    return g.l === 'steam' ? 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + g.id + '/header.jpg' : '';
  }

  function links(g) {
    const q = encodeURIComponent(g.n);
    const out = [];
    if (g.l === 'steam') {
      out.push(['Store page', 'https://store.steampowered.com/app/' + g.id + '/']);
      out.push(['Community guides', 'https://steamcommunity.com/app/' + g.id + '/guides/']);
      out.push(['Discussions', 'https://steamcommunity.com/app/' + g.id + '/discussions/']);
      out.push(['News', 'https://store.steampowered.com/news/app/' + g.id]);
      out.push(['PCGamingWiki', 'https://www.pcgamingwiki.com/api/appid.php?appid=' + g.id]);
      out.push(['SteamDB', 'https://steamdb.info/app/' + g.id + '/']);
      out.push(['ProtonDB', 'https://www.protondb.com/app/' + g.id]);
    } else {
      if (g.l === 'epic') out.push(['Epic Games Store', 'https://store.epicgames.com/en-US/browse?q=' + q]);
      if (g.l === 'gog') out.push(['GOG store', 'https://www.gog.com/en/games?query=' + q]);
      if (g.l === 'xbox') out.push(['Microsoft Store', g.sid ? 'https://apps.microsoft.com/detail/' + encodeURIComponent(g.sid) : 'https://apps.microsoft.com/search?query=' + q]);
      if (!isGame(g)) {
        out.push(['How-to videos', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(g.n + ' tutorial')]);
        out.push(['Tips on Reddit', 'https://www.reddit.com/search/?q=' + q]);
        out.push(['Alternatives', 'https://alternativeto.net/browse/search/?q=' + q]);
        return out;
      }
      out.push(['PCGamingWiki', 'https://www.pcgamingwiki.com/w/index.php?search=' + q]);
    }
    out.push(['Fan wikis', 'https://community.fandom.com/wiki/Special:Search?scope=cross-wiki&query=' + q]);
    out.push(['HowLongToBeat', 'https://howlongtobeat.com/?q=' + q]);
    out.push(['Guides on YouTube', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(g.n + ' guide')]);
    out.push(['Reddit', 'https://www.reddit.com/search/?q=' + q]);
    return out;
  }

  /* ---------- companion data ---------- */

  function companion(key) {
    try {
      const v = JSON.parse(localStorage.getItem(COMP_KEY + key) || 'null');
      if (v) return Object.assign({ goals: [], notes: '', sessions: [], running: null }, v);
    } catch {}
    return { goals: [], notes: '', sessions: [], running: null };
  }
  function saveCompanion(key, data) {
    try { localStorage.setItem(COMP_KEY + key, JSON.stringify(data)); } catch {}
  }

  /* ---------- Windows scan script ---------- */

  const SCAN_SCRIPT = String.raw`$g = @()
# Steam: every library in libraryfolders.vdf
$s = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
if ($s) {
  $libs = @($s)
  $v = Join-Path $s 'steamapps\libraryfolders.vdf'
  if (Test-Path $v) { $libs += (Select-String -Path $v -Pattern '"path"\s+"(.+?)"' -AllMatches).Matches | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' } }
  foreach ($l in ($libs | Select-Object -Unique)) {
    Get-ChildItem (Join-Path $l 'steamapps\appmanifest_*.acf') -ErrorAction SilentlyContinue | ForEach-Object {
      $t = Get-Content $_.FullName -Raw -Encoding UTF8
      $d = [regex]::Match($t, '"installdir"\s+"(.+?)"').Groups[1].Value
      $g += [pscustomobject]@{ l = 'steam'; id = [regex]::Match($t, '"appid"\s+"(\d+)"').Groups[1].Value; n = [regex]::Match($t, '"name"\s+"(.+?)"').Groups[1].Value; p = (Join-Path $l "steamapps\common\$d") }
    }
  }
}
# Epic Games Launcher
Get-ChildItem "$env:ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item" -ErrorAction SilentlyContinue | ForEach-Object {
  $j = Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $j.bIsIncompleteInstall) { $g += [pscustomobject]@{ l = 'epic'; id = $j.AppName; n = $j.DisplayName; p = $j.InstallLocation; ns = $j.CatalogNamespace; c = $j.CatalogItemId; cat = ($j.AppCategories -join ',') } }
}
# GOG Galaxy
Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\GOG.com\Games' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if ($p.gameName -and -not $p.dependsOn) { $g += [pscustomobject]@{ l = 'gog'; id = $p.gameID; n = $p.gameName; p = $p.path } }
}
# Xbox app and Microsoft Store (games carry a MicrosoftGame.config)
Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and $_.SignatureKind -eq 'Store' -and $_.InstallLocation } | ForEach-Object {
  $m = $null; try { $m = Get-AppxPackageManifest $_ -ErrorAction Stop } catch {}
  if ($m -and -not $m.Package.Applications) { return }
  $n = if ($m) { [string]$m.Package.Properties.DisplayName } else { '' }
  $sid = ''; $t = 'app'
  $cfg = Join-Path $_.InstallLocation 'MicrosoftGame.config'
  if (Test-Path $cfg) {
    $t = 'game'
    try { [xml]$x = Get-Content $cfg -Raw; $sid = [string]$x.Game.StoreId; $dn = [string]$x.Game.ShellVisuals.DefaultDisplayName; if ($dn -and $dn -notlike 'ms-resource:*') { $n = $dn } } catch {}
  }
  $g += [pscustomobject]@{ l = 'xbox'; id = $_.Name; n = $n; pk = $_.Name; pfn = $_.PackageFamilyName; sid = $sid; t = $t; p = $_.InstallLocation }
}
# Everything else installed on Windows (Add or remove programs)
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName -and $_.ReleaseType -notmatch 'Update|Hotfix' } | ForEach-Object {
  $g += [pscustomobject]@{ l = 'win'; id = $_.PSChildName; n = $_.DisplayName; p = $_.InstallLocation; pub = $_.Publisher; ex = (([string]$_.DisplayIcon) -replace ',-?\d+$', '').Trim('"') }
}
$out = @{ tavernworks = 1; games = @($g) } | ConvertTo-Json -Compress -Depth 4
Set-Clipboard -Value $out
"Copied $($g.Count) installed games and apps. Paste them into the Tavernworks page."`;

  window.TavernLaunchers = {
    LAUNCHERS, SCAN_SCRIPT,
    parseVDF, fromACF, fromEpicItem, fromGogInfo, fromGameConfig, fromScan, steamLibraries,
    readFiles, readFolder,
    load, merge, unlink, remove, find, isGame,
    dedicated, companionHref, launchURI, art, links,
    companion, saveCompanion,
  };
})();
