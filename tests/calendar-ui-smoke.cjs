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
    await context.route('https://cdn.jsdelivr.net/**', route => route.abort());
    await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({
      contentType: 'application/javascript', body: `window.google={accounts:{oauth2:{
        hasGrantedAllScopes:()=>true,
        initTokenClient:(options)=>({requestAccessToken:()=>options.callback({access_token:'mock-token',expires_in:3600})})
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
    const shortcut = page.locator('#google-transfer-shortcut');
    assert.equal(await shortcut.locator('.gcal-shortcut-label').innerText(), 'Google転記');
    assert.equal(await shortcut.getAttribute('data-connected'), 'false');
    assert.equal(await shortcut.locator('.gcal-sync-dot').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(222, 173, 84)');
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const section = page.locator('#google-calendar-settings');
    await section.waitFor({ state: 'visible' });
    assert.match(await section.innerText(), /初回接続の設定が必要/);
    await section.locator('[data-field="client"]').fill('123-mock.apps.googleusercontent.com');
    await section.getByRole('button', { name: '接続設定を保存' }).click();
    await page.waitForFunction(() => document.querySelector('.gcal-status').textContent.includes('接続ボタン'));
    await page.evaluate(() => {
      const date = todayYmd();
      cases = [normalizeCase({ name: '動作確認用の案件', deadline: addDays(date, 5), status: 'progress', step: '1', paid: '後払い', price: 12000 })];
      cases[0].detail = '青い衣装・笑顔\nhttps://example.test/reference';
      saveAll();
    });
    await shortcut.click();
    await page.waitForFunction(() => document.querySelector('.gcal-shortcut-label').textContent === '転記中…');
    assert.equal(await shortcut.isEnabled(), false);
    await page.waitForFunction(() => document.querySelector('.gcal-status').textContent.startsWith('転記完了'));
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
    await page.waitForFunction(() => document.querySelector('.gcal-status').textContent.includes('追加0・変更0・削除0'));
    assert.equal(remote.size, count);
    const backup = await page.evaluate(() => googleCalendarSync.exportConfig());
    assert.ok(backup.calendarId && backup.revision && backup.clientId);
    assert.ok(backup.clientLabels?.['動作確認用の案件']?.id);
    assert.ok(!JSON.stringify(backup).includes('mock-token'));
    assert.ok(!('deviceId' in backup) && !('pendingRevision' in backup));
    // Editing the real dashboard fires the automatic projection hook.
    await page.evaluate(() => { cases[0].name = '変更後の案件'; saveAll(); });
    await page.waitForFunction(() => document.querySelector('.gcal-status').textContent.startsWith('転記完了') &&
      !document.querySelector('.gcal-status').textContent.includes('変更0'), { timeout: 15000 });
    assert.ok([...remote.values()].some(event => event.summary.includes('変更後の案件')));
    // A stale lock from an installed Web App can be taken over by the latest imported snapshot.
    const marker = [...remote.values()].find(event => event.extendedProperties?.private?.dashboardKey === 'status');
    marker.extendedProperties.private.busy = 'installed-web-app-device';
    marker.extendedProperties.private.busySince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    marker.etag = 'e' + ++version;
    remote.set(marker.id, marker);
    await section.getByRole('button', { name: '今すぐ転記' }).click();
    await page.waitForFunction(() => document.querySelector('.gcal-status').textContent.includes('引き継いで再開'));
    const takeover = section.getByRole('button', { name: '中断した転記をこの端末で引き継ぐ' });
    await takeover.waitFor({ state: 'visible' });
    page.once('dialog', dialog => dialog.accept());
    await takeover.click();
    await page.waitForFunction(() => document.querySelector('.gcal-status').textContent.startsWith('転記完了'));
    assert.equal(remote.get(marker.id).extendedProperties.private.busy, '');
    await section.scrollIntoViewIfNeeded();
    if (process.env.CALENDAR_QA_DIR) {
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-settings-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.CALENDAR_QA_DIR, 'calendar-settings-mobile.png') });
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.evaluate(() => document.querySelector('.top-bar > span').getBoundingClientRect().height < 30));
    // A stale open tab cannot reconnect and send its obsolete in-memory cases.
    const other = await context.newPage();
    await other.goto(url);
    await other.evaluate(() => localStorage.setItem('cases', '[]'));
    await page.waitForFunction(() => document.querySelector('.gcal-status').textContent.includes('別のタブ'));
    await section.getByRole('button', { name: 'Googleに接続して転記' }).click();
    assert.match(await section.locator('.gcal-status').innerText(), /再読み込み/);
    assert.deepEqual(errors, []);
    console.log('PASS: retry, client labels, event details, repeat sync, takeover recovery, backup, mobile layout, stale-tab guard');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
