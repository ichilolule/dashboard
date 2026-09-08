(function (root) {
  'use strict';

  const FILE_NAME = 'dashboard_sync.json';
  const DB_NAME = 'ichilole-dashboard-backup-v1';
  const STORE_NAME = 'handles';
  const RECORD_ID = 'icloud-json';
  const SETTINGS_KEY = 'dashboardICloudBackup';

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('ブラウザ保存領域を読み込めませんでした。'));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME))
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('ブラウザ保存領域を開けませんでした。'));
    });
  }

  async function readRecord() {
    const database = await openDatabase();
    try {
      return await requestResult(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(RECORD_ID));
    } finally { database.close(); }
  }

  async function writeRecord(record) {
    const database = await openDatabase();
    try {
      await requestResult(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({
        id: RECORD_ID,
        ...record
      }));
    } finally { database.close(); }
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  function parseBackup(text) {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || (!Array.isArray(value.cases) && !Array.isArray(value.archive)))
      throw new Error('案件管理ダッシュボードのJSONではありません。');
    return value;
  }

  function comparableBackup(value) {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.exported;
    return JSON.stringify(copy);
  }

  function readSettings() {
    try { return { auto: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
    catch (_) { return { auto: true }; }
  }

  function mount({ element, shortcutButton, snapshot, download, importText, isBusy }) {
    if (!element || typeof snapshot !== 'function') return null;
    const supported = typeof root.showSaveFilePicker === 'function' && !!root.indexedDB && !!root.crypto?.subtle;
    let settings = readSettings();
    let handle = null, baselineHash = '', timer = null, writing = false, conflict = false;
    let readyDone = false, persistenceWarning = false;

    element.innerHTML = `
      <h3>iCloud DriveへJSON保存</h3>
      <p class="gcal-note">Chromeの保存画面でiCloud Drive内の <strong>${FILE_NAME}</strong> を一度選ぶと、以後は同じ正本へ直接上書きします。</p>
      <p class="gcal-note">JSONには案件・連絡先・請求書設定などが含まれます。ご自身の非公開フォルダを選んでください。</p>
      <div class="gcal-actions">
        <button type="button" class="reset-btn" data-action="choose">iCloud保存先を設定</button>
        <button type="button" class="reset-btn" data-action="save" disabled>今すぐ上書き保存</button>
        <button type="button" class="reset-btn" data-action="load" hidden>iCloud側を読み込む</button>
        <button type="button" class="reset-btn" data-action="download">通常ダウンロード</button>
      </div>
      <label class="gcal-auto"><input type="checkbox" data-field="auto"> 変更時に自動で上書き保存</label>
      <p class="gcal-status" data-role="status" role="status" aria-live="polite"></p>
      <p class="gcal-last" data-role="last"></p>`;

    const q = selector => element.querySelector(selector);
    const chooseButton = q('[data-action="choose"]');
    const saveButton = q('[data-action="save"]');
    const loadButton = q('[data-action="load"]');
    const autoField = q('[data-field="auto"]');

    function saveSettings() {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function setStatus(message, kind = 'ready') {
      const status = q('[data-role="status"]');
      status.textContent = message;
      status.dataset.error = String(['error', 'conflict'].includes(kind));
      status.dataset.kind = kind;
      refresh();
    }

    function refresh() {
      const busy = writing || !!isBusy?.();
      chooseButton.textContent = handle ? '保存先を変更' : 'iCloud保存先を設定';
      chooseButton.disabled = writing || !readyDone;
      saveButton.disabled = !readyDone || !handle || busy || conflict;
      loadButton.hidden = !handle;
      loadButton.disabled = !readyDone || busy;
      autoField.checked = settings.auto;
      autoField.disabled = !supported || !handle || conflict;
      q('[data-role="last"]').textContent = settings.lastSavedAt
        ? '最終保存：' + new Date(settings.lastSavedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + '（日本時間）'
        : 'まだiCloud用の正本へ保存していません。';
      if (shortcutButton) {
        const kind = q('[data-role="status"]').dataset.kind || (handle ? 'ready' : 'unconfigured');
        shortcutButton.disabled = !readyDone || busy;
        shortcutButton.dataset.state = writing ? 'saving' : kind;
        shortcutButton.title = q('[data-role="status"]').textContent || 'JSONを保存';
        const label = shortcutButton.querySelector('.backup-shortcut-label');
        if (label) label.textContent = writing ? '保存中…' : 'JSON保存';
      }
    }

    async function persistHandle() {
      if (!handle) return;
      try {
        await writeRecord({ handle, baselineHash, savedAt: settings.lastSavedAt || '' });
        persistenceWarning = false;
      } catch (_) {
        persistenceWarning = true;
      }
    }

    async function permission(grant) {
      if (!handle) return false;
      let result = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      if (result !== 'granted' && grant)
        result = await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      return result === 'granted';
    }

    async function currentFileText(target = handle) {
      const file = await target.getFile();
      return file.size ? file.text() : '';
    }

    function serializeSnapshot() {
      const text = JSON.stringify(snapshot(), null, 2);
      parseBackup(text);
      return text;
    }

    async function writeSnapshot() {
      if (!handle || writing || conflict) return false;
      if (isBusy?.()) { changed({ delay: 500 }); return false; }
      if (!await permission(false)) {
        setStatus('Chromeのファイルアクセスが切れています。「今すぐ上書き保存」で再許可してください。', 'permission');
        return false;
      }
      writing = true; refresh();
      try {
        const operation = async () => {
          const diskText = await currentFileText();
          const diskHash = await sha256(diskText);
          if (!baselineHash || diskHash !== baselineHash) {
            conflict = true;
            setStatus('iCloud側のJSONが別の操作で更新されています。自動保存を停止しました。iCloud側を読み込むか、保存先を再設定してください。', 'conflict');
            return false;
          }
          const text = serializeSnapshot();
          const writable = await handle.createWritable();
          try {
            await writable.write(text);
            await writable.close();
          } catch (error) {
            await writable.abort?.().catch(() => {});
            throw error;
          }
          baselineHash = await sha256(text);
          settings.lastSavedAt = new Date().toISOString();
          saveSettings();
          await persistHandle();
          setStatus(persistenceWarning
            ? '上書き保存しました。このタブを閉じた後は保存先の再設定が必要です。'
            : `${FILE_NAME} を上書き保存しました。`, persistenceWarning ? 'permission' : 'saved');
          return true;
        };
        if (navigator.locks) {
          let result = false;
          await navigator.locks.request('ichilole-dashboard-icloud-json', { ifAvailable: true }, async lock => {
            if (!lock) {
              setStatus('別のタブでJSONを保存中です。完了後にもう一度お試しください。', 'error');
              return;
            }
            result = await operation();
          });
          return result;
        }
        return operation();
      } catch (error) {
        const message = error?.name === 'NotReadableError'
          ? 'iCloudからファイルを読み込めませんでした。Finderでダウンロード完了を確認してください。'
          : 'JSONを上書き保存できませんでした。iCloud DriveとChromeの権限を確認してください。';
        setStatus(message, 'error');
        return false;
      } finally { writing = false; refresh(); }
    }

    async function chooseFromGesture() {
      if (!supported) { download?.(); return false; }
      let nextHandle;
      try {
        nextHandle = await root.showSaveFilePicker({
          id: 'ichilole-dashboard-json', suggestedName: FILE_NAME,
          types: [{ description: 'JSONバックアップ', accept: { 'application/json': ['.json'] } }]
        });
      } catch (error) {
        if (error?.name !== 'AbortError') setStatus('保存先を選択できませんでした。', 'error');
        return false;
      }
      if (nextHandle.name !== FILE_NAME) {
        setStatus(`正本のファイル名は ${FILE_NAME} にしてください。`, 'error');
        return false;
      }
      try {
        const diskText = await currentFileText(nextHandle);
        let diskValue = null;
        if (diskText) diskValue = parseBackup(diskText);
        const localValue = parseBackup(serializeSnapshot());
        if (diskValue && comparableBackup(diskValue) !== comparableBackup(localValue) &&
            !confirm(`選択した ${FILE_NAME} には異なるデータがあります。\n現在のダッシュボードの内容で上書きしますか？`)) {
          setStatus('保存先の設定を取り消しました。必要なら先にiCloud側のJSONを読み込んでください。', 'ready');
          return false;
        }
        handle = nextHandle;
        baselineHash = await sha256(diskText);
        conflict = false;
        await persistHandle();
        refresh();
        return writeSnapshot();
      } catch (error) {
        setStatus(error instanceof SyntaxError || error?.message?.includes('ダッシュボード')
          ? '選択した既存ファイルは有効なダッシュボードJSONではありません。別の保存先を選んでください。'
          : '保存先を準備できませんでした。iCloud Driveの状態を確認してください。', 'error');
        return false;
      }
    }

    async function saveFromGesture() {
      if (!supported) { download?.(); return false; }
      if (!readyDone) await ready;
      if (!handle) return chooseFromGesture();
      if (conflict) {
        setStatus('外部更新を検知しているため上書きしません。iCloud側を読み込むか、保存先を再設定してください。', 'conflict');
        return false;
      }
      if (!await permission(true)) {
        setStatus('ファイルアクセスが許可されませんでした。通常ダウンロードは引き続き利用できます。', 'permission');
        return false;
      }
      return writeSnapshot();
    }

    async function adoptImportedText(text) {
      if (!handle) return false;
      try {
        const diskText = await currentFileText();
        const [diskHash, importedHash] = await Promise.all([sha256(diskText), sha256(text)]);
        if (diskHash !== importedHash) return false;
        baselineHash = diskHash;
        conflict = false;
        await persistHandle();
        setStatus('iCloud側のJSONを読み込みました。変更時の自動保存を再開します。', 'ready');
        changed({ immediate: true });
        return true;
      } catch (_) { return false; }
    }

    async function loadFromHandle() {
      if (!handle || !await permission(true)) {
        setStatus('iCloud側を読むためのファイルアクセスが許可されませんでした。', 'permission');
        return false;
      }
      try {
        const text = await currentFileText();
        parseBackup(text);
        if (!await importText?.(text)) return false;
        return adoptImportedText(text);
      } catch (error) {
        setStatus(error instanceof SyntaxError || error?.message?.includes('ダッシュボード')
          ? 'iCloud側のファイルは有効なダッシュボードJSONではありません。'
          : 'iCloud側のファイルを読み込めませんでした。', 'error');
        return false;
      }
    }

    function changed(options = {}) {
      clearTimeout(timer);
      if (!settings.auto || !handle || conflict) return;
      const delay = options.immediate ? 0 : Number(options.delay ?? 1500);
      timer = setTimeout(() => {
        if (isBusy?.()) { changed({ delay: 500 }); return; }
        writeSnapshot();
      }, delay);
    }

    chooseButton.addEventListener('click', chooseFromGesture);
    saveButton.addEventListener('click', saveFromGesture);
    loadButton.addEventListener('click', loadFromHandle);
    q('[data-action="download"]').addEventListener('click', () => download?.());
    autoField.addEventListener('change', event => {
      settings.auto = event.target.checked;
      saveSettings();
      if (settings.auto) changed({ immediate: true });
    });
    shortcutButton?.addEventListener('click', saveFromGesture);

    const ready = (async () => {
      if (!supported) {
        readyDone = true;
        setStatus('このブラウザでは直接上書きできません。Chromeの最新版、または通常ダウンロードを使用してください。', 'unsupported');
        return;
      }
      try {
        const record = await readRecord();
        if (record?.handle?.name === FILE_NAME && record.baselineHash) {
          handle = record.handle;
          baselineHash = record.baselineHash;
          if (record.savedAt && !settings.lastSavedAt) settings.lastSavedAt = record.savedAt;
          const granted = await permission(false);
          setStatus(granted
            ? `${FILE_NAME} への自動保存を利用できます。`
            : '保存先を記憶しています。「今すぐ上書き保存」でChromeのアクセスを再許可してください。', granted ? 'ready' : 'permission');
        } else {
          setStatus('最初にiCloud Drive内の保存先を設定してください。', 'unconfigured');
        }
      } catch (_) {
        setStatus('保存先の記憶を読み込めませんでした。もう一度設定してください。', 'error');
      } finally { readyDone = true; refresh(); }
    })();

    refresh();
    return { changed, saveFromGesture, chooseFromGesture, loadFromHandle, adoptImportedText, ready,
      isWriting: () => writing, hasConflict: () => conflict };
  }

  root.DashboardBackupFile = { mount };
})(window);
