// Web build: js/web-bridge.js stands in for Electron's main process, a Web
// Worker stands in for Node's vm module, and TypeScript loads on first use.
const { ipcRenderer, runner: sandboxRunner, loadTs } = window.TBS_WEB;
// `ts` below is the global the TypeScript compiler script defines once loadTs() resolves.

// --- DOM refs ---
const projectListEl = document.getElementById('project-list');
const addProjectBtn = document.getElementById('add-project-btn');
const activeProjectNameEl = document.getElementById('active-project-name');
const runtimeNodeBtn = document.getElementById('runtime-node-btn');
const runtimeDenoBtn = document.getElementById('runtime-deno-btn');
const fileTabsEl = document.getElementById('file-tabs');
const newFileBtn = document.getElementById('new-file-btn');
const codeEditorEl = document.getElementById('code-editor');
const lineNumbersEl = document.getElementById('line-numbers');
const importFileBtn = document.getElementById('import-file-btn');
const loadCodeBtn = document.getElementById('load-code-btn');
const clearChatBtn = document.getElementById('clear-chat-btn');
const editorLogEl = document.getElementById('editor-log');
const chatLogEl = document.getElementById('chat-log');
const chatFormEl = document.getElementById('chat-form');
const chatUsernameEl = document.getElementById('chat-username');
const chatMessageEl = document.getElementById('chat-message');
const chatModEl = document.getElementById('chat-mod');
const chatSubEl = document.getElementById('chat-sub');
const chatBroadcasterEl = document.getElementById('chat-broadcaster');
const statusPillEl = document.getElementById('status-pill');

// Input modal refs (replaces window.prompt(), which Electron doesn't implement)
const inputModalOverlay = document.getElementById('input-modal-overlay');
const inputModalTitleEl = document.getElementById('input-modal-title');
const inputModalLabelEl = document.getElementById('input-modal-label');
const inputModalFieldEl = document.getElementById('input-modal-field');
const inputModalClose = document.getElementById('input-modal-close');
const inputModalCancelBtn = document.getElementById('input-modal-cancel-btn');
const inputModalOkBtn = document.getElementById('input-modal-ok-btn');

// Resizable panel refs
const sidebarEl = document.getElementById('sidebar');
const sidebarResizerEl = document.getElementById('sidebar-resizer');
const fileExplorerPanelEl = document.getElementById('file-explorer');
const explorerResizerEl = document.getElementById('explorer-resizer');
const editorPaneEl = document.getElementById('editor-pane');
const chatResizerEl = document.getElementById('chat-resizer');

// GitHub Sync modal refs
const githubSyncBtn = document.getElementById('github-sync-btn');
const githubModalOverlay = document.getElementById('github-modal-overlay');
const githubModalClose = document.getElementById('github-modal-close');
const githubModalProjectName = document.getElementById('github-modal-project-name');
const githubOwnerEl = document.getElementById('github-owner');
const githubRepoEl = document.getElementById('github-repo');
const githubBranchEl = document.getElementById('github-branch');
const githubPathEl = document.getElementById('github-path');
const githubTokenEl = document.getElementById('github-token');
const githubTokenStatusEl = document.getElementById('github-token-status');
const githubCommitMessageEl = document.getElementById('github-commit-message');
const githubSaveSettingsBtn = document.getElementById('github-save-settings-btn');
const githubDownloadBtn = document.getElementById('github-download-btn');
const githubUploadBtn = document.getElementById('github-upload-btn');
const githubModalLogEl = document.getElementById('github-modal-log');

// Val Town Sync modal refs
const valtownSyncBtn = document.getElementById('valtown-sync-btn');
const valtownModalOverlay = document.getElementById('valtown-modal-overlay');
const valtownModalClose = document.getElementById('valtown-modal-close');
const valtownModalProjectName = document.getElementById('valtown-modal-project-name');
const valtownOwnerEl = document.getElementById('valtown-owner');
const valtownNameEl = document.getElementById('valtown-name');
const valtownTokenEl = document.getElementById('valtown-token');
const valtownTokenStatusEl = document.getElementById('valtown-token-status');
const valtownSaveSettingsBtn = document.getElementById('valtown-save-settings-btn');
const valtownDownloadBtn = document.getElementById('valtown-download-btn');
const valtownUploadBtn = document.getElementById('valtown-upload-btn');
const valtownModalLogEl = document.getElementById('valtown-modal-log');

// Env Vars modal refs
const envvarsBtn = document.getElementById('envvars-btn');
const envvarsModalOverlay = document.getElementById('envvars-modal-overlay');
const envvarsModalClose = document.getElementById('envvars-modal-close');
const envvarsModalProjectName = document.getElementById('envvars-modal-project-name');
const envvarsTextareaEl = document.getElementById('envvars-textarea');
const envvarsSaveBtn = document.getElementById('envvars-save-btn');
const envvarsModalLogEl = document.getElementById('envvars-modal-log');

// --- Line-number gutter ---
function updateLineNumbers() {
  const lineCount = codeEditorEl.value.split('\n').length;
  let out = '';
  for (let i = 1; i <= lineCount; i++) out += i + '\n';
  lineNumbersEl.textContent = out.slice(0, -1); // drop the trailing newline
}

function setEditorValue(text) {
  codeEditorEl.value = text;
  updateLineNumbers();
  lineNumbersEl.scrollTop = codeEditorEl.scrollTop = 0;
}

codeEditorEl.addEventListener('input', updateLineNumbers);
codeEditorEl.addEventListener('scroll', () => {
  lineNumbersEl.scrollTop = codeEditorEl.scrollTop;
});

// --- State ---
let projects = {};
let activeProjectId = null;
let activeFileId = null;
let commandsRegistry = new Map(); // Node mode: name -> handler fn. Deno mode: name -> true (routing goes via IPC).
let denoWebhookMode = false; // true when Deno mode auto-detected a Val Town-style main.ts webhook handler

// --- Input modal (replaces window.prompt(), which Electron doesn't support) ---
let inputModalResolve = null;

function showInputModal({ title, label, value = '' }) {
  return new Promise((resolve) => {
    inputModalResolve = resolve;
    inputModalTitleEl.textContent = title;
    inputModalLabelEl.textContent = label;
    inputModalFieldEl.value = value;
    inputModalOverlay.classList.remove('hidden');
    inputModalFieldEl.focus();
    inputModalFieldEl.select();
  });
}

function closeInputModal(result) {
  inputModalOverlay.classList.add('hidden');
  if (inputModalResolve) {
    const resolve = inputModalResolve;
    inputModalResolve = null;
    resolve(result);
  }
}

inputModalOkBtn.addEventListener('click', () => closeInputModal(inputModalFieldEl.value));
inputModalCancelBtn.addEventListener('click', () => closeInputModal(null));
inputModalClose.addEventListener('click', () => closeInputModal(null));
inputModalOverlay.addEventListener('click', (e) => {
  if (e.target === inputModalOverlay) closeInputModal(null);
});
inputModalFieldEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    closeInputModal(inputModalFieldEl.value);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeInputModal(null);
  }
});

// --- Resizable panels (sidebar, file explorer, editor/chat split) ---
let uiPrefs = {};

function persistUiPrefs() {
  ipcRenderer.invoke('ui:setPrefs', uiPrefs);
}

function makeResizable(resizerEl, targetEl, { min, max, storageKey }) {
  if (!resizerEl || !targetEl) {
    console.error('makeResizable: missing element', { resizerEl, targetEl, storageKey });
    return;
  }
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  resizerEl.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = targetEl.getBoundingClientRect().width;
    resizerEl.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.min(max, Math.max(min, startWidth + delta));
    targetEl.style.width = newWidth + 'px';
    targetEl.style.flex = `0 1 ${newWidth}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizerEl.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    uiPrefs[storageKey] = Math.round(targetEl.getBoundingClientRect().width);
    persistUiPrefs();
  });
}

function applyUiPrefs(prefs) {
  uiPrefs = prefs || {};
  if (uiPrefs.sidebarWidth) {
    sidebarEl.style.width = uiPrefs.sidebarWidth + 'px';
  }
  if (uiPrefs.explorerWidth) {
    fileExplorerPanelEl.style.width = uiPrefs.explorerWidth + 'px';
  }
  if (uiPrefs.editorPaneWidth) {
    editorPaneEl.style.flex = `0 1 ${uiPrefs.editorPaneWidth}px`;
  }
}

makeResizable(sidebarResizerEl, sidebarEl, { min: 160, max: 480, storageKey: 'sidebarWidth' });
makeResizable(explorerResizerEl, fileExplorerPanelEl, { min: 120, max: 420, storageKey: 'explorerWidth' });
makeResizable(chatResizerEl, editorPaneEl, { min: 380, max: 1400, storageKey: 'editorPaneWidth' });

// --- Persistence ---
async function loadProjects() {
  projects = await ipcRenderer.invoke('projects:load');
  const ids = Object.keys(projects);
  renderProjectList();
  if (ids.length) {
    selectProject(ids[0]);
  } else {
    showEmptyProjectState();
  }
}

function persist() {
  ipcRenderer.invoke('projects:save', projects);
}

function showEmptyProjectState() {
  activeProjectId = null;
  activeFileId = null;
  activeProjectNameEl.textContent = 'No projects yet';
  fileTabsEl.innerHTML = '';
  setEditorValue('');
  chatLogEl.innerHTML = '';
  editorLogEl.innerHTML = '';
  commandsRegistry = new Map();
  setStatus('No project selected', null);
  setActionsEnabled(false);
  renderRuntimeToggle();
}

function setActionsEnabled(enabled) {
  importFileBtn.disabled = !enabled;
  loadCodeBtn.disabled = !enabled;
  clearChatBtn.disabled = !enabled;
  newFileBtn.disabled = !enabled;
  chatMessageEl.disabled = !enabled;
  runtimeNodeBtn.disabled = !enabled;
  runtimeDenoBtn.disabled = true; // desktop app only
  githubSyncBtn.disabled = !enabled;
  valtownSyncBtn.disabled = !enabled;
  envvarsBtn.disabled = !enabled;
}

// --- Runtime toggle (Node "fast" sandbox vs real Deno subprocess) ---
function renderRuntimeToggle() {
  const proj = projects[activeProjectId];
  const runtime = (proj && proj.runtime) || 'node';
  runtimeNodeBtn.classList.toggle('active', runtime === 'node');
  runtimeDenoBtn.classList.toggle('active', runtime === 'deno');
}

function setRuntime(runtime) {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  if (proj.runtime === runtime) return;
  proj.runtime = runtime;
  persist();
  renderRuntimeToggle();
  commandsRegistry = new Map();
  denoWebhookMode = false;
  editorLogEl.innerHTML = '';
  setStatus('No code loaded', null);
  ipcRenderer.invoke('deno:stop'); // harmless no-op if nothing was running
  logToEditor(`Switched to ${runtime === 'deno' ? 'Deno (real)' : 'Fast (Node)'} runtime — click "Load Code" to run.`, null);
}

runtimeNodeBtn.addEventListener('click', () => setRuntime('node'));
runtimeDenoBtn.addEventListener('click', () => setRuntime('deno'));

// --- Project list UI ---
function renderProjectList() {
  projectListEl.innerHTML = '';
  const ids = Object.keys(projects);

  if (!ids.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No projects — add one below.';
    projectListEl.appendChild(empty);
    return;
  }

  ids.forEach((id) => {
    const proj = projects[id];
    const li = document.createElement('li');
    li.className = id === activeProjectId ? 'active' : '';
    li.title = 'Click to open, double-click to rename';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'project-name';
    nameSpan.textContent = proj.label;
    li.appendChild(nameSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '\u2715';
    delBtn.title = 'Delete project';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProject(id);
    });
    li.appendChild(delBtn);

    li.addEventListener('click', () => selectProject(id));
    li.addEventListener('dblclick', () => renameProject(id));
    projectListEl.appendChild(li);
  });
}

function deleteProject(id) {
  const proj = projects[id];
  if (!proj) return;
  const ok = confirm(`Delete "${proj.label}"? This removes all its files and chat history and can't be undone.`);
  if (!ok) return;

  delete projects[id];
  persist();
  if (id === activeProjectId) sandboxRunner.stop();

  if (id === activeProjectId) {
    ipcRenderer.invoke('deno:stop');
    const remaining = Object.keys(projects);
    if (remaining.length) {
      selectProject(remaining[0]);
    } else {
      showEmptyProjectState();
      renderProjectList();
    }
  } else {
    renderProjectList();
  }
}

function selectProject(id) {
  saveActiveFileContent();
  sandboxRunner.stop();
  ipcRenderer.invoke('deno:stop'); // switching projects always stops any running Deno subprocess

  activeProjectId = id;
  const proj = projects[id];
  if (!proj.runtime) proj.runtime = 'node';
  activeProjectNameEl.textContent = proj.label;

  chatLogEl.innerHTML = '';
  (proj.history || []).forEach((line) => appendChatLine(line.who, line.text, line.kind, false));

  commandsRegistry = new Map();
  denoWebhookMode = false;
  editorLogEl.innerHTML = '';
  setStatus('No code loaded', null);
  setActionsEnabled(true);
  renderRuntimeToggle();

  const files = proj.files || [];
  if (files.length) {
    activeFileId = null; // force selectFile to skip the save-old-content step
    selectFile(files[0].id);
  } else {
    activeFileId = null;
    setEditorValue('');
    renderFileTabs();
  }

  renderProjectList();
  persist();
}

async function renameProject(id) {
  const proj = projects[id];
  const next = await showInputModal({ title: 'Rename Project', label: 'Project name:', value: proj.label });
  if (next && next.trim()) {
    proj.label = next.trim();
    if (id === activeProjectId) activeProjectNameEl.textContent = proj.label;
    renderProjectList();
    persist();
  }
}

addProjectBtn.addEventListener('click', async () => {
  const name = await showInputModal({ title: 'New Project', label: 'Project name:', value: '' });
  if (!name || !name.trim()) return;
  const id = 'proj_' + Date.now();
  projects[id] = {
    label: name.trim(),
    runtime: 'node',
    files: [{ id: 'file_' + Date.now(), name: 'main.js', content: '' }],
    history: []
  };
  renderProjectList();
  selectProject(id);
});

// --- File explorer UI (vertical list — projects like GuildScribe can have 15-20+ files) ---
function renderFileTabs() {
  fileTabsEl.innerHTML = '';
  const proj = projects[activeProjectId];
  const files = (proj && proj.files) || [];

  if (!files.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No files \u2014 click "+".';
    fileTabsEl.appendChild(empty);
    return;
  }

  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));

  sorted.forEach((file) => {
    const li = document.createElement('li');
    li.className = file.id === activeFileId ? 'active' : '';
    li.title = 'Click to edit, double-click to rename';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = file.name;
    li.appendChild(nameSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'file-delete-btn';
    delBtn.textContent = '\u2715';
    delBtn.title = 'Delete file';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFile(file.id);
    });
    li.appendChild(delBtn);

    li.addEventListener('click', () => selectFile(file.id));
    li.addEventListener('dblclick', () => renameFile(file.id));
    fileTabsEl.appendChild(li);
  });
}

function saveActiveFileContent() {
  if (!activeProjectId || !activeFileId) return;
  const proj = projects[activeProjectId];
  if (!proj) return;
  const file = (proj.files || []).find((f) => f.id === activeFileId);
  if (file) file.content = codeEditorEl.value;
}

function selectFile(fileId) {
  saveActiveFileContent();
  activeFileId = fileId;
  const proj = projects[activeProjectId];
  const file = (proj && proj.files || []).find((f) => f.id === fileId);
  setEditorValue(file ? file.content : '');
  renderFileTabs();
  persist();
}

function fileNameExists(proj, name, excludingId) {
  return (proj.files || []).some((f) => f.name === name && f.id !== excludingId);
}

function suggestFileName(proj) {
  if (!fileNameExists(proj, 'commands.js')) return 'commands.js';
  let n = 2;
  while (fileNameExists(proj, `file${n}.js`)) n++;
  return `file${n}.js`;
}

async function newFile() {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  const name = await showInputModal({ title: 'New File', label: 'File name:', value: suggestFileName(proj) });
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (fileNameExists(proj, trimmed)) {
    alert(`This project already has a file named "${trimmed}". Choose a different name (needed so Deno-mode imports between files resolve correctly).`);
    return;
  }
  proj.files = proj.files || [];
  const id = 'file_' + Date.now();
  proj.files.push({ id, name: trimmed, content: '' });
  renderFileTabs();
  selectFile(id);
}

newFileBtn.addEventListener('click', newFile);

async function renameFile(fileId) {
  const proj = projects[activeProjectId];
  const file = (proj && proj.files || []).find((f) => f.id === fileId);
  if (!file) return;
  const next = await showInputModal({ title: 'Rename File', label: 'File name:', value: file.name });
  if (!next || !next.trim()) return;
  const trimmed = next.trim();
  if (trimmed !== file.name && fileNameExists(proj, trimmed, fileId)) {
    alert(`This project already has a file named "${trimmed}".`);
    return;
  }
  file.name = trimmed;
  renderFileTabs();
  persist();
}

function deleteFile(fileId) {
  const proj = projects[activeProjectId];
  if (!proj) return;
  const file = (proj.files || []).find((f) => f.id === fileId);
  if (!file) return;
  const ok = confirm(`Delete file "${file.name}" from this project?`);
  if (!ok) return;

  proj.files = proj.files.filter((f) => f.id !== fileId);
  persist();

  if (fileId === activeFileId) {
    if (proj.files.length) {
      activeFileId = null; // skip saving stale content over the file we just deleted
      selectFile(proj.files[0].id);
    } else {
      activeFileId = null;
      setEditorValue('');
      renderFileTabs();
    }
  } else {
    renderFileTabs();
  }
}

// --- Status pill ---
function setStatus(text, kind) {
  statusPillEl.textContent = text;
  statusPillEl.className = 'status-pill' + (kind ? ' ' + kind : '');
}

// --- Editor log ---
function logToEditor(text, kind) {
  const line = document.createElement('div');
  line.textContent = text;
  if (kind) line.className = 'log-' + kind;
  editorLogEl.appendChild(line);
  editorLogEl.scrollTop = editorLogEl.scrollHeight;
}

// --- Chat log ---
function appendChatLine(who, text, kind, save = true) {
  const line = document.createElement('div');
  line.className = 'chat-line ' + kind;
  const whoSpan = document.createElement('span');
  whoSpan.className = 'who';
  whoSpan.textContent = who + ':';
  line.appendChild(whoSpan);
  line.appendChild(document.createTextNode(text));
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;

  if (save && activeProjectId && projects[activeProjectId]) {
    const proj = projects[activeProjectId];
    proj.history = proj.history || [];
    proj.history.push({ who, text, kind });
    if (proj.history.length > 300) proj.history.shift();
    persist();
  }
}

// --- Pushes from a running Deno subprocess ---
ipcRenderer.on('deno:system-line', (_event, text) => appendChatLine('Bot', text, 'bot'));
ipcRenderer.on('deno:log', (_event, { text, kind }) => logToEditor(text, kind === 'error' ? 'error' : null));

// --- Node "fast" sandbox: runs every file in the project, in tab order, ---
// --- against one shared vm context so files can reference each other.  ---
async function loadCodeNode(proj, files) {
  setStatus('Loading\u2026', null);
  loadCodeBtn.disabled = true;
  try {
    await loadTs();
  } catch (err) {
    loadCodeBtn.disabled = false;
    logToEditor(err.message, 'error');
    setStatus('Could not load', 'error');
    return;
  }

  let errorCount = 0;
  const sources = [];

  files.forEach((file) => {
    if (usesRealModuleSyntax(file.content, file.name)) {
      errorCount++;
      logToEditor(
        `${file.name} uses real import/export syntax between files \u2014 Fast mode's shared-scope model doesn't support genuine ES modules (no real per-file require/exports). Real ES modules need the desktop app's Deno (real) mode.`,
        'error',
      );
      return;
    }
    let source = file.content;
    if (/\.tsx?$/i.test(file.name)) {
      const transpiled = ts.transpileModule(file.content, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.None,
        },
        reportDiagnostics: true,
        fileName: file.name,
      });
      if (transpiled.diagnostics && transpiled.diagnostics.length) {
        errorCount++;
        const messages = transpiled.diagnostics
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
          .join('; ');
        logToEditor(`TypeScript error in ${file.name}: ${messages}`, 'error');
        return;
      }
      source = transpiled.outputText;
    }
    sources.push({ name: file.name, source });
  });

  const result = await sandboxRunner.load(sources, {
    onLog: (text, kind) => logToEditor(text, kind),
    onBotLine: (text) => appendChatLine('Bot', text, 'bot'),
    onRegister: (name) => {
      commandsRegistry.set(name.toLowerCase(), true);
      logToEditor(`Registered !${name}`, 'ok');
    },
    onFileError: (name, message) => {
      errorCount++;
      logToEditor(`Load error in ${name}: ${message}`, 'error');
    },
  });
  loadCodeBtn.disabled = false;

  if (result.timedOut) {
    commandsRegistry = new Map();
    logToEditor(result.error, 'error');
    setStatus('Load timed out', 'error');
    return;
  }

  if (errorCount) {
    setStatus(`${commandsRegistry.size} command(s) loaded, ${errorCount} file error(s)`, 'error');
  } else {
    setStatus(`${commandsRegistry.size} command(s) loaded from ${files.length} file(s) \u2014 Fast`, 'ok');
  }
}

// --- Deno "real" runtime: hands the files to the bundled deno binary via main.js ---
async function loadCodeDeno(proj, files) {
  setStatus('Starting Deno\u2026', null);
  loadCodeBtn.disabled = true;

  const result = await ipcRenderer.invoke('deno:load', { files, projectId: activeProjectId });

  loadCodeBtn.disabled = false;
  denoWebhookMode = !!result.webhookMode;

  if (!result.ok) {
    logToEditor('Deno failed to start: ' + result.error, 'error');
    setStatus('Deno failed to start', 'error');
    return;
  }

  if (denoWebhookMode) {
    commandsRegistry = new Map();
    logToEditor('Detected a Twitch EventSub webhook handler (main.ts) \u2014 every chat message (not just "!" ones) is now sent to it, exactly like a real EventSub notification.', 'ok');
    setStatus(`Webhook handler ready \u2014 Deno (real)`, 'ok');
  } else {
    commandsRegistry = new Map((result.commands || []).map((name) => [name, true]));
    setStatus(`${commandsRegistry.size} command(s) loaded from ${files.length} file(s) \u2014 Deno (real)`, 'ok');
  }
}

// Only these extensions are ever fed through the module loader / vm
// executor. Everything else (README.md, deno.json, .vtignore, .gitignore,
// .DS_Store, ...) is real project ephemera that's completely normal to
// have sitting in a project's files — it stays visible and editable in the
// file explorer, it's just never something you'd "run". Trying to run it
// only ever produces confusing, unfixable "Load error" noise (a .json file
// refused as a module, a .md file rejected outright, or — worse — a
// same-named deno.json silently colliding with the Deno-mode workspace's
// own reserved config file).
const EXECUTABLE_FILE_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;

// Fast mode runs every file in one shared vm scope with no real per-file
// module system — code written for THAT contract (no imports between
// files, everything just visible) works fine. Code written as genuine ES
// modules (the normal way any real Deno/Val Town project is written)
// doesn't: TypeScript's transpiler emits CommonJS-style output for real
// import/export syntax regardless of module settings (require(), an
// `exports` object, and qualified references like `utils_ts_1.foo()` for
// every cross-file reference) — none of which this sandbox provides, and
// simply stripping the import/export statements still leaves those
// now-undefined qualified references behind. Detecting this up front and
// pointing at Deno mode (which runs genuine ES modules correctly) is far
// more useful than the confusing "exports is not defined" / "already
// declared" errors that come out the other end otherwise.
function usesRealModuleSyntax(source, fileName) {
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
      /\.tsx?$/i.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
  } catch {
    return false; // let the real parse/transpile step below report the actual syntax error
  }
  let found = false;
  sourceFile.forEachChild((node) => {
    if (found) return;
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      found = true;
      return;
    }
    if (ts.canHaveModifiers(node)) {
      const mods = ts.getModifiers(node);
      if (mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) found = true;
    }
  });
  return found;
}

function loadCode() {
  saveActiveFileContent();
  sandboxRunner.stop();
  editorLogEl.innerHTML = '';
  commandsRegistry = new Map();
  denoWebhookMode = false;

  const proj = projects[activeProjectId];
  const allFiles = (proj && proj.files) || [];

  if (!allFiles.length) {
    logToEditor('No files to load.', 'error');
    setStatus('Nothing loaded', 'error');
    return;
  }

  const files = allFiles.filter((f) => EXECUTABLE_FILE_RE.test(f.name));
  const skipped = allFiles.filter((f) => !EXECUTABLE_FILE_RE.test(f.name));
  if (skipped.length) {
    logToEditor(`Skipping ${skipped.length} non-code file(s): ${skipped.map((f) => f.name).join(', ')}`, null);
  }

  if (!files.length) {
    logToEditor('No .js/.ts code files to load in this project.', 'error');
    setStatus('Nothing to load', 'error');
    return;
  }

  if (proj.runtime === 'deno') {
    loadCodeDeno(proj, files);
  } else {
    loadCodeNode(proj, files);
  }

  persist();
}

loadCodeBtn.addEventListener('click', loadCode);

// --- Multi-file import ---
importFileBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;

  const picked = await ipcRenderer.invoke('dialog:openFiles');
  if (!picked || !picked.length) return; // user cancelled

  const proj = projects[activeProjectId];
  proj.files = proj.files || [];

  const existingNames = new Set(proj.files.map((f) => f.name));
  const overwriteCount = picked.filter((f) => existingNames.has(f.fileName)).length;

  if (overwriteCount) {
    const ok = confirm(`${overwriteCount} imported file(s) share a name with files already in this project and will be overwritten. Continue?`);
    if (!ok) return;
  }

  let lastId = null;
  picked.forEach((f) => {
    const existing = proj.files.find((pf) => pf.name === f.fileName);
    if (existing) {
      existing.content = f.content;
      lastId = existing.id;
    } else {
      const id = 'file_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      proj.files.push({ id, name: f.fileName, content: f.content });
      lastId = id;
    }
  });

  persist();
  renderFileTabs();

  if (lastId === activeFileId) {
    // Already viewing the file that was just (re)imported — refresh the
    // textarea directly instead of routing through selectFile, which would
    // otherwise save the stale on-screen text back over the fresh import.
    const f = proj.files.find((pf) => pf.id === lastId);
    setEditorValue(f ? f.content : '');
  } else if (lastId) {
    selectFile(lastId);
  }

  logToEditor(`Imported ${picked.length} file(s) \u2014 click "Load Code" to run them.`, 'ok');
});

clearChatBtn.addEventListener('click', () => {
  chatLogEl.innerHTML = '';
  if (activeProjectId && projects[activeProjectId]) {
    projects[activeProjectId].history = [];
    persist();
  }
});

// --- Simulated chat submission ---
chatFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = chatMessageEl.value.trim();
  if (!message) return;
  const username = chatUsernameEl.value.trim() || 'viewer1';

  appendChatLine(username, message, 'user');
  chatMessageEl.value = '';

  const proj = projects[activeProjectId];
  const runtime = (proj && proj.runtime) || 'node';

  const ctxFlags = {
    isMod: chatModEl.checked,
    isSub: chatSubEl.checked,
    isBroadcaster: chatBroadcasterEl.checked,
  };

  // Webhook mode (a real Val Town-style Twitch EventSub bot, auto-detected
  // from main.ts): a real EventSub notification fires for EVERY chat
  // message, not just "!"-prefixed ones — the bot's own code decides what,
  // if anything, to do with it. So every message gets sent, and a message
  // producing no reply (most plain chat, for most bots) is just as correct
  // as one that does.
  if (runtime === 'deno' && denoWebhookMode) {
    const result = await ipcRenderer.invoke('deno:invoke', { message, user: username, ...ctxFlags });
    if (!result.ok) {
      appendChatLine('System', `Error: ${result.error}`, 'error');
      return;
    }
    (result.replies || []).forEach((text) => appendChatLine('Bot', text, 'bot'));
    return;
  }

  if (!message.startsWith('!')) return;

  const [rawName, ...args] = message.slice(1).split(/\s+/);
  const cmdName = rawName.toLowerCase();

  if (runtime === 'deno') {
    const result = await ipcRenderer.invoke('deno:invoke', {
      command: cmdName,
      user: username,
      args,
      message,
      ...ctxFlags,
    });

    if (!result.ok) {
      if (result.error === 'unknown-command') {
        appendChatLine('System', `Unknown command: !${cmdName}`, 'system');
      } else {
        appendChatLine('System', `Error in !${cmdName}: ${result.error}`, 'error');
      }
      return;
    }
    (result.replies || []).forEach((text) => appendChatLine('Bot', text, 'bot'));
    return;
  }

  // Fast mode: the command runs inside the sandbox worker, and its
  // ctx.reply()/ctx.say() lines arrive through onBotLine before this resolves.
  if (!commandsRegistry.has(cmdName)) {
    appendChatLine('System', `Unknown command: !${cmdName}`, 'system');
    return;
  }

  const result = await sandboxRunner.invoke(cmdName, { user: username, args, message, ...ctxFlags });
  if (!result.ok) {
    if (result.error === 'unknown-command') {
      appendChatLine('System', `Unknown command: !${cmdName}`, 'system');
    } else if (result.timedOut) {
      commandsRegistry = new Map();
      setStatus('Stopped \u2014 click Load Code', 'error');
      appendChatLine('System', result.error, 'error');
    } else {
      appendChatLine('System', `Error in !${cmdName}: ${result.error}`, 'error');
    }
  }
});

// --- GitHub Sync modal ---
function logToGithubModal(text, kind) {
  const line = document.createElement('div');
  line.textContent = text;
  if (kind) line.className = 'log-' + kind;
  githubModalLogEl.appendChild(line);
  githubModalLogEl.scrollTop = githubModalLogEl.scrollHeight;
}

async function refreshGithubTokenStatus() {
  const { hasToken } = await ipcRenderer.invoke('github:tokenStatus');
  githubTokenStatusEl.textContent = hasToken
    ? 'A token is currently saved (leave the field blank to keep it).'
    : 'No token saved yet \u2014 required for uploading; downloading a public repo works without one.';
  githubTokenStatusEl.className = 'modal-hint' + (hasToken ? ' ok' : ' warn');
}

function openGithubModal() {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  const gh = proj.github || {};
  githubModalProjectName.textContent = proj.label;
  githubOwnerEl.value = gh.owner || '';
  githubRepoEl.value = gh.repo || '';
  githubBranchEl.value = gh.branch || 'main';
  githubPathEl.value = gh.path || '';
  githubTokenEl.value = '';
  githubCommitMessageEl.value = '';
  githubModalLogEl.innerHTML = '';
  refreshGithubTokenStatus();
  githubModalOverlay.classList.remove('hidden');
}

function closeGithubModal() {
  githubModalOverlay.classList.add('hidden');
}

githubSyncBtn.addEventListener('click', openGithubModal);
githubModalClose.addEventListener('click', closeGithubModal);
githubModalOverlay.addEventListener('click', (e) => {
  if (e.target === githubModalOverlay) closeGithubModal();
});

function readGithubFormConfig() {
  return {
    owner: githubOwnerEl.value.trim(),
    repo: githubRepoEl.value.trim(),
    branch: githubBranchEl.value.trim() || 'main',
    // A leading/trailing slash is a normal way to write "from repo root" —
    // strip it rather than treat it as meaningful, so "/src", "src", and
    // "src/" are all equivalent.
    path: githubPathEl.value.trim().replace(/^\/+|\/+$/g, ''),
  };
}

// Catches the easy-to-make mistake of pasting a local folder location (e.g.
// from Explorer's address bar, or Windows Terminal's cwd) into Path, which
// is meant to be a location INSIDE the repo, not on disk — a Windows path
// there will always 404. A plain leading "/" is NOT one of these signals —
// that's a normal, common way to write a repo-root-relative path — so it's
// deliberately not checked here (readGithubFormConfig() above just strips it).
function looksLikeLocalPath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

githubSaveSettingsBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  const config = readGithubFormConfig();

  if (!config.owner || !config.repo) {
    logToGithubModal('Owner and Repo are required.', 'error');
    return;
  }

  proj.github = config;
  persist();
  logToGithubModal('Settings saved for this project.', 'ok');

  const tokenValue = githubTokenEl.value;
  if (tokenValue) {
    const result = await ipcRenderer.invoke('github:setToken', tokenValue);
    githubTokenEl.value = '';
    if (result && result.ok) {
      logToGithubModal(result.laptop ? 'Token saved on the laptop.' : 'Token saved in this browser only (not encrypted \u2014 sign in to keep it on the laptop instead).', 'ok');
    } else {
      logToGithubModal('Failed to save token.', 'error');
    }
    refreshGithubTokenStatus();
  }
});

githubDownloadBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  const config = readGithubFormConfig();

  if (!config.owner || !config.repo) {
    logToGithubModal('Owner and Repo are required.', 'error');
    return;
  }
  if (looksLikeLocalPath(config.path)) {
    logToGithubModal(`"Path" should be a location inside the repo (like "src", or blank for the repo root) \u2014 not a folder on your computer. "${config.path}" looks like a local path.`, 'error');
    return;
  }

  const ok = confirm(`Download from ${config.owner}/${config.repo} (${config.branch}${config.path ? ', path: ' + config.path : ''})?\n\nThis REPLACES this project's current files with what's in the repo.`);
  if (!ok) return;

  proj.github = config;
  persist();

  githubDownloadBtn.disabled = true;
  logToGithubModal(`Downloading from ${config.owner}/${config.repo}\u2026`, null);

  const result = await ipcRenderer.invoke('github:download', config);
  githubDownloadBtn.disabled = false;

  if (!result.ok) {
    logToGithubModal('Download failed: ' + result.error, 'error');
    return;
  }

  proj.files = result.files.map((f, i) => ({
    id: 'file_' + Date.now() + '_' + i,
    name: f.name,
    content: f.content,
  }));
  commandsRegistry = new Map();
  editorLogEl.innerHTML = '';
  setStatus('No code loaded', null);
  persist();

  activeFileId = null;
  if (proj.files.length) selectFile(proj.files[0].id);
  else renderFileTabs();

  logToGithubModal(`Downloaded ${result.files.length} file(s): ${result.files.map((f) => f.name).join(', ')}`, 'ok');
});

githubUploadBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;
  saveActiveFileContent(); // make sure the file currently on screen is included

  const proj = projects[activeProjectId];
  const config = readGithubFormConfig();

  if (!config.owner || !config.repo) {
    logToGithubModal('Owner and Repo are required.', 'error');
    return;
  }
  if (looksLikeLocalPath(config.path)) {
    logToGithubModal(`"Path" should be a location inside the repo (like "src", or blank for the repo root) \u2014 not a folder on your computer. "${config.path}" looks like a local path.`, 'error');
    return;
  }
  const files = proj.files || [];
  if (!files.length) {
    logToGithubModal('This project has no files to upload.', 'error');
    return;
  }

  proj.github = config;
  persist();

  githubUploadBtn.disabled = true;
  logToGithubModal(`Uploading ${files.length} file(s) to ${config.owner}/${config.repo}\u2026`, null);

  const result = await ipcRenderer.invoke('github:upload', {
    ...config,
    files: files.map((f) => ({ name: f.name, content: f.content })),
    commitMessage: githubCommitMessageEl.value.trim() || undefined,
  });
  githubUploadBtn.disabled = false;

  if (!result.ok) {
    logToGithubModal('Upload failed: ' + result.error, 'error');
    return;
  }

  logToGithubModal(`Committed as ${result.commitSha.slice(0, 7)}.`, 'ok');
  const link = document.createElement('div');
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = 'View commit on GitHub \u2192';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    ipcRenderer.invoke('shell:openExternal', result.commitUrl);
  });
  link.appendChild(a);
  githubModalLogEl.appendChild(link);
  githubModalLogEl.scrollTop = githubModalLogEl.scrollHeight;
});

// --- Val Town Sync modal ---
function logToValTownModal(text, kind) {
  const line = document.createElement('div');
  line.textContent = text;
  if (kind) line.className = 'log-' + kind;
  valtownModalLogEl.appendChild(line);
  valtownModalLogEl.scrollTop = valtownModalLogEl.scrollHeight;
}

async function refreshValTownTokenStatus() {
  const { hasToken } = await ipcRenderer.invoke('valtown:tokenStatus');
  valtownTokenStatusEl.textContent = hasToken
    ? 'A token is currently saved (leave the field blank to keep it). Also used to authenticate std/sqlite, std/blob, etc. inside Deno-mode runs.'
    : 'No token saved yet \u2014 required for uploading and for downloading private vals.';
  valtownTokenStatusEl.className = 'modal-hint' + (hasToken ? ' ok' : ' warn');
}

function openValTownModal() {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  const vt = proj.valtown || {};
  valtownModalProjectName.textContent = proj.label;
  valtownOwnerEl.value = vt.owner || '';
  valtownNameEl.value = vt.valName || '';
  valtownTokenEl.value = '';
  valtownModalLogEl.innerHTML = '';
  refreshValTownTokenStatus();
  valtownModalOverlay.classList.remove('hidden');
}

function closeValTownModal() {
  valtownModalOverlay.classList.add('hidden');
}

valtownSyncBtn.addEventListener('click', openValTownModal);
valtownModalClose.addEventListener('click', closeValTownModal);
valtownModalOverlay.addEventListener('click', (e) => {
  if (e.target === valtownModalOverlay) closeValTownModal();
});

function readValTownFormConfig() {
  return {
    owner: valtownOwnerEl.value.trim(),
    valName: valtownNameEl.value.trim(),
  };
}

valtownSaveSettingsBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  const config = readValTownFormConfig();

  if (!config.owner || !config.valName) {
    logToValTownModal('Owner and Val name are required.', 'error');
    return;
  }

  proj.valtown = config;
  persist();
  logToValTownModal('Settings saved for this project.', 'ok');

  const tokenValue = valtownTokenEl.value;
  if (tokenValue) {
    const result = await ipcRenderer.invoke('valtown:setToken', tokenValue);
    valtownTokenEl.value = '';
    if (result && result.ok) {
      logToValTownModal(result.laptop ? 'Token saved on the laptop.' : 'Token saved in this browser only (not encrypted \u2014 sign in to keep it on the laptop instead).', 'ok');
    } else {
      logToValTownModal('Failed to save token.', 'error');
    }
    refreshValTownTokenStatus();
  }
});

valtownDownloadBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  const config = readValTownFormConfig();

  if (!config.owner || !config.valName) {
    logToValTownModal('Owner and Val name are required.', 'error');
    return;
  }

  const ok = confirm(`Download from ${config.owner}/${config.valName}?\n\nThis REPLACES this project's current files with the val's root-level files. Subdirectories inside the val aren't synced.`);
  if (!ok) return;

  proj.valtown = config;
  persist();

  valtownDownloadBtn.disabled = true;
  logToValTownModal(`Downloading from ${config.owner}/${config.valName}\u2026`, null);

  const result = await ipcRenderer.invoke('valtown:download', config);
  valtownDownloadBtn.disabled = false;

  if (!result.ok) {
    logToValTownModal('Download failed: ' + result.error, 'error');
    return;
  }

  proj.files = result.files.map((f, i) => ({
    id: 'file_' + Date.now() + '_' + i,
    name: f.name,
    content: f.content,
  }));
  commandsRegistry = new Map();
  editorLogEl.innerHTML = '';
  setStatus('No code loaded', null);
  persist();

  activeFileId = null;
  if (proj.files.length) selectFile(proj.files[0].id);
  else renderFileTabs();

  logToValTownModal(`Downloaded ${result.files.length} file(s): ${result.files.map((f) => f.name).join(', ')}`, 'ok');
});

valtownUploadBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;
  saveActiveFileContent(); // make sure the file currently on screen is included

  const proj = projects[activeProjectId];
  const config = readValTownFormConfig();

  if (!config.owner || !config.valName) {
    logToValTownModal('Owner and Val name are required.', 'error');
    return;
  }
  const files = proj.files || [];
  if (!files.length) {
    logToValTownModal('This project has no files to upload.', 'error');
    return;
  }

  proj.valtown = config;
  persist();

  valtownUploadBtn.disabled = true;
  logToValTownModal(`Uploading ${files.length} file(s) to ${config.owner}/${config.valName}\u2026`, null);

  const result = await ipcRenderer.invoke('valtown:upload', {
    ...config,
    files: files.map((f) => ({ name: f.name, content: f.content })),
  });
  valtownUploadBtn.disabled = false;

  if (!result.ok) {
    logToValTownModal('Upload failed: ' + result.error, 'error');
    return;
  }

  logToValTownModal(`Uploaded ${result.uploaded} file(s).`, 'ok');
  const link = document.createElement('div');
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = 'View val on Val Town \u2192';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    ipcRenderer.invoke('shell:openValTown', result.valUrl);
  });
  link.appendChild(a);
  valtownModalLogEl.appendChild(link);
  valtownModalLogEl.scrollTop = valtownModalLogEl.scrollHeight;
});

ipcRenderer.invoke('ui:getPrefs').then(applyUiPrefs);
ipcRenderer.invoke('app:getVersion').then((version) => {
  document.getElementById('brand-version').textContent = 'v' + version;
});
// --- Env Vars modal (Deno mode only) ---
function logToEnvVarsModal(text, kind) {
  const line = document.createElement('div');
  line.textContent = text;
  if (kind) line.className = 'log-' + kind;
  envvarsModalLogEl.appendChild(line);
  envvarsModalLogEl.scrollTop = envvarsModalLogEl.scrollHeight;
}

async function openEnvVarsModal() {
  if (!activeProjectId) return;
  const proj = projects[activeProjectId];
  envvarsModalProjectName.textContent = proj.label;
  envvarsModalLogEl.innerHTML = '';
  envvarsTextareaEl.value = '';
  const { text } = await ipcRenderer.invoke('env:get', activeProjectId);
  envvarsTextareaEl.value = text || '';
  envvarsModalOverlay.classList.remove('hidden');
}

function closeEnvVarsModal() {
  envvarsModalOverlay.classList.add('hidden');
}

envvarsBtn.addEventListener('click', openEnvVarsModal);
envvarsModalClose.addEventListener('click', closeEnvVarsModal);
envvarsModalOverlay.addEventListener('click', (e) => {
  if (e.target === envvarsModalOverlay) closeEnvVarsModal();
});

envvarsSaveBtn.addEventListener('click', async () => {
  if (!activeProjectId) return;
  const result = await ipcRenderer.invoke('env:set', { projectId: activeProjectId, text: envvarsTextareaEl.value });
  if (result && result.ok) {
    logToEnvVarsModal('Saved. Takes effect next time you click "Load Code" in Deno mode.', 'ok');
  } else {
    logToEnvVarsModal('Failed to save.', 'error');
  }
});

loadProjects();
