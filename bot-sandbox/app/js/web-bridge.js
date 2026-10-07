// Browser stand-in for the desktop app's Electron main process.
//
// The desktop renderer talks to main.js through ipcRenderer.invoke(); this
// file answers the same channels from inside the page instead:
//   - projects, UI prefs and tokens are saved to the visitor's account on
//     the Tavernworks server once they sign in with Google (see `cloud`
//     below), or in this browser's localStorage if not
//   - GitHub and Val Town sync call their public REST APIs with fetch
//   - Fast mode runs bot code in a Web Worker (see `runner` below) in place
//     of Node's vm module, so a runaway loop can be killed after 3 seconds
//   - Deno mode runs in a module Web Worker with a Deno stand-in (see
//     js/deno-runtime.js) in place of the bundled deno binary
(function () {
  const STORE = {
    projects: 'tbs:projects',
    prefs: 'tbs:ui-prefs',
    token: (name) => `tbs:${name}-token`,
  };

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  }

  function readLocalToken(name) {
    try { return localStorage.getItem(STORE.token(name)) || null; } catch { return null; }
  }

  function removeLocal(key) {
    try { localStorage.removeItem(key); } catch { /* blocked */ }
  }

  // --- Account storage ---
  //
  // Anyone can sign in with Google. The server (hushwave/suggestion-box/
  // server.mjs, address in suggest-config.js) checks the Google sign-in and
  // keeps each account's projects, prefs and tokens separately. While signed
  // in, nothing but the session is kept in the browser.
  const API = (window.SUGGEST_API || '').replace(/\/+$/, '');
  const SESSION_KEY = 'tbs:session';
  const ADMIN_SESSION_KEY = 'hushwave:suggestToken'; // the tip jar admin login, used once to hand over pre-Google projects
  const SAVE_DELAY_MS = 700;

  const cloud = {
    session: '',
    user: null, // { name, email, picture }
    signedIn: false,
    rev: 0,
    secrets: {},
    prefs: {},
    // 'local' | 'loading' | 'saved' | 'saving' | 'error' | 'conflict' | 'unreachable'
    status: 'local',
    message: '',
    pending: null, // projects waiting to be sent
    inFlight: false,
    timer: null,
  };
  const statusListeners = new Set();

  function setStatus(status, message = '') {
    cloud.status = status;
    cloud.message = message;
    statusListeners.forEach((fn) => { try { fn(status, message); } catch { /* listener bug */ } });
  }

  function readSession(key = SESSION_KEY) {
    try {
      const t = JSON.parse(localStorage.getItem(key));
      return t && t.expires > Date.now() ? t.token : '';
    } catch {
      return '';
    }
  }

  function writeSession(value) {
    try {
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* blocked */ }
  }

  async function api(method, path, body) {
    if (!API) throw new Error('No server address set (SUGGEST_API in /hushwave/suggest-config.js).');
    let resp;
    try {
      resp = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cloud.session ? { Authorization: 'Bearer ' + cloud.session } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      const err = new Error('Couldn\u2019t reach the Tavernworks server. It may be offline for a bit; try again later.');
      err.unreachable = true;
      throw err;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || 'HTTP ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  // A project's env vars ("env-<projectId>") fall back to this browser when
  // the server is an older version that only stores the github and valtown
  // tokens.
  const isEnvName = (name) => name.startsWith('env-');

  function readToken(name) {
    if (!cloud.signedIn) return readLocalToken(name);
    return cloud.secrets[name] || (isEnvName(name) ? readLocalToken(name) : null);
  }

  function writeLocalToken(name, token) {
    try {
      if (token) localStorage.setItem(STORE.token(name), token);
      else localStorage.removeItem(STORE.token(name));
      return true;
    } catch {
      return false;
    }
  }

  async function writeToken(name, token) {
    if (!cloud.signedIn) {
      return writeLocalToken(name, token) ? { ok: true, encrypted: false } : { ok: false, error: 'This browser blocked saving.' };
    }
    try {
      await api('PUT', '/sandbox/secrets/' + name, { token: token || '' });
      if (token) cloud.secrets[name] = token;
      else delete cloud.secrets[name];
      if (isEnvName(name)) writeLocalToken(name, ''); // the account copy wins from now on
      return { ok: true, encrypted: true, account: true };
    } catch (err) {
      if (isEnvName(name) && err.status === 404) {
        delete cloud.secrets[name];
        return writeLocalToken(name, token)
          ? { ok: true, encrypted: false, browserOnly: true }
          : { ok: false, error: 'This browser blocked saving.' };
      }
      return { ok: false, error: err.message };
    }
  }

  // Send the newest projects to the account, one request at a time.
  async function flushSave() {
    clearTimeout(cloud.timer);
    cloud.timer = null;
    if (cloud.inFlight || !cloud.pending || cloud.status === 'conflict') return;
    const projects = cloud.pending;
    cloud.pending = null;
    cloud.inFlight = true;
    setStatus('saving');
    try {
      const result = await api('PUT', '/sandbox/projects', { projects, rev: cloud.rev });
      cloud.rev = result.rev;
      cloud.inFlight = false;
      if (cloud.pending) return flushSave();
      setStatus('saved');
    } catch (err) {
      cloud.inFlight = false;
      if (err.status === 409) {
        setStatus('conflict', err.message);
      } else if (err.status === 401) {
        cloud.pending = cloud.pending || projects;
        setStatus('error', 'Your sign-in ran out. Sign in again to keep saving.');
      } else {
        // Server asleep or offline: keep the changes and try again shortly.
        cloud.pending = cloud.pending || projects;
        setStatus('error', 'Not saved yet \u2014 ' + err.message + ' Retrying\u2026');
        cloud.timer = setTimeout(flushSave, 5000);
      }
    }
  }

  function queueSave(projects) {
    // The renderer mutates its projects object in place, so send a snapshot.
    cloud.pending = JSON.parse(JSON.stringify(projects));
    if (cloud.status !== 'conflict') setStatus('saving');
    clearTimeout(cloud.timer);
    cloud.timer = setTimeout(flushSave, SAVE_DELAY_MS);
  }

  const hasUnsaved = () => cloud.signedIn && (!!cloud.pending || cloud.inFlight);

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved()) return;
    flushSave();
    e.preventDefault();
    e.returnValue = '';
  });

  // Same starter projects the desktop app ships with.
  const DEFAULT_PROJECTS = {
    guildscribe: {
      label: 'GuildScribe (D&D bot)',
      runtime: 'node',
      files: [{
        id: 'file_default',
        name: 'commands.js',
        content: "// GuildScribe sandbox stub.\n// registerCommand(name, handlerFn) — handlerFn receives a context object.\nregisterCommand('roll', (ctx) => {\n  const sides = Number(ctx.args[0]) || 20;\n  const result = Math.floor(Math.random() * sides) + 1;\n  ctx.reply(`${ctx.user} rolled a d${sides}: ${result}`);\n});\n",
      }],
      history: [],
    },
    huntandhoard: {
      label: 'Hunt & Hoard (TheWanderingClerk)',
      runtime: 'node',
      files: [{
        id: 'file_default',
        name: 'commands.js',
        content: "// Hunt & Hoard sandbox stub.\nregisterCommand('stall', (ctx) => {\n  ctx.reply('The merchant\\'s stall creaks open, wares glinting in the torchlight.');\n});\n",
      }],
      history: [],
    },
    undercoverburn: {
      label: 'UndercoverBurn (roast bot)',
      runtime: 'node',
      files: [{
        id: 'file_default',
        name: 'commands.js',
        content: "// UndercoverBurn sandbox stub.\nregisterCommand('roast', (ctx) => {\n  ctx.reply(`${ctx.args.join(' ') || ctx.user}, you're the reason the mute button exists.`);\n});\n",
      }],
      history: [],
    },
  };

  function normalizeProjects(data) {
    for (const id of Object.keys(data)) {
      const proj = data[id];
      if (!Array.isArray(proj.files)) proj.files = [];
      if (proj.runtime !== 'node' && proj.runtime !== 'deno') proj.runtime = 'node';
    }
    return data;
  }

  const freshDefaults = () => JSON.parse(JSON.stringify(DEFAULT_PROJECTS));

  // Runs once on page load. Signed in: fetch everything from the account,
  // moving anything still stored in this browser up to it first.
  async function startStorage() {
    cloud.session = readSession();
    if (!cloud.session) {
      setStatus('local');
      return { projects: normalizeProjects(readJson(STORE.projects, null) || freshDefaults()), prefs: readJson(STORE.prefs, {}) };
    }

    setStatus('loading');
    let state;
    try {
      state = await api('GET', '/sandbox');
    } catch (err) {
      if (err.status === 401) {
        writeSession(null);
        cloud.session = '';
        setStatus('local', 'Your sign-in ran out, so this is the browser copy. Sign in again to use your account.');
        return { projects: normalizeProjects(readJson(STORE.projects, null) || freshDefaults()), prefs: readJson(STORE.prefs, {}) };
      }
      if (err.status === 404) err.message = 'The server is an older version without sandbox storage.';
      // Don't fall back to the browser copy: saving it would overwrite the
      // account's newer work later. Show nothing and save nothing instead.
      setStatus('unreachable', err.message);
      return { projects: {}, prefs: {} };
    }

    cloud.signedIn = true;
    cloud.user = state.user || null;
    cloud.rev = state.rev || 0;
    cloud.secrets = state.secrets || {};
    cloud.prefs = state.prefs || {};

    try {
      await moveBrowserDataUp(state);
    } catch (err) {
      setStatus('error', 'Couldn\u2019t move this browser\u2019s projects to your account: ' + err.message);
      return { projects: normalizeProjects(state.projects || {}), prefs: cloud.prefs };
    }

    setStatus('saved');
    return { projects: normalizeProjects(cloud.projects), prefs: cloud.prefs };
  }

  // First sign-in on a browser that has projects saved in it: if the account
  // is empty they become its projects, otherwise they're kept in the account
  // as a backup. Either way, the browser copy is then deleted.
  async function moveBrowserDataUp(state) {
    const localProjects = readJson(STORE.projects, null);
    const localPrefs = readJson(STORE.prefs, null);
    cloud.projects = state.projects;

    if (!cloud.projects) {
      const first = localProjects || freshDefaults();
      const result = await api('PUT', '/sandbox/projects', { projects: first, rev: cloud.rev });
      cloud.rev = result.rev;
      cloud.projects = first;
      if (localPrefs) {
        await api('PUT', '/sandbox/prefs', { prefs: localPrefs });
        cloud.prefs = localPrefs;
      }
    } else if (localProjects && !isUntouchedDefaults(localProjects)) {
      await api('POST', '/sandbox/backups', { projects: localProjects, prefs: localPrefs || {} });
      cloud.movedToBackup = true;
    }

    const envNames = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const m = /^tbs:(env-[A-Za-z0-9_-]{1,80})-token$/.exec(localStorage.key(i));
        if (m) envNames.push(m[1]);
      }
    } catch { /* blocked */ }
    for (const name of ['github', 'valtown']) {
      const token = readLocalToken(name);
      if (token && !cloud.secrets[name]) {
        await api('PUT', '/sandbox/secrets/' + name, { token });
        cloud.secrets[name] = token;
      }
      removeLocal(STORE.token(name));
    }
    // Env vars move up too when the server can hold them; an older server
    // can't, so they stay in this browser instead of failing the sign-in.
    for (const name of envNames) {
      const token = readLocalToken(name);
      if (cloud.secrets[name] || !token) {
        removeLocal(STORE.token(name));
        continue;
      }
      try {
        await api('PUT', '/sandbox/secrets/' + name, { token });
        cloud.secrets[name] = token;
        removeLocal(STORE.token(name));
      } catch { /* keep the browser copy */ }
    }
    removeLocal(STORE.projects);
    removeLocal(STORE.prefs);
  }

  function isUntouchedDefaults(data) {
    const strip = (p) => JSON.stringify(Object.entries(p).map(([id, proj]) => [id, proj.label, proj.files.map((f) => [f.name, f.content])]));
    try { return strip(data) === strip(freshDefaults()); } catch { return false; }
  }

  let started = null;
  const ready = () => (started = started || startStorage());

  function saveProjects(data) {
    if (cloud.signedIn) queueSave(data);
    else if (cloud.status !== 'unreachable') writeJson(STORE.projects, data);
    return true;
  }

  let prefsTimer = null;
  function savePrefs(prefs) {
    if (!cloud.signedIn) {
      if (cloud.status !== 'unreachable') writeJson(STORE.prefs, prefs);
      return true;
    }
    cloud.prefs = prefs;
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => api('PUT', '/sandbox/prefs', { prefs }).catch(() => {}), SAVE_DELAY_MS);
    return true;
  }

  // --- Sign in / out, backups (used by js/web-storage.js) ---
  const storage = {
    get status() { return { status: cloud.status, message: cloud.message, signedIn: cloud.signedIn, user: cloud.user, movedToBackup: !!cloud.movedToBackup, hasServer: !!API }; },
    onStatus(fn) { statusListeners.add(fn); fn(cloud.status, cloud.message); return () => statusListeners.delete(fn); },
    hasUnsaved,
    flush: flushSave,

    // credential: the ID token from Google's sign-in button.
    async signInWithGoogle(credential) {
      const data = await api('POST', '/sandbox/google', { credential, adminToken: readSession(ADMIN_SESSION_KEY) || undefined });
      writeSession({ token: data.token, expires: data.expires });
      return data;
    },
    signOut() {
      writeSession(null);
    },
    async deleteAccount() {
      clearTimeout(cloud.timer);
      cloud.pending = null;
      await api('DELETE', '/sandbox/account');
      writeSession(null);
    },

    listBackups: () => api('GET', '/sandbox/backups').then((d) => d.backups || []),
    backupNow: () => api('POST', '/sandbox/backups', {}),
    getBackup: (id) => api('GET', '/sandbox/backups/' + encodeURIComponent(id)),
    deleteBackup: (id) => api('DELETE', '/sandbox/backups/' + encodeURIComponent(id)),
    async restoreBackup(id) {
      await flushSave();
      await api('POST', '/sandbox/backups/' + encodeURIComponent(id) + '/restore');
    },

    // A backup file's contents: signed in, it's stored in the account as a
    // backup and restored from there (so the current set is kept as a
    // backup too); signed out, it replaces this browser's copy.
    async restoreFromData({ projects, prefs }) {
      if (!cloud.signedIn) {
        writeJson(STORE.projects, projects);
        if (prefs) writeJson(STORE.prefs, prefs);
        return;
      }
      await flushSave();
      const { id } = await api('POST', '/sandbox/backups', { projects, prefs: prefs || {} });
      await api('POST', '/sandbox/backups/' + encodeURIComponent(id) + '/restore');
    },
  };

  // --- File picker (stands in for Electron's dialog.showOpenDialog) ---
  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.js,.mjs,.cjs,.ts,.tsx,.jsx,.txt,.json,.md';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      input.addEventListener('change', async () => {
        const list = Array.from(input.files || []);
        if (!list.length) return finish(null);
        const picked = await Promise.all(list.map(async (f) => ({ fileName: f.name, content: await f.text() })));
        finish(picked);
      });
      input.addEventListener('cancel', () => finish(null));
      input.click();
    });
  }

  // --- GitHub sync (same REST calls as the desktop main.js) ---
  const GITHUB_API = 'https://api.github.com';

  function githubApiHeaders(token) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function encodeURIPathSegments(p) {
    return (p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  function joinRepoPath(basePath, fileName) {
    const trimmed = (basePath || '').replace(/^\/+|\/+$/g, '');
    return trimmed ? `${trimmed}/${fileName}` : fileName;
  }

  async function safeReadJson(resp) {
    try { return await resp.json(); } catch { return null; }
  }

  function githubStatusHint(status, hasToken) {
    if (status === 404) {
      return hasToken
        ? ' (double-check owner/repo/branch/path are exactly right \u2014 GitHub also returns 404, not 403, for a private repo your token doesn\u2019t have access to)'
        : ' (if this is a private repo, GitHub returns 404 for it without a token that has access \u2014 save a token first)';
    }
    if (status === 401) return ' (your saved token looks invalid or expired)';
    return '';
  }

  function decodeBase64Utf8(b64) {
    const bin = atob((b64 || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function githubDownload({ owner, repo, branch, path: repoPath }) {
    const token = readToken('github');
    const seg = encodeURIPathSegments(repoPath);
    const ref = encodeURIComponent(branch || 'main');
    const listUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents${seg ? '/' + seg : ''}?ref=${ref}`;

    let listResp;
    try {
      listResp = await fetch(listUrl, { headers: githubApiHeaders(token) });
    } catch (err) {
      return { ok: false, error: 'Network error: ' + err.message };
    }
    if (!listResp.ok) {
      const body = await safeReadJson(listResp);
      return { ok: false, error: `GitHub error ${listResp.status}: ${(body && body.message) || listResp.statusText}${githubStatusHint(listResp.status, !!token)}` };
    }

    const listing = await listResp.json();
    const entries = Array.isArray(listing) ? listing : [listing];
    const fileEntries = entries.filter((e) => e.type === 'file');
    if (!fileEntries.length) {
      return { ok: false, error: 'No files found at that repo path (only a subdirectory, or the path is empty).' };
    }

    const files = [];
    for (const entry of fileEntries) {
      const fileUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIPathSegments(entry.path)}?ref=${ref}`;
      let fileResp;
      try {
        fileResp = await fetch(fileUrl, { headers: githubApiHeaders(token) });
      } catch (err) {
        return { ok: false, error: `Network error fetching ${entry.path}: ${err.message}` };
      }
      if (!fileResp.ok) return { ok: false, error: `Failed to fetch ${entry.path}: ${fileResp.status}` };
      const fileData = await fileResp.json();
      files.push({ name: entry.name, content: decodeBase64Utf8(fileData.content) });
    }
    return { ok: true, files };
  }

  async function githubUpload({ owner, repo, branch, path: repoPath, files, commitMessage }) {
    const token = readToken('github');
    if (!token) return { ok: false, error: 'No GitHub token saved yet. Set one first.' };
    if (!files || !files.length) return { ok: false, error: 'Nothing to upload \u2014 this project has no files.' };

    const branchName = branch || 'main';
    const headers = githubApiHeaders(token);
    const base = `${GITHUB_API}/repos/${owner}/${repo}`;

    try {
      const refResp = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branchName)}`, { headers });
      if (!refResp.ok) {
        const body = await safeReadJson(refResp);
        return { ok: false, error: `Couldn't read branch "${branchName}": ${(body && body.message) || refResp.status}${githubStatusHint(refResp.status, true)}` };
      }
      const baseCommitSha = (await refResp.json()).object.sha;

      const commitResp = await fetch(`${base}/git/commits/${baseCommitSha}`, { headers });
      if (!commitResp.ok) return { ok: false, error: 'Failed to read the base commit.' };
      const baseTreeSha = (await commitResp.json()).tree.sha;

      const treeEntries = [];
      for (const file of files) {
        const blobResp = await fetch(`${base}/git/blobs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
        });
        if (!blobResp.ok) {
          const body = await safeReadJson(blobResp);
          return { ok: false, error: `Failed to upload ${file.name}: ${(body && body.message) || blobResp.status}` };
        }
        const blobData = await blobResp.json();
        treeEntries.push({ path: joinRepoPath(repoPath, file.name), mode: '100644', type: 'blob', sha: blobData.sha });
      }

      const treeResp = await fetch(`${base}/git/trees`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      });
      if (!treeResp.ok) {
        const body = await safeReadJson(treeResp);
        return { ok: false, error: `Failed to build the tree: ${(body && body.message) || treeResp.status}` };
      }
      const treeData = await treeResp.json();

      const newCommitResp = await fetch(`${base}/git/commits`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: commitMessage || 'Update from TwitchBotSandbox',
          tree: treeData.sha,
          parents: [baseCommitSha],
        }),
      });
      if (!newCommitResp.ok) {
        const body = await safeReadJson(newCommitResp);
        return { ok: false, error: `Failed to create the commit: ${(body && body.message) || newCommitResp.status}` };
      }
      const newCommitData = await newCommitResp.json();

      const updateRefResp = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branchName)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ sha: newCommitData.sha }),
      });
      if (!updateRefResp.ok) {
        const body = await safeReadJson(updateRefResp);
        return { ok: false, error: `Failed to update branch "${branchName}": ${(body && body.message) || updateRefResp.status}` };
      }

      return {
        ok: true,
        commitSha: newCommitData.sha,
        commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitData.sha}`,
      };
    } catch (err) {
      return { ok: false, error: 'Network error: ' + err.message };
    }
  }

  // --- Val Town sync (the REST endpoints @valtown/sdk wraps) ---
  const VALTOWN_API = 'https://api.val.town';

  async function valTownFetch(path, init = {}) {
    const token = readToken('valtown');
    const headers = { ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body) headers['Content-Type'] = 'application/json';
    const resp = await fetch(VALTOWN_API + path, { ...init, headers });
    if (!resp.ok) {
      const body = await safeReadJson(resp);
      throw new Error(`${resp.status} ${(body && (body.message || body.error)) || resp.statusText}`);
    }
    return resp;
  }

  async function findVal(owner, valName) {
    const resp = await valTownFetch(`/v2/alias/vals/${encodeURIComponent(owner)}/${encodeURIComponent(valName)}`);
    return resp.json();
  }

  async function listValRoot(valId) {
    const resp = await valTownFetch(`/v2/vals/${valId}/files?path=&recursive=false&limit=100&offset=0`);
    const body = await resp.json();
    return body.data || [];
  }

  async function valtownDownload({ owner, valName }) {
    if (!owner || !valName) return { ok: false, error: 'Owner and Val name are required.' };

    let val;
    try {
      val = await findVal(owner, valName);
    } catch (err) {
      return { ok: false, error: `Couldn't find val "${owner}/${valName}": ${err.message}` };
    }

    let entries;
    try {
      entries = (await listValRoot(val.id)).filter((e) => e.type !== 'directory');
    } catch (err) {
      return { ok: false, error: 'Failed to list files: ' + err.message };
    }
    if (!entries.length) {
      return { ok: false, error: 'No files found at the root of that val (subdirectories aren\u2019t synced).' };
    }

    const files = [];
    for (const entry of entries) {
      try {
        const resp = await valTownFetch(`/v2/vals/${val.id}/files/content?path=${encodeURIComponent(entry.path)}`);
        files.push({ name: entry.name, content: await resp.text() });
      } catch (err) {
        return { ok: false, error: `Failed to fetch ${entry.path}: ${err.message}` };
      }
    }
    return { ok: true, files };
  }

  async function valtownUpload({ owner, valName, files }) {
    if (!owner || !valName) return { ok: false, error: 'Owner and Val name are required.' };
    if (!readToken('valtown')) return { ok: false, error: 'No Val Town token saved yet. Set one first.' };
    if (!files || !files.length) return { ok: false, error: 'Nothing to upload \u2014 this project has no files.' };

    let val;
    try {
      val = await findVal(owner, valName);
    } catch (err) {
      return { ok: false, error: `Couldn't find val "${owner}/${valName}": ${err.message}` };
    }

    let existingNames;
    try {
      existingNames = new Set((await listValRoot(val.id)).map((e) => e.name));
    } catch (err) {
      return { ok: false, error: 'Failed to list existing files: ' + err.message };
    }

    for (const file of files) {
      const path = `/v2/vals/${val.id}/files?path=${encodeURIComponent(file.name)}`;
      try {
        if (existingNames.has(file.name)) {
          await valTownFetch(path, { method: 'PUT', body: JSON.stringify({ content: file.content }) });
        } else {
          await valTownFetch(path, { method: 'POST', body: JSON.stringify({ type: 'file', content: file.content }) });
        }
      } catch (err) {
        return { ok: false, error: `Failed to upload ${file.name}: ${err.message}` };
      }
    }
    return { ok: true, uploaded: files.length, valUrl: `https://www.val.town/x/${owner}/${valName}` };
  }

  // --- ipcRenderer stand-in ---
  const listeners = new Map(); // channel -> Set of (event, payload) => void
  const emit = (channel, payload) => (listeners.get(channel) || new Set()).forEach((fn) => {
    try { fn(null, payload); } catch (err) { console.error(err); }
  });

  const envName = (projectId) => 'env-' + String(projectId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const deno = window.TBS_DENO.createDenoRuntime({ loadTs: () => loadTs(), emit });

  let denoProjectId = null; // the project the Deno runtime last loaded

  function denoEnv(projectId) {
    const valtown = readToken('valtown');
    return {
      // Real Val Town gives vals the caller's API token under this name,
      // which std/blob, std/email and friends read.
      ...(valtown ? { valtown } : {}),
      ...window.TBS_DENO.parseEnvText(readToken(envName(projectId)) || ''),
    };
  }

  function denoLoad({ files, allFiles, projectId }) {
    denoProjectId = projectId;
    return deno.load({ files, allFiles, projectId, env: denoEnv(projectId) });
  }

  async function envSet({ projectId, text }) {
    const result = await writeToken(envName(projectId), text);
    if (result && result.ok && deno.running && denoProjectId === projectId) {
      result.live = await deno.setEnv(denoEnv(projectId));
    }
    return result;
  }

  const handlers = {
    'projects:load': () => ready().then((r) => r.projects),
    'projects:save': saveProjects,
    'ui:getPrefs': () => ready().then((r) => r.prefs),
    'ui:setPrefs': savePrefs,
    'app:getVersion': () => '1.9.3 web',
    'dialog:openFiles': () => pickFiles(),
    'deno:load': denoLoad,
    'deno:invoke': (payload) => deno.invoke(payload),
    'deno:stop': () => { deno.stop(); return true; },
    'env:get': (projectId) => ({ text: readToken(envName(projectId)) || '' }),
    'env:set': envSet,
    'github:tokenStatus': () => ({ hasToken: !!readToken('github') }),
    'github:setToken': (token) => writeToken('github', token),
    'github:download': githubDownload,
    'github:upload': githubUpload,
    'valtown:tokenStatus': () => ({ hasToken: !!readToken('valtown') }),
    'valtown:setToken': (token) => writeToken('valtown', token),
    'valtown:download': valtownDownload,
    'valtown:upload': valtownUpload,
    'shell:openExternal': (url) => { if (/^https:\/\/github\.com\//.test(url)) window.open(url, '_blank', 'noopener'); },
    'shell:openValTown': (url) => { if (/^https:\/\/(www\.)?val\.town\//.test(url)) window.open(url, '_blank', 'noopener'); },
  };

  const ipcRenderer = {
    invoke(channel, payload) {
      const handler = handlers[channel];
      if (!handler) return Promise.reject(new Error('Unknown channel: ' + channel));
      return Promise.resolve().then(() => handler(payload));
    },
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
    },
  };

  // --- TypeScript compiler, loaded on first use (it's a few MB) ---
  const TS_URL = 'https://cdn.jsdelivr.net/npm/typescript@5.9.3/lib/typescript.js';
  let tsPromise = null;

  function loadTs() {
    if (window.ts) return Promise.resolve(window.ts);
    if (!tsPromise) {
      tsPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = TS_URL;
        script.crossOrigin = 'anonymous';
        script.onload = () => (window.ts ? resolve(window.ts) : reject(new Error('TypeScript loaded but did not define `ts`')));
        script.onerror = () => {
          tsPromise = null;
          reject(new Error('Could not download the TypeScript compiler \u2014 check your connection and try again.'));
        };
        document.head.appendChild(script);
      });
    }
    return tsPromise;
  }

  // --- Fast-mode runner: a Web Worker in place of Node's vm context ---
  //
  // Every file is handed to importScripts() as its own classic script, so
  // they share one global scope exactly like vm.runInContext on one
  // context. Network and storage globals are removed before any user code
  // runs, matching the desktop app's "no network or file access" promise,
  // and the worker is terminated if loading or a command takes longer than
  // TIMEOUT_MS (the desktop app's vm timeout).
  const TIMEOUT_MS = 3000;

  const WORKER_SOURCE = `
    'use strict';
    const post = (msg) => self.postMessage(msg);
    const fmt = (args) => args.map((a) => {
      if (typeof a === 'string') return a;
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch { return String(a); }
    }).join(' ');
    const commands = new Map();
    const loadScripts = self.importScripts.bind(self);
    const send = self.postMessage.bind(self);

    self.console = {
      log: (...a) => send({ type: 'log', text: fmt(a) }),
      info: (...a) => send({ type: 'log', text: fmt(a) }),
      warn: (...a) => send({ type: 'log', text: fmt(a) }),
      error: (...a) => send({ type: 'log', text: fmt(a), kind: 'error' }),
      debug: () => {},
    };
    self.registerCommand = (name, handler) => {
      commands.set(String(name).toLowerCase(), handler);
      send({ type: 'registered', name: String(name) });
    };
    self.postSystemLine = (text) => send({ type: 'bot', text: String(text) });

    for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
                       'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'navigator']) {
      // Remove it from the prototype chain too, so it can't be fished back out.
      for (let o = Object.getPrototypeOf(self); o; o = Object.getPrototypeOf(o)) {
        try { delete o[key]; } catch {}
      }
      try { Object.defineProperty(self, key, { value: undefined, configurable: false, writable: false }); } catch {}
    }
    try { self.postMessage = undefined; } catch {}

    self.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'load') {
        msg.files.forEach((file) => {
          const url = URL.createObjectURL(new Blob([file.source + '\\n//# sourceURL=' + file.name], { type: 'text/javascript' }));
          try {
            loadScripts(url);
          } catch (err) {
            send({ type: 'fileError', name: file.name, message: (err && err.message ? err.message : String(err)).replace(/^Failed to execute 'importScripts' on 'WorkerGlobalScope': /, '') });
          } finally {
            URL.revokeObjectURL(url);
          }
        });
        send({ type: 'loaded' });
      } else if (msg.type === 'invoke') {
        const handler = commands.get(msg.command);
        if (!handler) return send({ type: 'invoked', id: msg.id, ok: false, error: 'unknown-command' });
        const ctx = {
          ...msg.ctx,
          reply: (text) => send({ type: 'bot', text: String(text) }),
          say: (text) => send({ type: 'bot', text: String(text) }),
        };
        let result;
        try {
          result = handler(ctx);
        } catch (err) {
          return send({ type: 'invoked', id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
        }
        send({ type: 'invoked', id: msg.id, ok: true });
        if (result && typeof result.then === 'function') {
          result.then(null, (err) => send({ type: 'asyncError', command: msg.command, message: err && err.message ? err.message : String(err) }));
        }
      }
    };

    self.addEventListener('error', (e) => {
      send({ type: 'log', text: 'Uncaught error: ' + (e.message || 'unknown'), kind: 'error' });
      e.preventDefault();
    });
    self.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      send({ type: 'log', text: 'Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)), kind: 'error' });
      e.preventDefault();
    });
  `;

  const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));

  function createRunner() {
    let worker = null;
    let listeners = {};
    let pending = new Map();
    let nextId = 1;

    function stop() {
      if (worker) worker.terminate();
      worker = null;
      pending.forEach((p) => { clearTimeout(p.timer); p.resolve({ ok: false, error: 'Code was unloaded.' }); });
      pending = new Map();
    }

    function onMessage(e) {
      const msg = e.data;
      if (msg.type === 'log') listeners.onLog && listeners.onLog(msg.text, msg.kind || null);
      else if (msg.type === 'bot') listeners.onBotLine && listeners.onBotLine(msg.text);
      else if (msg.type === 'registered') listeners.onRegister && listeners.onRegister(msg.name);
      else if (msg.type === 'fileError') listeners.onFileError && listeners.onFileError(msg.name, msg.message);
      else if (msg.type === 'asyncError') listeners.onLog && listeners.onLog(`Error in !${msg.command}: ${msg.message}`, 'error');
      else if (msg.type === 'loaded' || msg.type === 'invoked') {
        const key = msg.type === 'loaded' ? 'load' : msg.id;
        const p = pending.get(key);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(key);
        p.resolve(msg);
      }
    }

    function request(key, message, timeoutError) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(key);
          stop();
          resolve({ ok: false, timedOut: true, error: timeoutError });
        }, TIMEOUT_MS);
        pending.set(key, { resolve, timer });
        worker.postMessage(message);
      });
    }

    return {
      // files: [{ name, source }] — already transpiled to plain JS.
      load(files, newListeners) {
        stop();
        listeners = newListeners || {};
        worker = new Worker(workerUrl);
        worker.onmessage = onMessage;
        return request('load', { type: 'load', files },
          `Loading took longer than ${TIMEOUT_MS / 1000}s (an infinite loop?) \u2014 stopped.`);
      },
      invoke(command, ctx) {
        if (!worker) return Promise.resolve({ ok: false, error: 'unknown-command' });
        const id = nextId++;
        return request(id, { type: 'invoke', id, command, ctx },
          `!${command} ran longer than ${TIMEOUT_MS / 1000}s (an infinite loop?) \u2014 stopped, click "Load Code" to reload.`);
      },
      stop,
    };
  }

  window.TBS_WEB = { ipcRenderer, loadTs, runner: createRunner(), storage };
})();
