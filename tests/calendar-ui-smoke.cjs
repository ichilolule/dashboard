// Optional browser smoke test. Requires Playwright with Chromium installed.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright', {
  paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()]
}));
const root = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      const data = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8');
      res.end(data);
    } catch (_) { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CALENDAR_CHROME_PATH || undefined
    });
  }
  catch (error) { server.close(); throw error; }
  try {
    const context = await browser.newContext({ viewport: { width: 1120, height: 900 } });
    const page = await context.newPage(), errors = [], remote = new Map();
    let version = 0, transientFailures = 1;
    let calendarResource = { id: 'dedicated@group.calendar.google.com', summary: '制作予定（ダッシュボード）',
      description: '', timeZone: 'Asia/Tokyo', labelProperties: { eventLabels: [] } };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const backupHandle = async () => (await navigator.storage.getDirectory())
        .getFileHandle('dashboard_sync.json', { create: true });
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: backupHandle });
      window.__getBackupText = async () => (await (await backupHandle()).getFile()).text();
      window.__setBackupText = async value => {
        const writable = await (await backupHandle()).createWritable();
        await writable.write(String(value));
        await writable.close();
      };
    });
    await context.route('https://cdn.jsdelivr.net/**', route => route.abort());
    await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({
      contentType: 'application/javascript', body: `window.google={accounts:{oauth2:{
        hasGrantedAllScopes:()=>true,
        initTokenClient:(options)=>{window.__lastTokenConfig=options;return{requestAccessToken:()=>{
          window.__tokenRequestCount=(window.__tokenRequestCount||0)+1;
          if(window.__tokenMode==='cancel')return options.error_callback({type:'popup_closed'});
          options.callback({access_token:'mock-token',expires_in:3600});
        }}}
      }}};`
    }));
    await context.route('https://www.googleapis.com/**', async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method();
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
        'Access-Control-Allow-Headers': 'authorization,content-type,if-match'
      } });
      let result = {}, status = 200;
      if (url.pathname.includes('/userinfo')) result = { sub: 'mock-account', email: 'mock@example.test' };
      else if (url.pathname.endsWith('/calendarList')) result = { items: [] };
      else if (url.pathname === '/calendar/v3/calendars') {
        calendarResource = { ...calendarResource, ...(req.postDataJSON() || {}) };
        result = calendarResource;
      }
      else if (url.pathname.startsWith('/calendar/v3/calendars/') && !url.pathname.includes('/events')) {
        if (method === 'PUT') calendarResource = { ...calendarResource, ...(req.postDataJSON() || {}) };
        result = calendarResource;
      }
      else if (method === 'GET') result = { items: [...remote.values()] };
      else {
        const body = req.postDataJSON();
        if (method === 'POST' && body.extendedProperties?.private?.dashboardKey !== 'status' && transientFailures > 0) {
          transientFailures--;
          status = 503;
          result = { error: { errors: [{ reason: 'backendError' }], message: 'Backend Error' } };
          return route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(result) });
        }
        const id = method === 'POST' ? body.id : decodeURIComponent(url.pathname.split('/').at(-1));
        if (method === 'DELETE') { remote.delete(id); status = 204; }
        else {
          result = { ...(remote.get(id) || {}), ...body, id, etag: 'e' + ++version, updated: new Date().toISOString() };
          remote.set(id, result);
        }
      }
      await route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: status === 204 ? '' : JSON.stringify(result) });
    });
    const url = 'http://localhost:' + server.address().port;
    await page.goto(url);
    const dateBoundary = await page.evaluate(() => {
      const savedCfg = localStorage.getItem('cfg');
      const cfg = getCfg();
      cfg.businessDayStartHour = 4;
      localStorage.setItem('cfg', JSON.stringify(cfg));
      const justAfterMidnight = new Date(2026, 8, 5, 0, 30);
      const holder = document.createElement('div');
      holder.innerHTML = buildMonthGrid(2026, 8, justAfterMidnight);
      const highlightedDay = holder.querySelector('.cal-cell.today .cal-date')?.firstChild?.textContent.trim();
      const businessDay = ymd(getBusinessDate(justAfterMidnight));
      const calendarDay = calendarTodayYmd(justAfterMidnight);
      if (savedCfg === null) localStorage.removeItem('cfg');
      else localStorage.setItem('cfg', savedCfg);
      return { businessDay, calendarDay, highlightedDay };
    });
    assert.deepEqual(dateBoundary, {
      businessDay: '2026-09-04',
      calendarDay: '2026-09-05',
      highlightedDay: '5'
    });
    const shortcut = page.locator('#google-transfer-shortcut');
    assert.equal(await shortcut.locator('.gcal-shortcut-label').innerText(), 'Google転記');
    assert.equal(await shortcut.getAttribute('data-connected'), 'false');
    assert.equal(await shortcut.locator('.gcal-sync-dot').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(222, 173, 84)');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const section = page.locator('#google-calendar-settings');
    const backupSection = page.locator('#icloud-backup-settings');
    await backupSection.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.length > 0);
    assert.match(await backupSection.innerText(), /最初にiCloud Drive内の保存先を設定/);
    await backupSection.getByRole('button', { name: 'iCloud保存先を設定' }).click();
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('上書き保存'));
    assert.equal(JSON.parse(await page.evaluate(() => window.__getBackupText())).cases.length, 0);
    const downloadPromise = page.waitForEvent('download');
    await backupSection.getByRole('button', { name: '通常ダウンロード' }).click();
    assert.equal((await downloadPromise).suggestedFilename(), 'dashboard_sync.json');
    await section.waitFor({ state: 'visible' });
    assert.match(await section.innerText(), /初回接続の設定が必要/);
    await section.locator('[data-field="client"]').fill('123-mock.apps.googleusercontent.com');
    await section.getByRole('button', { name: '接続設定を保存' }).click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('接続ボタン'));
    await page.evaluate(() => {
      const date = todayYmd();
      cases = [normalizeCase({ name: '動作確認用の案件', deadline: addDays(date, 5), status: 'progress', step: '1', paid: '後払い', price: 12000 })];
      cases[0].detail = '青い衣装・笑顔\nhttps://example.test/reference';
      saveAll();
    });
    await shortcut.click();
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '転記中…');
    assert.equal(await shortcut.isEnabled(), false);
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了') &&
      document.querySelector('.gcal-shortcut-label').textContent === 'Google転記');
    assert.equal(await shortcut.locator('.gcal-shortcut-label').innerText(), 'Google転記');
    assert.equal(await shortcut.getAttribute('data-connected'), 'true');
    assert.equal(await shortcut.locator('.gcal-sync-dot').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(111, 189, 152)');
    assert.ok(remote.size > 1);
    const workEvent = [...remote.values()].find(event => event.summary?.startsWith('☀️') || event.summary?.startsWith('🌃'));
    assert.ok(workEvent && workEvent.eventLabelId);
    assert.match(workEvent.description, /依頼詳細：\n青い衣装・笑顔/);
    assert.ok(!workEvent.description.includes('編集元') && !workEvent.description.includes('枠：'));
    assert.ok(calendarResource.labelProperties.eventLabels.some(label => label.name === '動作確認用の案件'));
    const count = remote.size;
    await shortcut.click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('追加0・変更0・削除0'));
    assert.equal(remote.size, count);
    const backup = await page.evaluate(() => googleCalendarSync.exportConfig());
    assert.ok(backup.calendarId && backup.revision && backup.clientId);
    assert.ok(backup.clientLabels?.['動作確認用の案件']?.id);
    assert.ok(!JSON.stringify(backup).includes('mock-token'));
    assert.ok(!('deviceId' in backup) && !('pendingRevision' in backup));
    await page.waitForFunction(async () => {
      try { return JSON.parse(await window.__getBackupText()).googleCalendar?.revision; }
      catch (_) { return false; }
    });
    const directBackup = JSON.parse(await page.evaluate(() => window.__getBackupText()));
    assert.equal(directBackup.cases[0].name, '動作確認用の案件');
    assert.equal(directBackup.googleCalendar.revision, backup.revision);
    // Editing the real dashboard fires the automatic projection hook.
    await page.evaluate(() => { cases[0].name = '変更後の案件'; saveAll(); });
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了') &&
      !document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('変更0'), { timeout: 15000 });
    assert.ok([...remote.values()].some(event => event.summary.includes('変更後の案件')));
    // After a page restart, a background change remains pending. The next real edit reconnects and transfers it.
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('接続ボタン'));
    await page.evaluate(() => { cases[0].name = '再起動後の案件'; saveAll(); });
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '未転記');
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), 0);
    await page.locator('#case-list .qb', { hasText: '確認待ち' }).click();
    await page.waitForFunction(() => (window.__tokenRequestCount || 0) === 1);
    assert.equal(await page.evaluate(() => window.__lastTokenConfig.login_hint), 'mock-account');
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了'), { timeout: 15000 });
    assert.ok([...remote.values()].some(event => event.summary.includes('再起動後の案件')));
    assert.equal(await page.locator('#google-transfer-shortcut .gcal-shortcut-label').innerText(), 'Google転記');
    // A cancelled automatic reconnect is not repeated on every edit; the pending shortcut remains the recovery path.
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('接続ボタン'));
    await page.evaluate(() => { window.__tokenMode = 'cancel'; });
    await page.locator('#case-list .qb', { hasText: '進行中' }).click();
    await page.waitForFunction(() => (window.__tokenRequestCount || 0) === 1);
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '未転記');
    await page.locator('#case-list .qb', { hasText: '確認待ち' }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__tokenRequestCount || 0), 1);
    await page.evaluate(() => { window.__tokenMode = 'success'; });
    await page.locator('#google-transfer-shortcut').click();
    await page.waitForFunction(() => (window.__tokenRequestCount || 0) === 2);
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了') &&
      document.querySelector('.gcal-shortcut-label').textContent === 'Google転記', { timeout: 15000 });
    // An explicitly confirmed stale lock can be taken over even when Google's revision advanced.
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const marker = [...remote.values()].find(event => event.extendedProperties?.private?.dashboardKey === 'status');
    marker.extendedProperties.private.revision = 'b'.repeat(32);
    marker.extendedProperties.private.busy = 'installed-web-app-device';
    marker.extendedProperties.private.busySince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    marker.etag = 'e' + ++version;
    remote.set(marker.id, marker);
    await section.getByRole('button', { name: '今すぐ転記' }).click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('引き継いで再開'));
    const takeover = section.getByRole('button', { name: '中断した転記をこの端末で引き継ぐ' });
    await takeover.waitFor({ state: 'visible' });
    page.once('dialog', dialog => dialog.accept());
    await takeover.click();
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.startsWith('転記完了'));
    assert.equal(remote.get(marker.id).extendedProperties.private.busy, '');
    await section.scrollIntoViewIfNeeded();
    if (process.env.CALENDAR_QA_DIR) {
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-settings-desktop.png') });
      await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-mobile.png') });
      await page.getByRole('button', { name: '設定', exact: true }).click();
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-settings-mobile.png') });
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.evaluate(() => document.querySelector('.top-bar > span').getBoundingClientRect().height < 30));
    // An external edit of the selected iCloud file pauses writes until the user imports that version.
    await page.evaluate(async () => {
      const cloud = JSON.parse(await window.__getBackupText());
      cloud.cases[0].name = 'iCloud側の案件';
      cloud.exported = new Date(Date.now() + 60000).toISOString();
      await window.__setBackupText(JSON.stringify(cloud, null, 2));
      cases[0].memo = 'ローカル側の未保存変更';
      saveAll();
    });
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('自動保存を停止'));
    assert.equal(JSON.parse(await page.evaluate(() => window.__getBackupText())).cases[0].name, 'iCloud側の案件');
    page.once('dialog', dialog => dialog.accept());
    await backupSection.getByRole('button', { name: 'iCloud側を読み込む' }).click();
    await page.waitForFunction(() => cases[0]?.name === 'iCloud側の案件');
    await page.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('上書き保存'));
    assert.equal(JSON.parse(await page.evaluate(() => window.__getBackupText())).cases[0].name, 'iCloud側の案件');
    // A stale open tab cannot reconnect and send its obsolete in-memory cases.
    const other = await context.newPage();
    await other.goto(url);
    await other.waitForFunction(() => document.querySelector('#icloud-backup-settings [data-role="status"]').textContent.includes('自動保存を利用できます'));
    await other.evaluate(() => localStorage.setItem('cases', '[]'));
    await page.waitForFunction(() => document.querySelector('#google-calendar-settings .gcal-status').textContent.includes('別のタブ'));
    await section.getByRole('button', { name: 'Googleに接続して転記' }).click();
    assert.match(await section.locator('.gcal-status').innerText(), /再読み込み/);
    assert.deepEqual(errors, []);
    console.log('PASS: midnight highlight, retry, client labels, event details, repeat sync, takeover recovery, direct backup, conflict recovery, mobile layout, stale-tab guard');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
