// 모든 요청 앞에서 로그인 여부를 확인한다. 판정 로직은 _lib.js 에 있다.
import {
  AuthError,
  SESSION_COOKIE,
  SESSION_HOURS,
  configError,
  currentUser,
  isAllowed,
  makeSession,
  safeNext,
  sessionCookie,
  verifyGoogleIdToken,
} from './_lib.js';

const PUBLIC_PATHS = new Set(['/login', '/login.html']);

// 앱 설치(PWA) 파일: 브라우저가 쿠키 없이 받아 가므로 로그인 없이 내준다. 사용자 데이터는 없다.
const PWA_PATHS = new Set(['/manifest.webmanifest', '/sw.js']);
function isPwaAsset(path) {
  return PWA_PATHS.has(path) || /^\/icons\/[\w.-]+\.(png|svg)$/.test(path);
}

function wantsHtml(request) {
  return request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/html');
}

// 설정이 덜 됐을 때 화면 요청에 보여 줄 안내 (무엇이 빠졌는지는 서버 로그에만 남긴다)
const SETUP_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#212121"><title>준비 중 · 현장 안전점검</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#212121;
font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif;line-height:1.6;word-break:keep-all;overflow-wrap:anywhere}
main{width:100%;max-width:400px;padding:32px 24px;border-radius:16px;background:#fff;text-align:center}
h1{margin:0 0 8px;font-size:1.25rem;color:#111827}p{margin:0;color:#4b5563}
</style></head><body><main>
<h1>현장 안전점검 준비 중입니다</h1>
<p>서버의 로그인 설정이 아직 끝나지 않았습니다. 잠시 후 다시 열어 주세요. 계속 이 화면이 보이면 관리자에게 알려 주세요.</p>
</main></body></html>`;

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function withSecurityHeaders(response, path) {
  const res = new Response(response.body, response);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'same-origin');
  res.headers.set('X-Frame-Options', 'DENY');
  // 구글 로그인 팝업이 결과를 돌려줄 수 있게 로그인 화면만 팝업 허용
  res.headers.set('Cross-Origin-Opener-Policy', PUBLIC_PATHS.has(path) ? 'same-origin-allow-popups' : 'same-origin');
  return res;
}

// 다른 사이트에서 보낸 로그인·로그아웃 요청(CSRF)은 거부한다
function isSameOriginPost(request, url) {
  return request.headers.get('Origin') === url.origin
    && (request.headers.get('Content-Type') || '').startsWith('application/json');
}

async function handleAuth(request, env, url) {
  const path = url.pathname;

  if (path === '/auth/config' && request.method === 'GET') {
    return json({ clientId: env.GOOGLE_CLIENT_ID });
  }

  if (path === '/auth/google' && request.method === 'POST') {
    if (!isSameOriginPost(request, url)) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    }
    let user;
    try {
      user = await verifyGoogleIdToken(body?.credential, env);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: '구글 로그인 확인에 실패했습니다.' }, 401);
      return json({ error: '잠시 후 다시 시도해 주세요.' }, 502);
    }
    if (!isAllowed(env, user.email)) {
      return json({ error: `${user.email} 계정은 접속 권한이 없습니다. 관리자에게 문의하세요.` }, 403);
    }
    const value = await makeSession(user, env.SESSION_SECRET);
    return json(
      { ok: true, email: user.email, next: safeNext(body?.next) },
      200,
      { 'Set-Cookie': sessionCookie(value, SESSION_HOURS * 3600) },
    );
  }

  if (path === '/auth/logout' && request.method === 'POST') {
    if (!isSameOriginPost(request, url)) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  return json({ error: '찾을 수 없습니다.' }, 404);
}

async function handle(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 설정이 빠졌으면 아무것도 열지 않는다
  const missing = configError(env);
  if (missing) {
    console.error(`[safety-check] 설정 오류: ${missing}`);
    if (wantsHtml(request)) return new Response(SETUP_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    return json({ error: '서버 설정이 완료되지 않았습니다. 관리자에게 문의하세요.' }, 503);
  }

  if (path.startsWith('/auth/')) return handleAuth(request, env, url);
  if (PUBLIC_PATHS.has(path)) return next();
  if (isPwaAsset(path)) {
    const res = await next();
    if (path === '/sw.js') {
      // 서비스 워커는 항상 새로 확인하게 한다 (새 버전이 바로 퍼지도록)
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'no-cache');
      return out;
    }
    return res;
  }

  const user = await currentUser(request, env);
  if (user) {
    context.data.user = user;
    if (path === '/api/me') return json({ email: user.email, name: user.name });
    return next();
  }

  // 로그인 안 됨: 화면 요청은 로그인 화면으로, API 요청은 401
  if (wantsHtml(request)) {
    const target = `/login?next=${encodeURIComponent(path + url.search)}`;
    return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
  }
  return json({ error: '로그인이 필요합니다.' }, 401, {
    // 잘못된 쿠키가 남아 있으면 지운다
    ...(request.headers.get('Cookie')?.includes(`${SESSION_COOKIE}=`) ? { 'Set-Cookie': sessionCookie('', 0) } : {}),
  });
}

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  return withSecurityHeaders(await handle(context), path);
}
