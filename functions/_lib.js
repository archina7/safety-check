// 로그인 판정은 모두 여기서 한다 (CLAUDE.md 규칙: 로그인 허용 여부는 서버가 판정).
//
// 필요한 환경 변수 (.dev.vars / Cloudflare Pages 환경 변수):
//   GOOGLE_CLIENT_ID  Google OAuth 웹 클라이언트 ID
//   ALLOWED_EMAILS    접속을 허용할 구글 이메일, 쉼표로 구분
//   SESSION_SECRET    세션 쿠키 서명용 임의 문자열, 32자 이상
// 하나라도 없거나 SESSION_SECRET 이 짧으면 모든 요청을 막는다 (fail closed).

export const SESSION_COOKIE = 'sc_session';
export const SESSION_HOURS = 12;

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const CLOCK_SKEW_SEC = 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- 설정 ----

export function configError(env) {
  if (!env.GOOGLE_CLIENT_ID) return 'GOOGLE_CLIENT_ID 미설정';
  if (allowedEmails(env).size === 0) return 'ALLOWED_EMAILS 미설정';
  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) return 'SESSION_SECRET 미설정 또는 32자 미만';
  return null;
}

export function allowedEmails(env) {
  return new Set(
    String(env.ALLOWED_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowed(env, email) {
  return typeof email === 'string' && allowedEmails(env).has(email.toLowerCase());
}

// 테스트에서만 로컬 공개키 서버를 쓸 수 있다. localhost 가 아닌 주소는 무시하고 구글 주소를 쓴다.
function certsUrl(env) {
  const override = env.GOOGLE_CERTS_URL;
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.href;
    } catch {
      // 잘못된 주소는 무시
    }
  }
  return GOOGLE_CERTS;
}

// ---- base64url ----

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJson(part) {
  return JSON.parse(dec.decode(b64urlToBytes(part)));
}

// ---- 구글 ID 토큰 검증 ----

export class AuthError extends Error {}

export async function verifyGoogleIdToken(token, env) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('토큰 형식 오류');

  let header, claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw new AuthError('토큰 형식 오류');
  }
  if (header.alg !== 'RS256') throw new AuthError('지원하지 않는 서명 방식');

  const res = await fetch(certsUrl(env), { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error('구글 공개키를 받지 못함');
  const { keys } = await res.json();
  const jwk = (keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError('알 수 없는 서명 키');

  // 서명 부분이 깨졌거나 키 값이 이상하면 서버 오류가 아니라 로그인 거부로 처리한다
  let valid;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    throw new AuthError('서명 형식 오류');
  }
  if (!valid) throw new AuthError('서명 검증 실패');

  const now = Date.now() / 1000;
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new AuthError('발급자 불일치');
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new AuthError('클라이언트 ID 불일치');
  if (!(typeof claims.exp === 'number' && claims.exp + CLOCK_SKEW_SEC > now)) throw new AuthError('토큰 만료');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SEC > now) throw new AuthError('발급 시각 오류');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new AuthError('이메일 미인증 계정');
  if (typeof claims.email !== 'string' || !claims.email) throw new AuthError('이메일 없음');

  return { email: claims.email.toLowerCase(), name: String(claims.name || '').slice(0, 100) };
}

// ---- 세션 쿠키 (HMAC-SHA256 서명) ----

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeSession(user, secret, hours = SESSION_HOURS) {
  const payload = bytesToB64url(
    enc.encode(JSON.stringify({ email: user.email, name: user.name || '', exp: Math.floor(Date.now() / 1000) + hours * 3600 })),
  );
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${bytesToB64url(sig)}`;
}

export async function readSession(value, secret) {
  if (!value) return null;
  const [payload, sig, extra] = String(value).split('.');
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlToBytes(sig), enc.encode(payload));
    if (!ok) return null;
    const data = decodeJson(payload);
    if (typeof data.email !== 'string' || !(data.exp > Date.now() / 1000)) return null;
    return { email: data.email, name: typeof data.name === 'string' ? data.name : '' };
  } catch {
    return null;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(value, maxAgeSec) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// 로그인 뒤 돌아갈 주소: 같은 사이트 안의 경로만 허용 (open redirect 방지)
// 브라우저는 주소 속 탭·줄바꿈을 지우므로 '/\t/evil.com' 이 '//evil.com' 이 된다. 제어 문자·공백·역슬래시는 모두 거부한다.
const SAFE_PATH = /^\/(?![\/\\])[^\x00-\x20\x7f\\]*$/;
export function safeNext(value) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)) return '/';
  const base = 'https://same-origin.invalid';
  try {
    return new URL(value, base).origin === base ? value : '/';
  } catch {
    return '/';
  }
}

// 세션이 유효하고 지금도 허용 목록에 있는 사용자만 돌려준다 (목록에서 빼면 바로 차단)
export async function currentUser(request, env) {
  const user = await readSession(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  return user && isAllowed(env, user.email) ? user : null;
}
