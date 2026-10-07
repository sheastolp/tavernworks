// Web build: sign in, storage status and backups.
//
// Loaded after renderer.js, so it can use the renderer's top-level
// `projects`, `persist()` and `saveActiveFileContent()`. The storage itself
// lives in js/web-bridge.js (window.TBS_WEB.storage).
(function () {
  const storage = window.TBS_WEB.storage;
  const $ = (id) => document.getElementById(id);

  const storageLineEl = $('storage-line');
  const signinBtn = $('signin-btn');
  const signoutBtn = $('signout-btn');
  const backupsBtn = $('backups-btn');
  const reloadBtn = $('storage-reload-btn');

  const signinOverlay = $('signin-modal-overlay');
  const signinForm = $('signin-form');
  const signinPasswordEl = $('signin-password');
  const signinLogEl = $('signin-modal-log');

  const backupsOverlay = $('backups-modal-overlay');
  const backupsLaptopEl = $('backups-laptop');
  const backupsSignedOutEl = $('backups-signed-out');
  const backupsListEl = $('backups-list');
  const backupNowBtn = $('backup-now-btn');
  const backupDownloadBtn = $('backup-download-btn');
  const backupRestoreFileBtn = $('backup-restore-file-btn');
  const backupsLogEl = $('backups-modal-log');

  function log(el, text, kind) {
    const line = document.createElement('div');
    line.textContent = text;
    if (kind) line.className = 'log-' + kind;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  // --- Status line under the project list ---
  const LABELS = {
    local: ['Saved in this browser', ''],
    loading: ['Loading from the laptop…', ''],
    saved: ['Saved on the laptop', 'ok'],
    saving: ['Saving to the laptop…', ''],
    error: ['Not saved', 'error'],
    conflict: ['Changed elsewhere', 'error'],
    unreachable: ['Laptop unreachable', 'error'],
  };

  function renderStatus(status, message) {
    const { signedIn, movedToBackup } = storage.status;
    const [label, kind] = LABELS[status] || [status, ''];
    storageLineEl.className = 'storage-line' + (kind ? ' ' + kind : '');
    storageLineEl.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = label;
    storageLineEl.appendChild(strong);
    let note = message;
    if (!note && status === 'local') note = 'Sign in to keep projects on the laptop instead, with automatic backups.';
    if (!note && status === 'saved' && movedToBackup) note = 'This browser’s old projects were kept on the laptop as a backup and removed from the browser.';
    if (note) {
      const span = document.createElement('span');
      span.textContent = note;
      storageLineEl.appendChild(span);
    }
    const signedInish = signedIn || status === 'unreachable';
    signinBtn.hidden = signedInish;
    signoutBtn.hidden = !signedInish;
    reloadBtn.hidden = !(status === 'conflict' || status === 'unreachable');
  }

  storage.onStatus(renderStatus);

  // --- Sign in / out ---
  function openSignin() {
    signinLogEl.innerHTML = '';
    signinPasswordEl.value = '';
    if (!storage.status.hasServer) log(signinLogEl, 'No server address is set for this site yet.', 'error');
    signinOverlay.classList.remove('hidden');
    signinPasswordEl.focus();
  }
  const closeSignin = () => signinOverlay.classList.add('hidden');

  signinBtn.addEventListener('click', openSignin);
  $('signin-modal-close').addEventListener('click', closeSignin);
  signinOverlay.addEventListener('click', (e) => { if (e.target === signinOverlay) closeSignin(); });

  signinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = signinForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    signinLogEl.innerHTML = '';
    log(signinLogEl, 'Checking…');
    try {
      saveActiveFileContent();
      persist();
      await storage.signIn(signinPasswordEl.value);
      log(signinLogEl, 'Signed in. Moving to the laptop…', 'ok');
      location.reload();
    } catch (err) {
      signinLogEl.innerHTML = '';
      log(signinLogEl, err.message, 'error');
      submit.disabled = false;
    }
  });

  signoutBtn.addEventListener('click', async () => {
    if (storage.hasUnsaved()) {
      await storage.flush();
      if (storage.hasUnsaved() && !confirm('Some changes haven’t reached the laptop yet. Sign out anyway and lose them?')) return;
    }
    if (!confirm('Sign out? Your projects stay on the laptop. This browser goes back to its own (empty) copy until you sign in again.')) return;
    storage.signOut();
    location.reload();
  });

  reloadBtn.addEventListener('click', () => location.reload());

  // --- Save while typing (the desktop app only saves on file switch / Load Code) ---
  let typingTimer = null;
  $('code-editor').addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      saveActiveFileContent();
      persist();
    }, 1000);
  });

  // --- Backups ---
  const KIND_LABELS = { auto: 'Automatic', manual: 'Manual', restore: 'Before a restore', import: 'Imported' };

  function formatWhen(iso) {
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function downloadJson(data, fileName) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const backupFile = (projectsData, prefs, at) => ({
    app: 'TwitchBotSandbox',
    format: 1,
    exportedAt: at || new Date().toISOString(),
    projects: projectsData,
    prefs: prefs || {},
  });

  const fileStamp = (iso) => (iso || new Date().toISOString()).slice(0, 16).replace(/[:T]/g, '-');

  function makeButton(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  async function renderBackupList() {
    backupsListEl.innerHTML = '';
    let backups;
    try {
      backups = await storage.listBackups();
    } catch (err) {
      log(backupsLogEl, 'Couldn’t list backups: ' + err.message, 'error');
      return;
    }
    if (!backups.length) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.textContent = 'No backups yet. The first one is made automatically as you work.';
      backupsListEl.appendChild(li);
      return;
    }
    backups.forEach((b) => {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'backup-info';
      const when = document.createElement('strong');
      when.textContent = formatWhen(b.at);
      const meta = document.createElement('span');
      meta.textContent = `${KIND_LABELS[b.kind] || b.kind} · ${b.projects} project${b.projects === 1 ? '' : 's'} · ${Math.max(1, Math.round(b.size / 1024))} KB`;
      info.append(when, meta);

      const actions = document.createElement('div');
      actions.className = 'backup-actions';
      actions.append(
        makeButton('Restore', 'ghost-btn', async () => {
          if (!confirm(`Restore the backup from ${formatWhen(b.at)}?\n\nThis replaces your current projects. What you have now is kept as a backup first, so you can undo it.`)) return;
          try {
            await storage.restoreBackup(b.id);
            location.reload();
          } catch (err) {
            log(backupsLogEl, 'Restore failed: ' + err.message, 'error');
          }
        }),
        makeButton('Download', 'ghost-btn', async () => {
          try {
            const data = await storage.getBackup(b.id);
            downloadJson(backupFile(data.projects, data.prefs, data.at), `twitchbotsandbox-${fileStamp(data.at)}.json`);
          } catch (err) {
            log(backupsLogEl, 'Download failed: ' + err.message, 'error');
          }
        }),
        makeButton('✕', 'icon-btn', async () => {
          if (!confirm(`Delete the backup from ${formatWhen(b.at)}? This can't be undone.`)) return;
          try {
            await storage.deleteBackup(b.id);
            renderBackupList();
          } catch (err) {
            log(backupsLogEl, 'Delete failed: ' + err.message, 'error');
          }
        }),
      );
      actions.lastChild.title = 'Delete this backup';
      li.append(info, actions);
      backupsListEl.appendChild(li);
    });
  }

  function openBackups() {
    backupsLogEl.innerHTML = '';
    const { signedIn } = storage.status;
    backupsLaptopEl.hidden = !signedIn;
    backupsSignedOutEl.hidden = signedIn;
    backupsOverlay.classList.remove('hidden');
    if (signedIn) renderBackupList();
  }
  const closeBackups = () => backupsOverlay.classList.add('hidden');

  backupsBtn.addEventListener('click', openBackups);
  $('backups-modal-close').addEventListener('click', closeBackups);
  backupsOverlay.addEventListener('click', (e) => { if (e.target === backupsOverlay) closeBackups(); });
  $('backups-signin-link').addEventListener('click', (e) => {
    e.preventDefault();
    closeBackups();
    openSignin();
  });

  backupNowBtn.addEventListener('click', async () => {
    backupNowBtn.disabled = true;
    try {
      saveActiveFileContent();
      persist();
      await storage.flush();
      await storage.backupNow();
      log(backupsLogEl, 'Backed up.', 'ok');
      renderBackupList();
    } catch (err) {
      log(backupsLogEl, 'Backup failed: ' + err.message, 'error');
    }
    backupNowBtn.disabled = false;
  });

  backupDownloadBtn.addEventListener('click', () => {
    saveActiveFileContent();
    persist();
    downloadJson(backupFile(projects, typeof uiPrefs === 'object' ? uiPrefs : {}), `twitchbotsandbox-${fileStamp()}.json`);
    log(backupsLogEl, 'Downloaded. The file has your projects and layout, never your GitHub or Val Town tokens.', 'ok');
  });

  backupRestoreFileBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        log(backupsLogEl, `${file.name} isn't a backup file (not valid JSON).`, 'error');
        return;
      }
      const restored = data && data.projects && typeof data.projects === 'object' ? data.projects : null;
      const valid = restored && Object.values(restored).every((p) => p && typeof p.label === 'string' && Array.isArray(p.files));
      if (!valid) {
        log(backupsLogEl, `${file.name} isn't a TwitchBotSandbox backup.`, 'error');
        return;
      }
      const count = Object.keys(restored).length;
      const where = storage.status.signedIn
        ? 'What you have now is kept on the laptop as a backup first.'
        : 'What’s in this browser now will be gone (download a backup first if you want to keep it).';
      if (!confirm(`Restore ${count} project${count === 1 ? '' : 's'} from ${file.name}?\n\nThis replaces your current projects. ${where}`)) return;
      try {
        await storage.restoreFromData({ projects: restored, prefs: data.prefs });
        location.reload();
      } catch (err) {
        log(backupsLogEl, 'Restore failed: ' + err.message, 'error');
      }
    });
    input.click();
  });
})();
