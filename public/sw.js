/* 서비스 워커: 앱 껍데기를 저장해 두고(설치 가능 조건), 서버가 꺼졌을 때도 '서버가 꺼졌습니다' 안내 페이지가 뜨게 한다.
   파일을 추가하면 SHELL 목록과 CACHE 이름(버전)을 같이 올린다. 정적 파일은 '네트워크 우선'이라 서버를 고치면 바로 반영된다. */
const CACHE = 'siru-shell-v6';
const SHELL = [
  '/', '/style.css', '/themes.css', '/app.js', '/media.js', '/voice.js', '/settings.js', '/pwa.js', '/dm.js', '/notify.js', '/panic.js', '/attach.js', '/layout.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 화면(내비게이션) 요청: 서버가 응답 못 하거나 5xx(프록시의 502 등)면 저장해 둔 앱 껍데기를 보여 준다.
// 앱이 뜨면 /healthz를 확인해서 서버가 꺼진 것을 알고 안내 페이지를 띄운다.
const fallback = async (res) => (await caches.match('/')) || res || Response.error();

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  // 같은 사이트의 GET만. /healthz는 반드시 실제 서버에 물어야 하므로 가로채지 않는다.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname === '/healthz' || url.pathname.startsWith('/f/')) return; // 올린 사진·동영상은 용량이 크고 Range 요청이 필요해서 가로채지 않는다
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => (res.status >= 500 ? fallback(res) : res)).catch(() => fallback()));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
});

// ---- 푸시 알림 ----
// 서버가 만든 내용(제목·본문·아이콘)을 그대로 보여 준다. 위장 알림에는 보낸 사람도 쪽지 내용도 없다.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || '새 알림', {
    body: d.body || '', icon: d.icon || '/icons/icon-192.png', badge: '/icons/badge-96.png',
    tag: d.tag, renotify: !!d.tag, data: { uid: d.uid },
  }));
});
// 알림을 누르면: 열려 있는 창이 있으면 그 창으로, 없으면 앱을 연다
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list[0];
    if (win) { win.postMessage({ t: 'open-dm', uid: e.notification.data?.uid }); return win.focus(); }
    return self.clients.openWindow('/');
  }));
});
