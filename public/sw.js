// 현장 안전점검 서비스 워커
// - 화면 파일(SHELL)만 캐시한다. 네트워크 먼저, 실패하면 캐시.
// - /api/ 와 /config.js 는 로그인한 사용자 데이터라 절대 캐시하지 않는다.
// - 화면 파일을 바꾸면 VERSION 을 올린다. 새 버전이 활성화되면 예전 캐시를 지운다.

const VERSION = 'v6';
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

// 캐시는 위 SHELL 목록에 있는 경로만 한다(허용 목록). 아래 규칙은 그 위에 한 번 더 거는 안전장치다.
// /config.js 는 지금 없지만 요구사항에 따라 미리 막아 둔다. 사용자 데이터를 새 경로로 내주면
// SHELL 에 넣지 말고 여기에도 추가한다.
function neverCache(url) {
  return url.pathname.startsWith('/api/') || url.pathname === '/config.js';
}

// 로그인이 풀려 /login 으로 넘어간 응답, 오류 응답은 캐시하지 않는다
function cacheable(response) {
  return response && response.ok && response.type === 'basic' && !response.redirected;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // 하나가 실패해도(예: 로그인 풀림, 저장소 오류) 설치는 계속한다
    await Promise.allSettled(SHELL.map(async (path) => {
      const response = await fetch(path, { cache: 'reload', credentials: 'same-origin' });
      if (cacheable(response)) await (await caches.open(CACHE)).put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    } catch {
      // 예전 캐시를 못 지워도 새 버전은 동작한다
    }
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
    let response;
    try {
      response = await fetch(request);
    } catch (error) {
      // 오프라인: '/?site=A' 처럼 검색어가 붙어도 같은 화면 파일을 돌려준다
      const cached = await caches.open(CACHE).then((c) => c.match(url.pathname)).catch(() => null);
      if (cached) return cached;
      throw error;
    }
    // 캐시 저장이 실패해도(브라우저 저장소 손상·용량 부족) 화면은 네트워크 응답으로 연다
    if (cacheable(response)) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(url.pathname, copy)).catch(() => {}));
    }
    return response;
  })());
});
