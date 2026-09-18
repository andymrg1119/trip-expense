/* 拆伙 PWA Service Worker —— 缓存优先 + 离线回退到 index.html
 * 相对路径注册，兼容 GitHub Pages 子路径（如 /trip-expense/）。 */
const CACHE = 'chaipo-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './calc.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不缓存跨域请求

  if (req.mode === 'navigate') {
    // 页面导航：优先网络，离线时回退到已缓存的首页
    e.respondWith(
      fetch(req).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // 其它同源资源：缓存优先，未命中再走网络并写回缓存
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached || caches.match('./index.html'); });
    })
  );
});
