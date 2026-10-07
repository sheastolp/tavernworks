// Deno mode for the web build.
//
// The desktop app runs a project's files under a bundled deno binary
// (main.js + harness/deno-harness.ts). A browser can't start a process, so
// this does the same job in a module Web Worker:
//   - every file is transpiled from TypeScript and loaded as a real ES
//     module, with imports between the project's files wired to each other
//   - npm: and jsr: imports load from esm.sh, https: imports load as-is,
//     and a deno.json "imports" map is honoured
//   - a Deno global covers what bots use: Deno.env (the project's Env Vars),
//     Deno.serve, Deno.readTextFile and friends over the project's files
//   - Val Town's std/sqlite is a real SQLite database (sql.js) kept in this
//     browser per project, like the desktop app's local sandbox database
//   - the same registerCommand/postSystemLine/ctx contract as the harness,
//     and the same EventSub webhook mode for a Val Town-style main.ts,
//     catching Twitch's chat-send and app-token calls
// Unlike Fast mode, the worker keeps its network access.
(function () {
  const SQL_JS_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/';
  const LOAD_TIMEOUT_MS = 60000; // first loads may pull remote imports
  const INVOKE_TIMEOUT_MS = 15000;
  const PING_TIMEOUT_MS = 1500;

  // Same .env parsing as the desktop main.js.
  function parseEnvText(text) {
    const env = {};
    (text || '').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      if (!key) return;
      let value = trimmed.slice(eq + 1).trim();
      if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
      }
      env[key] = value;
    });
    return env;
  }

  // ---------------------------------------------------------------------
  // Preparing the project's files (main thread, where TypeScript is loaded)
  // ---------------------------------------------------------------------
  const STD_SQLITE_RE = /^https:\/\/esm\.town\/v\/std\/sqlite(?:\/main\.ts)?\/?(?:\?.*)?$/;
  const FILE_TOKEN = (i) => `"__tbs_file_${i}__"`;
  const SQLITE_TOKEN = '"__tbs_sqlite__"';

  const throwModule = (message) => `throw new Error(${JSON.stringify(message)});\n`;

  function normalizePath(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }

  function readImportMap(allFiles) {
    const config = allFiles.find((f) => /^deno\.jsonc?$/i.test(f.name));
    if (!config) return {};
    try {
      // Good enough for deno.jsonc: drop // and /* */ comments and trailing commas.
      const text = config.content
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
        .replace(/,(\s*[}\]])/g, '$1');
      const imports = JSON.parse(text).imports;
      return imports && typeof imports === 'object' ? imports : {};
    } catch {
      return {};
    }
  }

  function applyImportMap(spec, importMap) {
    if (Object.prototype.hasOwnProperty.call(importMap, spec)) return importMap[spec];
    let best = '';
    for (const key of Object.keys(importMap)) {
      if (key.endsWith('/') && spec.startsWith(key) && key.length > best.length) best = key;
    }
    return best ? importMap[best] + spec.slice(best.length) : null;
  }

  // -> { file: index } | { url } | { sqlite: true } | { error }
  function resolveSpecifier(spec, fromName, fileIndex, importMap, mapped) {
    if (/^\.{0,2}\//.test(spec)) {
      const dir = !mapped && fromName.includes('/') ? fromName.slice(0, fromName.lastIndexOf('/') + 1) : '';
      const target = normalizePath((spec.startsWith('/') ? '' : dir) + spec.replace(/[?#].*$/, ''));
      if (fileIndex.has(target)) return { file: fileIndex.get(target) };
      return { error: `Cannot find "${spec}" imported from ${fromName} (no file named ${target} in this project).` };
    }
    if (!mapped) {
      const viaMap = applyImportMap(spec, importMap);
      if (viaMap) return resolveSpecifier(viaMap, fromName, fileIndex, importMap, true);
    }
    if (STD_SQLITE_RE.test(spec)) return { sqlite: true };
    if (/^(https?|data|blob):/i.test(spec)) return { url: spec };
    if (spec.startsWith('npm:')) return { url: 'https://esm.sh/' + spec.slice(4).replace(/^\/+/, '') };
    if (spec.startsWith('jsr:')) return { url: 'https://esm.sh/jsr/' + spec.slice(4).replace(/^\/+/, '') };
    if (spec.startsWith('node:')) {
      return { error: `"${spec}" (imported from ${fromName}) is a Node built-in, which the browser doesn't have. Deno mode in the desktop app supports it.` };
    }
    return { url: 'https://esm.sh/' + spec };
  }

  function collectSpecifiers(ts, code) {
    const sf = ts.createSourceFile('module.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found = [];
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
        found.push(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found.map((n) => ({ start: n.getStart(sf), end: n.getEnd(), text: n.text }));
  }

  // files: the code files to run, in project order. allFiles: every file in
  // the project (JSON files can be imported, and Deno.readTextFile sees all).
  function prepareModules(ts, files, allFiles) {
    const importMap = readImportMap(allFiles);
    const modules = [];
    const fileIndex = new Map();
    const add = (m) => {
      fileIndex.set(normalizePath(m.name), modules.length);
      modules.push(m);
    };
    files.forEach((f) => add({ name: f.name, kind: 'js', source: f.content, deps: [], entry: true }));
    allFiles.forEach((f) => {
      if (/\.json$/i.test(f.name) && !fileIndex.has(normalizePath(f.name))) add({ name: f.name, kind: 'json', code: f.content, deps: [] });
    });

    modules.forEach((m) => {
      if (m.kind !== 'js') return;
      const out = ts.transpileModule(m.source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          useDefineForClassFields: true,
        },
        reportDiagnostics: true,
        fileName: m.name,
      });
      if (out.diagnostics && out.diagnostics.length) {
        const messages = out.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ');
        m.code = throwModule(`TypeScript error: ${messages}`);
        return;
      }
      let code = out.outputText;
      const specs = collectSpecifiers(ts, code);
      for (let i = specs.length - 1; i >= 0; i--) {
        const s = specs[i];
        const r = resolveSpecifier(s.text, m.name, fileIndex, importMap, false);
        if (r.error) {
          m.code = throwModule(r.error);
          m.deps = [];
          return;
        }
        let replacement;
        if (r.file !== undefined) {
          replacement = FILE_TOKEN(r.file);
          m.deps.push(r.file);
        } else if (r.sqlite) {
          replacement = SQLITE_TOKEN;
        } else {
          replacement = JSON.stringify(r.url);
        }
        code = code.slice(0, s.start) + replacement + code.slice(s.end);
      }
      m.code = code;
    });

    // Each module's blob URL has to exist before a module importing it is
    // made, so load order is dependencies first. Blob URLs can't point at
    // each other in a circle, so files in an import cycle fail with a clear
    // message instead (the desktop app's Deno handles cycles).
    const state = new Array(modules.length).fill(0); // 0 new, 1 visiting, 2 done
    const stack = [];
    const cyclic = new Set();
    const findCycles = (i) => {
      state[i] = 1;
      stack.push(i);
      for (const d of modules[i].deps) {
        if (state[d] === 1) stack.slice(stack.indexOf(d)).forEach((n) => cyclic.add(n));
        else if (state[d] === 0) findCycles(d);
      }
      stack.pop();
      state[i] = 2;
    };
    modules.forEach((_, i) => { if (!state[i]) findCycles(i); });
    cyclic.forEach((i) => {
      const names = [...cyclic].map((n) => modules[n].name).join(', ');
      modules[i].code = throwModule(`Circular imports between ${names}. The browser can't load project files that import each other in a loop; Deno mode in the desktop app can.`);
      modules[i].deps = [];
    });

    const order = [];
    const placed = new Array(modules.length).fill(false);
    const place = (i) => {
      if (placed[i]) return;
      placed[i] = true;
      modules[i].deps.forEach(place);
      order.push(i);
    };
    modules.forEach((_, i) => place(i));

    return {
      modules: modules.map(({ name, kind, code, entry }) => ({ name, kind, code, entry: !!entry })),
      order,
    };
  }

  // ---------------------------------------------------------------------
  // The worker. Written as a function and turned into source, so it's
  // ordinary code here rather than one big string.
  // ---------------------------------------------------------------------
  function denoWorkerMain() {
    'use strict';
    const send = self.postMessage.bind(self);

    const inspect = (v) => {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack && v.stack.includes(v.message) ? v.stack : `${v.name}: ${v.message}`;
      if (typeof v === 'function') return `[Function: ${v.name || '(anonymous)'}]`;
      if (typeof v === 'object' && v !== null) {
        try { return JSON.stringify(v); } catch { return String(v); }
      }
      return String(v);
    };
    const fmt = (args) => args.map(inspect).join(' ');
    const out = (kind) => (...a) => send({ type: 'log', text: fmt(a), kind });
    // Like Deno: log/info/debug go to stdout, warn/error to stderr.
    Object.assign(self.console, { log: out('log'), info: out('log'), debug: out('log'), trace: out('log'), warn: out('error'), error: out('error') });

    let env = {};
    let vfs = new Map();
    let projectId = '';
    let sqlJsBase = '';

    // --- Deno global ---
    const toPath = (p) => {
      let s = p instanceof URL ? p.pathname : String(p);
      s = s.replace(/^file:\/\//, '');
      return s.split('/').filter((seg) => seg && seg !== '.').join('/').replace(/^project\//, '');
    };
    class NotFound extends Error { constructor(m) { super(m); this.name = 'NotFound'; } }
    class PermissionDenied extends Error { constructor(m) { super(m); this.name = 'PermissionDenied'; } }
    class AlreadyExists extends Error { constructor(m) { super(m); this.name = 'AlreadyExists'; } }
    const readText = (p) => {
      const key = toPath(p);
      if (!vfs.has(key)) throw new NotFound(`No such file or directory: readfile '${p}'`);
      return vfs.get(key);
    };
    const writeText = (p, text, opts) => {
      const key = toPath(p);
      vfs.set(key, opts && opts.append && vfs.has(key) ? vfs.get(key) + text : String(text));
    };
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let servedHandler = null;

    self.Deno = {
      env: {
        get: (k) => (Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined),
        set: (k, v) => { env[k] = String(v); },
        has: (k) => Object.prototype.hasOwnProperty.call(env, k),
        delete: (k) => { delete env[k]; },
        toObject: () => ({ ...env }),
      },
      args: [],
      pid: 1,
      noColor: true,
      build: { target: 'browser', os: 'linux', arch: 'x86_64', vendor: 'browser', env: undefined },
      version: { deno: 'browser', v8: '', typescript: '' },
      errors: { NotFound, PermissionDenied, AlreadyExists },
      cwd: () => '/project',
      inspect,
      exit: (code) => {
        send({ type: 'log', text: `Deno.exit(${code === undefined ? 0 : code}) called — the runtime has stopped. Click "Load Code" to start it again.`, kind: 'error' });
        send({ type: 'exited' });
        self.close();
        throw new Error('Deno.exit');
      },
      readTextFile: async (p) => readText(p),
      readTextFileSync: readText,
      readFile: async (p) => enc.encode(readText(p)),
      readFileSync: (p) => enc.encode(readText(p)),
      writeTextFile: async (p, t, o) => writeText(p, t, o),
      writeTextFileSync: writeText,
      writeFile: async (p, d, o) => writeText(p, dec.decode(d), o),
      writeFileSync: (p, d, o) => writeText(p, dec.decode(d), o),
      remove: async (p) => { if (!vfs.delete(toPath(p))) throw new NotFound(`No such file or directory: remove '${p}'`); },
      stat: async (p) => {
        const text = readText(p);
        return { isFile: true, isDirectory: false, isSymlink: false, size: enc.encode(text).length, mtime: null };
      },
      mkdir: async () => {},
      serve: (...args) => {
        const handler = args.find((a) => typeof a === 'function') || (args.find((a) => a && typeof a.handler === 'function') || {}).handler;
        if (handler) servedHandler = handler;
        return { finished: new Promise(() => {}), shutdown: async () => {}, ref() {}, unref() {}, addr: { transport: 'tcp', hostname: 'localhost', port: 8000 } };
      },
      cron: (name) => { console.log(`Deno.cron("${name}") isn't run in the sandbox.`); return Promise.resolve(); },
      addSignalListener: () => {},
      removeSignalListener: () => {},
      openKv: async () => { throw new Error('Deno.openKv isn’t available in the browser sandbox.'); },
    };

    // --- registerCommand / postSystemLine, as in the desktop harness ---
    const commands = new Map();
    self.registerCommand = (name, handler) => {
      commands.set(String(name).toLowerCase(), handler);
      console.log(`Registered !${name}`);
    };
    self.postSystemLine = async (text) => { send({ type: 'system-line', text: String(text) }); };

    // --- Fetch: catch Twitch chat-send and app-token, pass the rest through ---
    const originalFetch = self.fetch.bind(self);
    let capturedChatReplies = [];
    self.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
      const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();

      if (method === 'POST' && url === 'https://api.twitch.tv/helix/chat/messages') {
        try {
          const bodyText = typeof (init && init.body) === 'string' ? init.body : await (input instanceof Request ? input.text() : Promise.resolve(''));
          const parsed = JSON.parse(bodyText || '{}');
          if (typeof parsed.message === 'string') capturedChatReplies.push(parsed.message);
        } catch { /* still fake success */ }
        return new Response(JSON.stringify({ data: [{ message_id: crypto.randomUUID(), is_sent: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && url === 'https://id.twitch.tv/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'sandbox-fake-app-token', expires_in: 3600, token_type: 'bearer' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      try {
        return await originalFetch(input, init);
      } catch (err) {
        if (err instanceof TypeError) {
          throw new TypeError(`fetch ${url} failed: ${err.message}. In a browser this usually means the site doesn't allow requests from web pages (CORS); the desktop app has no such limit.`);
        }
        throw err;
      }
    };

    // --- Val Town std/sqlite, backed by sql.js and kept in IndexedDB ---
    let dbPromise = null;
    let saveTimer = null;

    const idb = () => new Promise((resolve, reject) => {
      const req = indexedDB.open('tbs-deno', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('sqlite');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const idbRun = async (mode, fn) => {
      const db = await idb();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('sqlite', mode);
          const req = fn(tx.objectStore('sqlite'));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };

    async function openDb() {
      const text = await (await originalFetch(sqlJsBase + 'sql-wasm.js')).text();
      const initSqlJs = new Function('module', 'exports', text + '\nreturn initSqlJs;')(undefined, undefined);
      const SQL = await initSqlJs({ locateFile: (f) => sqlJsBase + f });
      let saved = null;
      try { saved = await idbRun('readonly', (store) => store.get(projectId)); } catch { /* storage blocked: memory only */ }
      return new SQL.Database(saved ? new Uint8Array(saved) : undefined);
    }
    const getDb = () => {
      if (!dbPromise) {
        dbPromise = openDb().catch((err) => {
          dbPromise = null;
          throw new Error('Couldn’t start the sandbox SQLite database: ' + (err && err.message ? err.message : String(err)));
        });
      }
      return dbPromise;
    };
    const saveSoon = (db) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        idbRun('readwrite', (store) => store.put(db.export(), projectId)).catch(() => {});
      }, 250);
    };

    const toBindValue = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v);
    function toBindParams(args) {
      if (args == null) return undefined;
      if (Array.isArray(args)) return args.map(toBindValue);
      const named = {};
      for (const [k, v] of Object.entries(args)) {
        if (/^[:@$]/.test(k)) named[k] = toBindValue(v);
        else for (const p of [':', '@', '$']) named[p + k] = toBindValue(v);
      }
      return named;
    }

    // Result shaped like libsql's (what Val Town's std/sqlite returns): rows
    // are arrays that also carry each column by name, so row[0] and row.name
    // both work.
    function runStatement(db, stmt, args) {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      const params = toBindParams(typeof stmt === 'string' ? args : stmt.args);
      const st = db.prepare(sql);
      try {
        if (params !== undefined) st.bind(params);
        const columns = st.getColumnNames();
        const rows = [];
        while (st.step()) {
          const values = st.get();
          const row = values.slice();
          columns.forEach((c, i) => {
            if (c !== 'length' && !/^\d+$/.test(c)) Object.defineProperty(row, c, { value: values[i], enumerable: true, writable: true, configurable: true });
          });
          rows.push(row);
        }
        const result = { columns, columnTypes: columns.map(() => ''), rows, rowsAffected: 0, lastInsertRowid: undefined };
        if (!columns.length) {
          result.rowsAffected = db.getRowsModified();
          const last = db.exec('SELECT last_insert_rowid()');
          result.lastInsertRowid = last.length ? last[0].values[0][0] : undefined;
          saveSoon(db);
        }
        return result;
      } finally {
        st.free();
      }
    }

    self.__tbsSqlite = {
      async execute(stmt, args) {
        return runStatement(await getDb(), stmt, args);
      },
      async batch(stmts) {
        const db = await getDb();
        db.exec('BEGIN');
        try {
          const results = stmts.map((s) => runStatement(db, s));
          db.exec('COMMIT');
          saveSoon(db);
          return results;
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
          throw err;
        }
      },
      async executeMultiple(sql) {
        const db = await getDb();
        db.exec(sql);
        saveSoon(db);
      },
    };

    // --- Loading ---
    const SANDBOX_BROADCASTER_ID = '900000001';
    const SANDBOX_BROADCASTER_LOGIN = 'sandboxstreamer';
    const SANDBOX_BROADCASTER_NAME = 'SandboxStreamer';
    let webhookHandler = null;
    let webhookSeedError = null;

    const blobUrl = (code, type) => URL.createObjectURL(new Blob([code], { type }));
    const errText = (err) => (err && err.message ? err.message : String(err));

    async function load(msg) {
      env = msg.env || {};
      vfs = new Map(Object.entries(msg.files || {}));
      projectId = msg.projectId || 'default';
      sqlJsBase = msg.sqlJsBase;

      const sqliteUrl = blobUrl('const s = globalThis.__tbsSqlite;\nexport const sqlite = s;\nexport default s;\n', 'text/javascript');
      const urls = new Map();
      for (const i of msg.order) {
        const m = msg.modules[i];
        if (m.kind === 'json') {
          urls.set(i, blobUrl(m.code, 'application/json'));
          continue;
        }
        const code = m.code
          .replace(/"__tbs_file_(\d+)__"/g, (_, d) => JSON.stringify(urls.get(Number(d)) || 'missing:' + msg.modules[Number(d)].name))
          .replace(/"__tbs_sqlite__"/g, JSON.stringify(sqliteUrl));
        urls.set(i, blobUrl(code + '\n//# sourceURL=' + encodeURI(m.name), 'text/javascript'));
      }

      const loaded = new Map();
      for (let i = 0; i < msg.modules.length; i++) {
        const m = msg.modules[i];
        if (!m.entry) continue;
        try {
          loaded.set(m.name, await import(urls.get(i)));
        } catch (err) {
          console.error(`Load error in ${m.name}: ${errText(err)}`);
        }
      }

      const mainName = ['main.ts', 'main.tsx', 'main.js', 'main.jsx'].find((n) => loaded.has(n));
      const mainDefault = mainName && loaded.get(mainName).default;
      if (typeof mainDefault === 'function') {
        webhookHandler = mainDefault;
        console.log(`Detected a Twitch EventSub webhook handler (${mainName} default export) — simulating real EventSub notifications against a local sandbox database.`);
      } else if (mainDefault && typeof mainDefault.fetch === 'function') {
        webhookHandler = (req) => mainDefault.fetch(req);
        console.log(`Detected a Twitch EventSub webhook handler (${mainName} default export's fetch) — simulating real EventSub notifications against a local sandbox database.`);
      } else if (servedHandler && !commands.size) {
        webhookHandler = servedHandler;
        console.log('Detected a Twitch EventSub webhook handler (Deno.serve) — simulating real EventSub notifications against a local sandbox database.');
      }

      if (webhookHandler) {
        try {
          const sqlite = self.__tbsSqlite;
          await sqlite.execute(`CREATE TABLE IF NOT EXISTS broadcasters (
            broadcaster_id TEXT PRIMARY KEY, login TEXT, display_name TEXT, subscription_id TEXT,
            connected_at INTEGER, connected INTEGER NOT NULL DEFAULT 1, disconnected_at INTEGER, disconnect_reason TEXT
          )`);
          for (const stmt of [
            'ALTER TABLE broadcasters ADD COLUMN is_live INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE broadcasters ADD COLUMN stream_status_subscribed INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE broadcasters ADD COLUMN dashboard_key TEXT',
          ]) {
            try { await sqlite.execute(stmt); } catch { /* column already exists */ }
          }
          await sqlite.execute(
            `INSERT OR REPLACE INTO broadcasters
              (broadcaster_id,login,display_name,subscription_id,connected_at,connected,disconnected_at,disconnect_reason,is_live,stream_status_subscribed)
             VALUES (?,?,?,?,?,1,NULL,NULL,1,1)`,
            [SANDBOX_BROADCASTER_ID, SANDBOX_BROADCASTER_LOGIN, SANDBOX_BROADCASTER_NAME, 'sandbox-subscription-id', Date.now()],
          );
          console.log(`Seeded a connected sandbox broadcaster row (id ${SANDBOX_BROADCASTER_ID}) in this project's sandbox database — kept in this browser across "Load Code" clicks, never touches your real Val Town data.`);
        } catch (err) {
          webhookSeedError = errText(err);
          console.error('Failed to seed the sandbox broadcaster row:', webhookSeedError);
        }
      }

      return { commands: [...commands.keys()], webhookMode: !!webhookHandler };
    }

    // --- Invoking: same shapes as the harness's /invoke ---
    function hashCode(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    }

    async function signEventSub(secret, id, timestamp, rawBody) {
      const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(id + timestamp + rawBody)));
      return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    async function invokeWebhook(payload) {
      if (webhookSeedError) return { ok: false, error: `Couldn't seed the sandbox broadcaster row: ${webhookSeedError}` };
      const secret = self.Deno.env.get('EVENTSUB_SECRET');
      if (!secret) {
        return {
          ok: false,
          error: 'This project’s main.ts looks like a Twitch EventSub webhook bot, but no EVENTSUB_SECRET is set in Env Vars — set one (any string — it only needs to match what your code checks against itself) so simulated events can be signed.',
        };
      }

      capturedChatReplies = [];
      const chatterLogin = String(payload.user || 'viewer');
      const chatterId = payload.isBroadcaster ? SANDBOX_BROADCASTER_ID : `90000${hashCode(chatterLogin).toString().slice(0, 5)}`;
      const eventBody = {
        subscription: {
          type: 'channel.chat.message',
          version: '1',
          id: crypto.randomUUID(),
          status: 'enabled',
          condition: { broadcaster_user_id: SANDBOX_BROADCASTER_ID },
        },
        event: {
          broadcaster_user_id: SANDBOX_BROADCASTER_ID,
          broadcaster_user_login: SANDBOX_BROADCASTER_LOGIN,
          broadcaster_user_name: SANDBOX_BROADCASTER_NAME,
          chatter_user_id: chatterId,
          chatter_user_login: chatterLogin,
          chatter_user_name: chatterLogin,
          moderator_user_id: payload.isMod ? chatterId : '',
          message: { text: payload.message == null ? '' : payload.message, fragments: [] },
          badges: [],
        },
      };
      const rawBody = JSON.stringify(eventBody);
      const messageId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const signature = await signEventSub(secret, messageId, timestamp, rawBody);
      const req = new Request('https://sandbox.local/eventsub', {
        method: 'POST',
        headers: {
          'Twitch-Eventsub-Message-Id': messageId,
          'Twitch-Eventsub-Message-Timestamp': timestamp,
          'Twitch-Eventsub-Message-Type': 'notification',
          'Twitch-Eventsub-Message-Signature': signature,
          'Content-Type': 'application/json',
        },
        body: rawBody,
      });
      try {
        await webhookHandler(req);
        return { ok: true, replies: capturedChatReplies };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    }

    async function invoke(payload) {
      if (webhookHandler) return invokeWebhook(payload);
      const handler = commands.get(String(payload.command || '').toLowerCase());
      if (!handler) return { ok: false, error: 'unknown-command' };
      const replies = [];
      const ctx = {
        user: payload.user,
        args: Array.isArray(payload.args) ? payload.args : [],
        message: payload.message || '',
        isMod: !!payload.isMod,
        isSub: !!payload.isSub,
        isBroadcaster: !!payload.isBroadcaster,
        reply: (text) => replies.push(String(text)),
        say: (text) => replies.push(String(text)),
      };
      try {
        await handler(ctx);
        return { ok: true, replies };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    }

    self.onmessage = async (e) => {
      const msg = e.data;
      if (msg.type === 'ping') return send({ type: 'pong', id: msg.id });
      if (msg.type === 'load') {
        const result = await load(msg).catch((err) => ({ error: errText(err) }));
        return send({ type: 'reply', id: msg.id, result });
      }
      if (msg.type === 'invoke') {
        const result = await invoke(msg.payload);
        return send({ type: 'reply', id: msg.id, result });
      }
    };

    self.addEventListener('error', (e) => {
      console.error('Uncaught error: ' + (e.message || 'unknown'));
      e.preventDefault();
    });
    self.addEventListener('unhandledrejection', (e) => {
      console.error('Unhandled promise rejection: ' + errText(e.reason));
      e.preventDefault();
    });
  }

  let workerUrl = null;

  // ---------------------------------------------------------------------
  // Main-thread side: the deno:load / deno:invoke / deno:stop handlers.
  // ---------------------------------------------------------------------
  function createDenoRuntime({ loadTs, emit }) {
    let worker = null;
    let pending = new Map();
    let nextId = 1;

    function stop() {
      if (worker) worker.terminate();
      worker = null;
      pending.forEach((p) => { clearTimeout(p.timer); p.resolve({ stopped: true }); });
      pending = new Map();
    }

    function request(message, timeoutMs) {
      const w = worker;
      return new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ timedOut: true });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        w.postMessage({ ...message, id });
      });
    }

    function onMessage(e) {
      const msg = e.data;
      if (msg.type === 'log') emit('deno:log', { text: msg.text, kind: msg.kind === 'error' ? 'error' : 'log' });
      else if (msg.type === 'system-line') emit('deno:system-line', msg.text);
      else if (msg.type === 'exited') {
        worker = null;
        stop();
      } else if (msg.type === 'reply' || msg.type === 'pong') {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg.type === 'pong' ? { pong: true } : msg.result);
      }
    }

    async function load({ files, allFiles, projectId, env }) {
      stop();
      let ts;
      try {
        ts = await loadTs();
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const { modules, order } = prepareModules(ts, files, allFiles && allFiles.length ? allFiles : files);
      const vfs = {};
      (allFiles || files).forEach((f) => { vfs[f.name] = f.content; });

      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([`(${denoWorkerMain.toString()})();\n`], { type: 'text/javascript' }));
      try {
        worker = new Worker(workerUrl, { type: 'module', name: 'Deno sandbox' });
      } catch (err) {
        return { ok: false, error: 'This browser can’t start a module worker: ' + err.message };
      }
      worker.onmessage = onMessage;
      worker.onerror = (e) => emit('deno:log', { text: 'Worker error: ' + (e.message || 'unknown'), kind: 'error' });

      const result = await request({ type: 'load', modules, order, files: vfs, env: env || {}, projectId, sqlJsBase: SQL_JS_BASE }, LOAD_TIMEOUT_MS);
      if (result.stopped) return { ok: false, error: 'Stopped before it finished loading.' };
      if (result.timedOut) {
        stop();
        return { ok: false, error: `Loading took longer than ${LOAD_TIMEOUT_MS / 1000}s (an infinite loop, or a remote import that never arrived) — stopped.` };
      }
      if (result.error) {
        stop();
        return { ok: false, error: result.error };
      }
      return { ok: true, commands: result.commands || [], webhookMode: !!result.webhookMode };
    }

    async function invoke(payload) {
      if (!worker) return { ok: false, error: 'Deno runtime is not running. Click Load Code first.' };
      const result = await request({ type: 'invoke', payload }, INVOKE_TIMEOUT_MS);
      if (result.stopped) return { ok: false, error: 'Deno runtime was stopped.' };
      if (!result.timedOut) return result;
      // A worker stuck in a loop can't answer anything, so ask it something.
      const alive = worker && !(await request({ type: 'ping' }, PING_TIMEOUT_MS)).timedOut;
      if (alive) return { ok: false, error: `No reply after ${INVOKE_TIMEOUT_MS / 1000}s (it may still finish in the background).` };
      stop();
      return { ok: false, error: `Stuck for ${INVOKE_TIMEOUT_MS / 1000}s (an infinite loop?) — stopped. Click "Load Code" to start it again.` };
    }

    return { load, invoke, stop, get running() { return !!worker; } };
  }

  window.TBS_DENO = { createDenoRuntime, parseEnvText, prepareModules };
})();
