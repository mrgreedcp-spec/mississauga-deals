/* 离线支持（只在静态站启用）：页面外壳缓存优先；数据和页面网络优先、断网时用上次的缓存。
   版本号和外壳清单由 scripts/export_site.py 在导出时填入；每次发布换一个版本，旧缓存自动清掉。 */
const VERSION = "mgd-66b13a6748";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "style.css?v=64ace01724", "config.js?v=66b13a6748", "i18n.js?v=fd55cfc5b5", "core.js?v=2451bc2043", "static_api.js?v=bc62147397", "app.js?v=603046e72e"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mgd-") && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const networkFirst = async (req) => {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === "navigate" && await cache.match("./"));
    if (hit) return hit;
    throw err;
  }
};

const cacheFirst = async (req) => {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
  return res;
};

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部链接（官网、地图）不经过这里
  const p = url.pathname;
  if (req.mode === "navigate" || p.endsWith("/data/site.json") || p.endsWith("/data/build.json")) e.respondWith(networkFirst(req));
  else e.respondWith(cacheFirst(req));
});
