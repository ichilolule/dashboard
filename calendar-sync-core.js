/* Pure calendar projection and guarded one-way reconciliation. No account secrets. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DashboardCalendarCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const APP = 'ichilole-dashboard-calendar-v1';
  const LABELS = { rough: '大ラフ', line: '清書前ラフ', clean: '清書', retouch: 'レタッチ' };
  const SOURCE_URL = 'https://ichilolule.github.io/dashboard/';
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
      Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  }
  function nextDay(value) {
    if (!validDate(value)) throw new Error('予定の日付が不正です。転記を中止しました。');
    const date = new Date(value + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }
  function name(value) { return String(value || '名称未設定').replace(/[\r\n]/g, ' ').slice(0, 180); }
  function buildEvents(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.cases) || !snapshot.schedule || !validDate(snapshot.today))
      throw new Error('予定を取得できませんでした。Googleの予定は変更していません。');
    const events = [];
    function add(key, date, title, detail) {
      events.push({ key, date, title: title.slice(0, 800), detail });
    }
    for (const date of Object.keys(snapshot.schedule).sort()) {
      const day = snapshot.schedule[date];
      if (!validDate(date) || !day) throw new Error('作業予定の日付が不正です。');
      if (date < snapshot.today) continue;
      for (const slot of ['morning', 'night']) {
        const task = day[slot];
        if (!task) continue;
        if (!LABELS[task.kind]) throw new Error('未知の制作工程があるため転記を中止しました。');
        const period = slot === 'morning' ? '朝昼' : '夜';
        add('work:' + date + ':' + slot, date,
          '［' + period + '］' + name(task.caseName) + '・' + LABELS[task.kind],
          '自動配置された作業計画です。実績・確定時刻ではありません。\n枠：' + period +
          '\n工程：' + LABELS[task.kind] + '\n案件：' + name(task.caseName));
      }
      if (day.wait && day.wait.length) {
        const names = day.wait.map(task => name(task.caseName));
        add('wait:' + date, date, '［返信待ち］' + names.join('／'),
          'ダッシュボード上の返信待ち表示です。\n' + names.join('\n'));
      }
    }
    for (const [field, prefix] of [['deadline', '納期'], ['paydue', '支払期限']]) {
      const dates = new Map();
      for (const item of snapshot.cases) {
        if (!item[field] || (field === 'paydue' && item.paid === '入金済み')) continue;
        if (!validDate(item[field])) throw new Error('案件の期日が不正です。');
        if (!dates.has(item[field])) dates.set(item[field], []);
        dates.get(item[field]).push(name(item.name));
      }
      for (const [date, names] of [...dates].sort())
        add(field + ':' + date, date, '［' + prefix + '］' + names.join('／'),
          prefix + '：' + date + '\n' + names.join('\n'));
    }
    if (events.length > 2500) throw new Error('予定が2,500件を超えています。転記範囲の確認が必要です。');
    return events.sort((a, b) => a.key.localeCompare(b.key));
  }
  function body(event, sourceId) {
    return {
      summary: event.title,
      description: event.detail + '\n\n編集元：' + SOURCE_URL +
        '\nGoogle側は参照用コピーです。制作予定の更新状況も併せて確認してください。',
      start: { date: event.date }, end: { date: nextDay(event.date) },
      transparency: 'transparent', visibility: 'private',
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { dashboardApp: APP, dashboardSource: sourceId, dashboardKey: event.key } }
    };
  }
  function owned(event, sourceId) {
    const p = event.extendedProperties && event.extendedProperties.private;
    return event.status !== 'cancelled' && p && p.dashboardApp === APP && p.dashboardSource === sourceId;
  }
  function equal(remote, desired) {
    return remote.summary === desired.summary && remote.description === desired.description &&
      remote.start?.date === desired.start.date && remote.end?.date === desired.end.date &&
      !remote.start?.dateTime && !remote.end?.dateTime &&
      remote.transparency === 'transparent' && remote.visibility === 'private' &&
      remote.reminders?.useDefault === false && !(remote.reminders?.overrides || []).length;
  }
  function diff(remote, desired, sourceId) {
    const byKey = new Map(), changes = { create: [], update: [], remove: [] };
    for (const item of remote) {
      if (!owned(item, sourceId)) continue;
      const key = item.extendedProperties.private.dashboardKey;
      if (key === 'status') continue;
      if (byKey.has(key)) changes.remove.push(item);
      else byKey.set(key, item);
    }
    for (const item of desired) {
      const previous = byKey.get(item.extendedProperties.private.dashboardKey);
      if (!previous) changes.create.push(item);
      else {
        if (!equal(previous, item)) changes.update.push({ previous, item });
        byKey.delete(item.extendedProperties.private.dashboardKey);
      }
    }
    changes.remove.push(...byKey.values());
    return changes;
  }
  function uuid() { return globalThis.crypto.randomUUID().replace(/-/g, ''); }
  async function digest(value) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function statusBody(today, sourceId, properties, complete, timestamp) {
    const item = body({ key: 'status', date: today, title: '制作予定の更新状況',
      detail: complete
        ? '最終同期：' + timestamp + '\nこの日時にダッシュボードから転記された計画です。'
        : '転記処理中です。中断した場合は元の端末で再接続して転記を完了してください。' }, sourceId);
    Object.assign(item.extendedProperties.private, properties);
    return item;
  }
  // api(path, {method, body, etag}) is injected so reconciliation can be tested offline.
  async function synchronize({ api, state, snapshot, save, progress = () => {}, now = () => new Date() }) {
    const desired = buildEvents(snapshot).map(event => body(event, state.sourceId));
    if (!/^[a-f0-9]{32}$/.test(state.sourceId || '') || !state.deviceId)
      throw new Error('転記元の識別情報がありません。');
    if (!state.calendarId || !state.calendarId.endsWith('@group.calendar.google.com'))
      throw new Error('制作予定専用カレンダーを接続してください。');
    const base = '/calendars/' + encodeURIComponent(state.calendarId) + '/events';
    const remote = [];
    let page;
    do {
      const query = new URLSearchParams({ maxResults: '2500', privateExtendedProperty: 'dashboardSource=' + state.sourceId });
      if (page) query.set('pageToken', page);
      const result = await api(base + '?' + query);
      remote.push(...(result.items || []));
      page = result.nextPageToken;
    } while (page);
    const markers = remote.filter(item => owned(item, state.sourceId) && item.extendedProperties.private.dashboardKey === 'status');
    if (markers.length > 1) throw new Error('更新状況の記録が重複しています。予定を変更せず停止しました。');
    let marker = markers[0];
    const props = marker?.extendedProperties.private || {};
    // Recover a successful remote commit whose local acknowledgement was interrupted.
    if (state.pendingRevision && props.revision === state.pendingRevision && !props.busy) {
      state.revision = props.revision;
      state.pendingRevision = '';
      save(state);
    }
    if (props.busy && props.busy !== state.deviceId)
      throw new Error('別の端末が転記中、または途中で停止しています。その端末で同期を完了してください。');
    if ((props.revision || '') !== (state.revision || ''))
      throw new Error('Google側に、別の端末で更新した予定があります。最新のJSONを読み込んでから接続してください。');
    const changes = diff(remote, desired, state.sourceId);
    const hash = await digest(JSON.stringify(desired));
    const timestamp = now().toISOString();
    const revision = uuid();
    state.pendingRevision = revision;
    save(state);
    const lock = statusBody(snapshot.today, state.sourceId,
      { revision: state.revision || '', busy: state.deviceId }, false, timestamp);
    if (marker) {
      marker = await api(base + '/' + encodeURIComponent(marker.id), { method: 'PATCH', body: lock, etag: marker.etag });
    } else {
      // Deterministic status ID makes two concurrent first-sync attempts conflict safely.
      const id = 'd' + (await digest(APP + state.sourceId + 'status')).slice(0, 48);
      marker = await api(base, { method: 'POST', body: { id, ...lock } });
    }
    let done = 0;
    const total = changes.create.length + changes.update.length + changes.remove.length;
    for (const item of changes.create) {
      await api(base + '?sendUpdates=none', { method: 'POST', body: { id: uuid(), ...item } });
      progress(++done, total);
    }
    for (const { previous, item } of changes.update) {
      await api(base + '/' + encodeURIComponent(previous.id) + '?sendUpdates=none',
        { method: 'PATCH', body: item, etag: previous.etag });
      progress(++done, total);
    }
    // Do not remove obsolete entries until every replacement has succeeded.
    for (const item of changes.remove) {
      await api(base + '/' + encodeURIComponent(item.id) + '?sendUpdates=none', { method: 'DELETE', etag: item.etag });
      progress(++done, total);
    }
    const complete = statusBody(snapshot.today, state.sourceId,
      { revision, busy: '', snapshotHash: hash, lastSyncedAt: timestamp }, true, timestamp);
    await api(base + '/' + encodeURIComponent(marker.id), { method: 'PATCH', body: complete, etag: marker.etag });
    state.revision = revision;
    state.pendingRevision = '';
    state.lastSyncedAt = timestamp;
    save(state);
    return { count: desired.length, created: changes.create.length, updated: changes.update.length, removed: changes.remove.length };
  }
  return { APP, SOURCE_URL, validDate, nextDay, buildEvents, body, diff, owned, equal, synchronize, uuid };
});
