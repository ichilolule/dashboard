// sw.js — studio mizumochi dashboard
// キャッシュ名を変えると古いキャッシュが自動削除される
// index.html のバージョンアップ時はここも合わせて更新する
const CACHE = 'dashboard-v19';

// ===== インストール =====
// 起動に最低限必要なファイルだけ事前キャッシュ
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.add('/dashboard/'))
      .then(() => self.skipWaiting())
  );
});

// ===== アクティベート =====
// 古いバージョンのキャッシュをすべて削除
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ===== フェッチ =====
// キャッシュ優先。未キャッシュのリソースはネットから取得してキャッシュに追加。
// CDN（Tabler icons）も初回アクセス時に自動キャッシュされる。
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      });
    })
  );
});
