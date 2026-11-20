// 현장 안전점검 서비스 워커
// - 화면 파일(SHELL)만 캐시한다. 네트워크 먼저, 실패하면 캐시.
// - /api/ 와 /config.js 는 로그인한 사용자 데이터라 절대 캐시하지 않는다.
// - 화면 파일을 바꾸면 VERSION 을 올린다. 새 버전이 활성화되면 예전 캐시를 지운다.

const VERSION = 'v1';
const CACHE_PREFIX = 'safety-check-shell-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;

const SHELL = [
  '/',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
];

function isShell(url) {
  return url.origin === self.location.origin && SHELL.includes(url.pathname);
}

function neverCache(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/config.js';
}

// 로그인이 풀려 /login 으로 넘어간 응답, 오류 응답은 캐시하지 않는다
function cacheable(response) {
  return response && response.ok && response.type === 'basic' && !response.redirected;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 하나가 실패해도(예: 로그인 풀림) 설치는 계속한다
    await Promise.allSettled(SHELL.map(async (path) => {
      const response = await fetch(path, { cache: 'reload', credentials: 'same-origin' });
      if (cacheable(response)) await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (neverCache(url)) return; // 브라우저가 평소대로 네트워크로 보낸다
  if (!isShell(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (cacheable(response)) await cache.put(url.pathname, response.clone());
      return response;
    } catch (error) {
      // 오프라인: '/?site=A' 처럼 검색어가 붙어도 같은 화면 파일을 돌려준다
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      throw error;
    }
  })());
});
