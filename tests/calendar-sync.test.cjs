const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../calendar-sync-core.js');
const sourceId = 'a'.repeat(32);
const initial = () => ({ sourceId, deviceId: 'device-a', calendarId: 'dedicated@group.calendar.google.com', revision: '' });
const snapshot = () => ({ today: '2026-09-01', cases: [
  { name: '案件A', deadline: '2026-09-04', paydue: '2026-08-31', paid: '入金済み', contact: 'do-not-export', price: 999999, detail: 'secret' },
  { name: '案件B', deadline: '2026-09-04', paydue: '2026-09-02', paid: '未入金' }
], schedule: {
  '2026-09-01': { morning: { kind: 'rough', caseName: '案件A' }, night: null, wait: [{ caseName: '案件B' }] },
  '2026-09-02': { morning: null, night: { kind: 'clean', caseName: '案件A' }, wait: [] }
} });
function fakeApi() {
  const db = new Map(), calls = [];
  let serial = 0, fail = null;
  async function api(path, opt = {}) {
    const method = opt.method || 'GET';
    calls.push({ path, ...opt, method });
    if (fail && fail(path, opt)) throw new Error('simulated network interruption');
    if (method === 'GET') return { items: [...db.values()].map(v => structuredClone(v)) };
    const id = method === 'POST' ? opt.body.id : decodeURIComponent(path.split('/').at(-1).split('?')[0]);
    const old = db.get(id);
    if (method === 'POST' && old) throw Object.assign(new Error('conflict'), { status: 409 });
    if (opt.etag && old?.etag !== opt.etag) throw Object.assign(new Error('etag'), { status: 412 });
    if (method === 'DELETE') { db.delete(id); return {}; }
    const next = { ...(old || {}), ...structuredClone(opt.body), id, etag: 'e' + ++serial };
    db.set(id, next);
    return structuredClone(next);
  }
  return { api, db, calls, fail: fn => { fail = fn; } };
}
const sync = (server, state, data = snapshot()) => Core.synchronize({ api: server.api, state, snapshot: data, save() {}, now: () => new Date('2026-09-01T12:00:00Z') });

test('exports the displayed slots and grouped dates, with no billing or contact data', () => {
  const data = snapshot();
  data.profile = { bankInfo: 'bank-secret' };
  const events = Core.buildEvents(data).map(e => Core.body(e, sourceId));
  assert.equal(events.length, 5);
  assert.match(events.find(e => e.summary.startsWith('［納期］')).description, /案件A\n案件B/);
  const text = JSON.stringify(events);
  for (const secret of ['do-not-export', '999999', 'secret', 'bank-secret']) assert.ok(!text.includes(secret));
  for (const event of events) {
    assert.equal(event.transparency, 'transparent');
    assert.deepEqual(event.reminders, { useDefault: false, overrides: [] });
    assert.equal(event.visibility, 'private');
    assert.equal(Date.parse(event.end.date) - Date.parse(event.start.date), 86400000);
  }
});
test('all-day boundaries handle month/year/leap rollover and reject invalid dates', () => {
  assert.equal(Core.nextDay('2026-12-31'), '2027-01-01');
  assert.equal(Core.nextDay('2028-02-28'), '2028-02-29');
  assert.equal(Core.nextDay('2028-02-29'), '2028-03-01');
  assert.throws(() => Core.nextDay('2026-02-30'));
});
test('repeated sync does not duplicate or rewrite unchanged work events', async () => {
  const server = fakeApi(), state = initial();
  const first = await sync(server, state);
  assert.equal(first.created, 5);
  const second = await sync(server, state);
  assert.deepEqual(second, { count: 5, created: 0, updated: 0, removed: 0 });
  assert.equal(server.db.size, 6); // Five events and the freshness/status record.
});
test('changes and deletion affect only this source; manual and unrelated events survive', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  server.db.set('manual', { id: 'manual', summary: '手入力の予定' });
  server.db.set('foreign', { id: 'foreign', ...Core.body({ key: 'other', date: '2026-09-01', title: '別の元データ', detail: '' }, 'b'.repeat(32)) });
  const data = snapshot();
  data.schedule['2026-09-01'].morning.kind = 'line';
  delete data.schedule['2026-09-02'];
  const result = await sync(server, state, data);
  assert.equal(result.updated, 1);
  assert.equal(result.removed, 1);
  assert.ok(server.db.has('manual') && server.db.has('foreign'));
});
test('a deleted and subsequently reintroduced logical slot gets a fresh valid ID', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const original = [...server.db.values()].find(e => e.summary?.startsWith('［朝昼］')).id;
  const data = snapshot(); data.schedule['2026-09-01'].morning = null;
  await sync(server, state, data);
  await sync(server, state);
  const restored = [...server.db.values()].find(e => e.summary?.startsWith('［朝昼］')).id;
  assert.notEqual(original, restored);
  assert.match(restored, /^[a-v0-9]{5,1024}$/);
});
test('an older snapshot from another device cannot overwrite newer cloud state', async () => {
  const server = fakeApi(), state = initial(), oldState = { ...initial(), deviceId: 'device-b' };
  await sync(server, state);
  const before = server.calls.length;
  await assert.rejects(sync(server, oldState), /別の端末で更新/);
  assert.ok(server.calls.slice(before).every(call => call.method === 'GET'));
});
test('failed replacement does not delete obsolete events; same device can resume', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const data = snapshot(); delete data.schedule['2026-09-02'];
  data.schedule['2026-09-03'] = { morning: { kind: 'clean', caseName: '案件A' }, wait: [] };
  const before = server.calls.length;
  server.fail((path, opt) => opt.method === 'POST');
  await assert.rejects(sync(server, state, data), /network/);
  assert.ok(server.calls.slice(before).every(call => call.method !== 'DELETE'));
  await assert.rejects(sync(server, { ...state, deviceId: 'device-b' }, data), /別の端末が転記中/);
  server.fail(null);
  const result = await sync(server, state, data);
  assert.equal(result.removed, 1);
  assert.equal(result.created, 1);
});
test('lost local acknowledgement recovers the committed remote revision', async () => {
  const server = fakeApi(), state = initial();
  let saves = 0, persisted;
  await assert.rejects(Core.synchronize({ api: server.api, state, snapshot: snapshot(), save(value) {
    if (++saves === 2) throw new Error('local-write-failure');
    persisted = structuredClone(value);
  } }), /local-write-failure/);
  const result = await sync(server, persisted);
  assert.equal(result.created, 0);
  assert.equal(result.removed, 0);
});
test('empty current dataset removes managed copies, while invalid data performs no writes', async () => {
  const server = fakeApi(), state = initial();
  await sync(server, state);
  const bad = snapshot(); bad.cases[0].deadline = 'invalid';
  const before = server.calls.length;
  await assert.rejects(sync(server, state, bad), /期日/);
  assert.equal(server.calls.length, before);
  const result = await sync(server, state, { today: '2026-09-01', cases: [], schedule: {} });
  assert.equal(result.removed, 5);
  assert.equal(server.db.size, 1);
});
