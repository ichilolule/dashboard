(function (root) {
  'use strict';
  const Core = root.DashboardCalendarCore;
  const KEY = 'dashboardGoogleCalendar';
  const DEVICE_KEY = 'dashboardGoogleCalendarDevice';
  const SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const API_ROOT = 'https://www.googleapis.com/calendar/v3';
  function mount({ element, snapshot }) {
    if (!Core || !element) return null;
    let state;
    try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { state = {}; }
    let deviceId = localStorage.getItem(DEVICE_KEY);
    if (!deviceId) { deviceId = Core.uuid(); localStorage.setItem(DEVICE_KEY, deviceId); }
    state = { sourceId: Core.uuid(), clientId: '', calendarId: '', revision: '', auto: true, ...state, deviceId };
    let token = '', expiresAt = 0, running = false, pending = false, timer, expiryTimer, preparing = false, staleDocument = false;
    let scriptPromise;
    const listeners = [];
    element.innerHTML = `
      <h3>Googleカレンダーへ転記</h3>
      <p class="gcal-note">制作予定を専用カレンダーへ送ります。案件名・工程・期日・返信待ちを転記します。</p>
      <p class="gcal-note">接続中は変更を自動反映します。ページを閉じた後や認証期限切れの後は、再接続が必要です。</p>
      <div class="gcal-actions">
        <button type="button" class="reset-btn" data-action="connect">Googleに接続して転記</button>
        <button type="button" class="reset-btn" data-action="sync" disabled>今すぐ転記</button>
        <button type="button" class="reset-btn" data-action="disconnect" disabled>接続を停止</button>
      </div>
      <label class="gcal-auto"><input type="checkbox" data-field="auto"> 接続中の変更を自動で転記</label>
      <p class="gcal-status" role="status" aria-live="polite"></p>
      <p class="gcal-last"></p>
      <details class="gcal-setup">
        <summary>初回接続の設定</summary>
        <p class="gcal-note">初回のみ、Google連携用のクライアントIDを設定してください。</p>
        <label class="gcal-client">クライアントID<input type="text" data-field="client" autocomplete="off" spellcheck="false" placeholder="…apps.googleusercontent.com"></label>
        <button type="button" class="reset-btn" data-action="save">接続設定を保存</button>
        <p class="gcal-note">設定はJSONバックアップに含まれます。認証情報は含まれません。</p>
      </details>`;
    const q = selector => element.querySelector(selector);
    const connectButton = q('[data-action="connect"]');
    const syncButton = q('[data-action="sync"]');
    const disconnectButton = q('[data-action="disconnect"]');
    function setStatus(message, error = false) {
      q('.gcal-status').textContent = message;
      q('.gcal-status').dataset.error = String(error);
      refresh();
    }
    function save() {
      const { deviceId: ignored, ...persisted } = state;
      localStorage.setItem(KEY, JSON.stringify(persisted));
      refresh();
    }
    function authorized() { return !!token && Date.now() < expiresAt; }
    function refresh() {
      syncButton.disabled = !authorized() || running;
      connectButton.disabled = running || preparing;
      disconnectButton.disabled = !token || running;
      q('[data-action="save"]').disabled = running;
      q('[data-field="auto"]').checked = state.auto;
      q('.gcal-last').textContent = state.lastSyncedAt
        ? '最終同期：' + new Date(state.lastSyncedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + '（日本時間）'
        : 'まだGoogleへ転記していません。';
    }
    function disconnect(message = '接続を停止しました。Googleに転記済みの予定は残っています。') {
      token = ''; expiresAt = 0;
      clearTimeout(expiryTimer); clearTimeout(timer);
      setStatus(message);
    }
    function loadGoogle() {
      if (root.google?.accounts?.oauth2) return Promise.resolve();
      if (scriptPromise) return scriptPromise;
      scriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.onload = resolve;
        script.onerror = () => { scriptPromise = null; script.remove(); reject(new Error('Googleへの接続準備に失敗しました。通信を確認してください。')); };
        document.head.appendChild(script);
      });
      return scriptPromise;
    }
    async function prepare() {
      if (!state.clientId) {
        setStatus('初回接続の設定が必要です。');
        q('.gcal-setup').open = true;
        return;
      }
      preparing = true; refresh();
      try { await loadGoogle(); setStatus('接続ボタンからGoogleへ転記できます。'); }
      catch (error) { setStatus(error.message, true); }
      finally { preparing = false; refresh(); }
    }
    async function api(path, options = {}) {
      if (staleDocument) throw new Error('別のタブでデータが更新されました。ページを再読み込みしてください。');
      if (!authorized()) {
        disconnect('認証期限が切れました。「Googleに接続して転記」で再接続してください。');
        throw new Error('再接続が必要です。');
      }
      const method = options.method || 'GET';
      const headers = { Authorization: 'Bearer ' + token };
      if (options.body) headers['Content-Type'] = 'application/json';
      if (options.etag) headers['If-Match'] = options.etag;
      const response = await fetch(API_ROOT + path, { method, headers,
        body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) disconnect('Googleの認証が切れました。再接続してください。');
        const messages = {
          401: 'Googleへ再接続してください。',
          403: 'Googleの権限またはAPI設定を確認してください。',
          404: '転記先が見つかりません。接続先アカウントと専用カレンダーを確認してください。',
          409: '別の処理が同時に転記しました。もう一度転記してください。',
          412: '別の端末または操作によって予定が更新されました。転記を中止しました。',
          429: 'Googleの利用上限に達しました。少し待ってから転記してください。'
        };
        const error = new Error(messages[response.status] || 'Googleへの転記に失敗しました。もう一度転記してください。');
        error.status = response.status;
        error.reason = data.error?.errors?.[0]?.reason;
        throw error;
      }
      return response.status === 204 ? {} : response.json();
    }
    async function ensureCalendar() {
      if (state.calendarId) return;
      const marker = Core.APP + '; source=' + state.sourceId;
      const found = [];
      let page;
      do {
        const query = new URLSearchParams({ maxResults: '250', minAccessRole: 'owner' });
        if (page) query.set('pageToken', page);
        const result = await api('/users/me/calendarList?' + query);
        found.push(...(result.items || []).filter(item => item.description === marker && !item.primary));
        page = result.nextPageToken;
      } while (page);
      if (found.length > 1) throw new Error('専用カレンダーが重複しています。接続先の確認が必要です。');
      const calendar = found[0] || await api('/calendars', { method: 'POST', body: {
        summary: '制作予定（ダッシュボード）', description: marker, timeZone: 'Asia/Tokyo'
      } });
      state.calendarId = calendar.id;
      save();
    }
    async function runSync() {
      if (running) { pending = true; return; }
      if (!authorized()) { setStatus('変更をGoogleへ送るには再接続してください。'); return; }
      // Web Locks also prevent concurrent mutations from another tab of this site.
      if (!navigator.locks) { setStatus('このブラウザでは安全に同期できません。最新のSafariまたはChromeを使用してください。', true); return; }
      running = true; refresh();
      let failed = false;
      try {
        await navigator.locks.request('ichilole-dashboard-google-calendar', { ifAvailable: true }, async lock => {
          if (!lock) throw new Error('別のタブで転記中です。完了後にもう一度転記してください。');
          // Another tab may have completed a sync since this tab was opened.
          const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
          if (stored.sourceId === state.sourceId) state = { ...state, ...stored, deviceId };
          const current = snapshot();
          Core.buildEvents(current); // Validate before creating the destination calendar.
          setStatus('制作予定を転記しています…');
          await ensureCalendar();
          const result = await Core.synchronize({ api, state, snapshot: current, save,
            progress: (done, total) => setStatus('制作予定を転記しています… ' + done + ' / ' + total) });
          setStatus('転記完了：' + result.count + '件（追加' + result.created + '・変更' + result.updated + '・削除' + result.removed + '）');
        });
      } catch (error) {
        failed = true;
        const networkError = ['TimeoutError', 'TypeError'].includes(error.name);
        setStatus(networkError ? '通信を完了できませんでした。通信状況を確認し、もう一度転記してください。' : error.message, true);
      } finally {
        running = false; refresh();
        if (pending && !failed) { pending = false; changed(); }
        else pending = false;
      }
    }
    function changed() {
      clearTimeout(timer);
      if (!state.auto) return;
      if (running) { pending = true; return; }
      if (!authorized()) {
        if (state.calendarId) setStatus('未転記の変更があります。Googleへ接続して反映してください。');
        return;
      }
      timer = setTimeout(runSync, 2000);
    }
    function connect() {
      if (staleDocument) { setStatus('別のタブでデータが更新されました。ページを再読み込みしてください。', true); return; }
      if (!state.clientId || !root.google?.accounts?.oauth2) { prepare(); return; }
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        setStatus('Google連携は公開済みのダッシュボードURLから使用してください。', true); return;
      }
      root.google.accounts.oauth2.initTokenClient({
        client_id: state.clientId, scope: SCOPES, include_granted_scopes: false,
        callback: async response => {
          if (response.error || !response.access_token) { setStatus('Googleへの接続が許可されませんでした。', true); return; }
          if (!root.google.accounts.oauth2.hasGrantedAllScopes(response, ...SCOPES.split(' '))) {
            setStatus('制作予定の転記に必要な権限を許可してください。', true); return;
          }
          token = response.access_token;
          expiresAt = Date.now() + Math.max(0, Number(response.expires_in || 0) - 30) * 1000;
          clearTimeout(expiryTimer);
          expiryTimer = setTimeout(() => disconnect('認証期限が切れました。次の転記時に再接続してください。'), Math.max(0, expiresAt - Date.now()));
          try {
            const result = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
              { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
            if (!result.ok) throw new Error('Googleアカウントを確認できませんでした。');
            const profile = await result.json();
            if (typeof profile.sub !== 'string' || !profile.sub) throw new Error('Googleアカウントを確認できませんでした。');
            if (state.accountId && state.accountId !== profile.sub) throw new Error('以前と異なるGoogleアカウントです。元のアカウントへ接続してください。');
            state.accountId = profile.sub;
            save();
            runSync();
          } catch (error) { disconnect(error.message); }
        },
        error_callback: () => setStatus('接続画面を開けなかったか、接続がキャンセルされました。もう一度接続してください。', true)
      }).requestAccessToken({ prompt: '' });
    }
    connectButton.addEventListener('click', connect);
    syncButton.addEventListener('click', runSync);
    disconnectButton.addEventListener('click', () => disconnect());
    q('[data-field="auto"]').addEventListener('change', event => { state.auto = event.target.checked; save(); if (state.auto) changed(); });
    q('[data-action="save"]').addEventListener('click', () => {
      const clientId = q('[data-field="client"]').value.trim();
      if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
        setStatus('Google連携用のクライアントIDを入力してください。', true); return;
      }
      if (state.clientId && clientId !== state.clientId && state.calendarId) {
        setStatus('接続済みアプリの変更は、転記先の引き継ぎ確認が必要です。', true); return;
      }
      state.clientId = clientId; save(); prepare();
    });
    function on(target, event, callback) { target.addEventListener(event, callback); listeners.push([target, event, callback]); }
    on(root, 'online', changed);
    on(root, 'storage', event => {
      let dataChanged = ['cases', 'cfg', 'holidays'].includes(event.key);
      if (event.key === KEY) {
        try { dataChanged = JSON.parse(event.newValue || '{}').sourceId !== state.sourceId; }
        catch (_) { dataChanged = true; }
      }
      if (dataChanged) {
        staleDocument = true;
        disconnect('別のタブでデータが更新されました。このページを再読み込みしてから接続してください。');
      }
    });
    q('[data-field="client"]').value = state.clientId;
    save(); prepare();
    return {
      changed,
      exportConfig() {
        const { deviceId: ignored, pendingRevision: ignoredPending, ...backup } = state;
        return backup;
      },
      importConfig(value) {
        if (running) throw new Error('転記中です。完了してからJSONを読み込んでください。');
        disconnect('JSONを読み込みました。Googleへ接続すると、この予定を転記します。');
        if (value && /^[a-f0-9]{32}$/.test(value.sourceId || '')) {
          const allowed = ['sourceId', 'clientId', 'calendarId', 'revision', 'lastSyncedAt', 'accountId'];
          state = { sourceId: value.sourceId, auto: state.auto, deviceId };
          for (const key of allowed) if (typeof value[key] === 'string') state[key] = value[key];
        } else if (state.calendarId) {
          // Legacy backups carry no baseline. Never silently overwrite a newer cloud snapshot.
          state.revision = '';
        }
        state.pendingRevision = '';
        save(); q('[data-field="client"]').value = state.clientId || '';
        if (state.clientId) prepare();
      },
      isRunning: () => running
    };
  }
  root.DashboardCalendarUI = { mount };
})(window);
