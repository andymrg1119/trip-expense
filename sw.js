/* 拆伙 PWA Service Worker
 * 策略：
 *   · 页面导航 + 代码/样式（html / js / css / webmanifest）：**网络优先**，断网回退缓存
 *     —— 保证发布新版本后用户能立刻拿到新代码，离线也能用。
 *   · 图片等静态资源：缓存优先（很少变动）。
 * ⚠️ 发布新版本时请同时提升 CACHE 版本号：activate 会据此清掉旧缓存。
 */
const CACHE = 'chaipo-v2';
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

/** 需要「网络优先」的请求：代码/样式/文档。 */
function isFreshFirst(url) {
  if (url.pathname === '/') return true;
  if (url.pathname.charAt(url.pathname.length - 1) === '/') return true;
  return /\.(?:html|js|css|webmanifest)$/i.test(url.pathname);
}

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

  if (req.mode === 'navigate' || isFreshFirst(url)) {
    // 网络优先：拿到新版本就用新的；断网时回退到缓存（离线可用）
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 图片等静态资源：缓存优先，未命中再走网络并写回缓存
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
