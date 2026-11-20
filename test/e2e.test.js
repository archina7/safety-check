// wrangler pages dev 를 실제로 띄워서 로그인 허용·거부와 API를 확인한다.
// 구글 대신 테스트용 RSA 키로 ID 토큰을 만들고, 그 공개키를 로컬 서버(GOOGLE_CERTS_URL)로 내준다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { makeSession } from '../functions/_lib.js';
import { mockReply } from './helpers/claude-mock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799; // npm run dev(8788)와 겹치지 않게
const BASE = `http://127.0.0.1:${PORT}`;

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ALLOWED = 'inspector@example.com';
const SECRET = randomBytes(32).toString('hex');
const KID = 'test-kid';

const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });

let server;
let certsServer;
let claudeServer; // Claude API 대신 고정 응답을 주는 로컬 서버 (API 키 없이 테스트)
const claudeRequests = [];

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function idToken(overrides = {}, { key = google.privateKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: ALLOWED,
    email_verified: true,
    name: '김안전',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  const h = b64url({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const p = b64url(claims);
  const s = sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${s}`;
}

function login(credential, { origin = BASE, next } = {}) {
  return fetch(`${BASE}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ credential, next }),
  });
}

function cookieFrom(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const api = (cookie) => fetch(`${BASE}/api/inspections`, { headers: cookie ? { Cookie: cookie } : {} });

async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (server.exitCode !== null) throw new Error('wrangler pages dev 가 시작 중에 종료됨');
    try {
      const res = await fetch(`${BASE}/auth/config`);
      if (res.ok) return res.json();
    } catch {
      // 아직 준비 안 됨
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler pages dev 가 제때 뜨지 않음');
}

before(async () => {
  const jwk = { ...google.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  certsServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => certsServer.listen(0, '127.0.0.1', r));
  const certsUrl = `http://127.0.0.1:${certsServer.address().port}/certs`;

  claudeServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const params = JSON.parse(body || '{}');
      claudeRequests.push({ path: req.url, headers: req.headers, params });
      res.writeHead(200, { 'Content-Type': 'application/json', 'request-id': 'req_mock' });
      res.end(JSON.stringify(mockReply(params)));
    });
  });
  await new Promise((r) => claudeServer.listen(0, '127.0.0.1', r));
  const claudeUrl = `http://127.0.0.1:${claudeServer.address().port}`;

  const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const bindings = [
    `GOOGLE_CLIENT_ID=${CLIENT_ID}`,
    `ALLOWED_EMAILS=${ALLOWED}, boss@example.com`,
    `SESSION_SECRET=${SECRET}`,
    `GOOGLE_CERTS_URL=${certsUrl}`,
    'ANTHROPIC_API_KEY=fake',
    `ANTHROPIC_BASE_URL=${claudeUrl}`,
  ].flatMap((b) => ['--binding', b]);
  server = spawn(process.execPath, [wrangler, 'pages', 'dev', 'public', '--port', String(PORT), '--ip', '127.0.0.1', ...bindings], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  const config = await waitForServer();
  assert.equal(config.clientId, CLIENT_ID, '.dev.vars 값이 테스트 설정을 덮어썼다. 테스트 중에는 .dev.vars 를 잠시 치워 주세요');
});

after(() => {
  certsServer?.close();
  claudeServer?.close();
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    // workerd 자식 프로세스까지 함께 종료
    try { execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    server.kill('SIGTERM');
  }
});

// ---------- 허용 ----------

test('허용: 정상 구글 토큰으로 로그인하면 세션 쿠키를 받고 점검 항목을 볼 수 있다', async () => {
  const res = await login(idToken(), { next: '/?site=A' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email, ALLOWED);
  assert.equal(body.next, '/?site=A');

  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^sc_session=[^;]+/);
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(setCookie.includes(attr), `${attr} 누락`);

  const cookie = cookieFrom(res);
  const list = await api(cookie);
  assert.equal(list.status, 200);
  const { items } = await list.json();
  assert.equal(items.length, 6);
  for (const it of items) {
    for (const key of ['id', 'category', 'content', 'law']) assert.ok(typeof it[key] === 'string' && it[key], `${key} 누락`);
  }

  const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
  assert.deepEqual(await me.json(), { email: ALLOWED, name: '김안전' });

  const page = await fetch(`${BASE}/`, { headers: { Cookie: cookie, Accept: 'text/html' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /오늘의 안전점검/);
});

test('허용: 이메일 대소문자가 달라도 허용 목록과 맞으면 로그인된다', async () => {
  const res = await login(idToken({ email: 'Boss@Example.com' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).email, 'boss@example.com');
});

test('허용: 로그인 화면과 로그인 설정은 로그인 없이 열린다', async () => {
  const page = await fetch(`${BASE}/login`, { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /구글 계정으로 로그인/);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
});

// ---------- 거부: 로그인 없음 ----------

test('거부: 로그인 없이 API를 부르면 401', async () => {
  const res = await api();
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${BASE}/api/me`)).status, 401);
});

test('거부: 로그인 없이 화면을 열면 로그인 화면으로 302', async () => {
  const res = await fetch(`${BASE}/?site=A`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2F%3Fsite%3DA');
});

// ---------- 거부: 위조·잘못된 토큰 ----------

const badTokens = {
  '다른 키로 서명(위조)': () => idToken({}, { key: attacker.privateKey }),
  '만료된 토큰': () => idToken({ exp: Math.floor(Date.now() / 1000) - 3600 }),
  '다른 앱용 토큰(aud 불일치)': () => idToken({ aud: 'other-app.apps.googleusercontent.com' }),
  '구글이 아닌 발급자': () => idToken({ iss: 'https://evil.example.com' }),
  '이메일 미인증 계정': () => idToken({ email_verified: false }),
  '알 수 없는 키 ID': () => idToken({}, { header: { kid: 'unknown' } }),
  '서명 없는 토큰(alg none)': () => {
    const [h, p] = idToken({}, { header: { alg: 'none' } }).split('.');
    return `${h}.${p}.`;
  },
  '내용을 바꾼 토큰': () => {
    const [h, , s] = idToken().split('.');
    return `${h}.${b64url({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'boss@example.com', email_verified: true, exp: 9999999999 })}.${s}`;
  },
  '형식이 틀린 문자열': () => 'not-a-token',
  '서명 부분이 깨진 토큰(base64 아님)': () => {
    const [h, p] = idToken().split('.');
    return `${h}.${p}.!!!`;
  },
};

for (const [name, make] of Object.entries(badTokens)) {
  test(`거부: ${name} → 401, 쿠키 없음`, async () => {
    const res = await login(make());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });
}

test('거부: 진짜 구글 토큰이라도 허용 목록에 없는 계정 → 403', async () => {
  const res = await login(idToken({ email: 'stranger@example.com' }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match((await res.json()).error, /접속 권한이 없습니다/);
});

test('거부: 다른 사이트에서 보낸 로그인 요청(CSRF) → 403', async () => {
  const res = await login(idToken(), { origin: 'https://evil.example.com' });
  assert.equal(res.status, 403);
  const noOrigin = await fetch(`${BASE}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: idToken() }),
  });
  assert.equal(noOrigin.status, 403);
});

test('거부: 로그인 뒤 외부 주소로 보내는 next 는 / 로 바꾼다 (open redirect)', async () => {
  // 탭·줄바꿈은 브라우저가 지워서 '//evil...' 이 된다 (로그인 화면이 ?next=%2F%09%2Fevil... 을 풀어 보낸 경우)
  for (const next of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com', '/\t/evil.example.com', '/\n/evil.example.com', '/\r/evil.example.com']) {
    const res = await login(idToken(), { next });
    assert.equal((await res.json()).next, '/', next);
  }
});

// ---------- 거부: 세션 쿠키 ----------

test('거부: 서명을 바꾼 세션 쿠키 → 401', async () => {
  const cookie = cookieFrom(await login(idToken()));
  const [name, value] = cookie.split('=');
  const [payload] = value.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ email: 'boss@example.com', exp: 9999999999 })).toString('base64url');
  assert.equal((await api(`${name}=${forgedPayload}.${value.split('.')[1]}`)).status, 401);
  assert.equal((await api(`${name}=${payload}.AAAA`)).status, 401);
});

test('거부: 다른 비밀값으로 만든 세션 쿠키 → 401', async () => {
  const value = await makeSession({ email: ALLOWED }, randomBytes(32).toString('hex'));
  assert.equal((await api(`sc_session=${value}`)).status, 401);
});

test('거부: 만료된 세션 쿠키 → 401', async () => {
  const value = await makeSession({ email: ALLOWED }, SECRET, -1);
  assert.equal((await api(`sc_session=${value}`)).status, 401);
});

test('거부: 허용 목록에서 빠진 계정의 세션 → 401', async () => {
  const value = await makeSession({ email: 'removed@example.com' }, SECRET);
  assert.equal((await api(`sc_session=${value}`)).status, 401);
});

// ---------- API 메서드·로그아웃 ----------

test('거부: 로그인했어도 읽기 전용 API에 쓰기 요청 → 405', async () => {
  const cookie = cookieFrom(await login(idToken()));
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await fetch(`${BASE}/api/inspections`, { method, headers: { Cookie: cookie } });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET');
  }
});

test('로그아웃: 같은 사이트 요청이면 쿠키를 지우고, 다른 사이트 요청은 403', async () => {
  const ok = await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: '{}',
  });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /^sc_session=;.*Max-Age=0/);

  const evil = await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: '{}',
  });
  assert.equal(evil.status, 403);
});

test('보안 헤더가 모든 응답에 붙는다', async () => {
  const res = await api();
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
});

// ---------- 앱 설치 (PWA) ----------

const pngSize = (buf) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;

test('허용: manifest 는 로그인 없이 받을 수 있고 설치 조건을 갖췄다', async () => {
  const res = await fetch(`${BASE}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/manifest\+json|application\/json/);
  const m = await res.json();
  assert.equal(m.name, '현장 안전점검');
  assert.equal(m.short_name, '안전점검');
  assert.equal(m.lang, 'ko');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#212121');
  assert.equal(m.background_color, '#ffffff');

  const sizes = m.icons.map((i) => i.sizes).sort();
  assert.deepEqual(sizes, ['192x192', '512x512']);
  for (const icon of m.icons) {
    assert.equal(icon.purpose, 'any maskable');
    assert.equal(icon.type, 'image/png');
    const img = await fetch(`${BASE}${icon.src}`); // 로그인 없이
    assert.equal(img.status, 200, icon.src);
    assert.match(img.headers.get('content-type'), /image\/png/);
    assert.equal(pngSize(Buffer.from(await img.arrayBuffer())), icon.sizes, `${icon.src} 실제 크기`);
  }
});

test('허용: sw.js 는 로그인 없이 받을 수 있고, /api/ 와 /config.js 는 캐시하지 않는다', async () => {
  const res = await fetch(`${BASE}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const src = await res.text();
  assert.match(src, /const VERSION = '[^']+'/, '캐시 이름에 버전');
  assert.match(src, /startsWith\('\/api\/'\)/, '/api/ 제외');
  assert.match(src, /'\/config\.js'/, '/config.js 제외');
  assert.match(src, /caches\.delete/, '예전 캐시 삭제');
  assert.match(src, /c\.put\(url\.pathname, copy\)\)\.catch\(/, '캐시 저장 실패가 화면 열기 실패로 이어지지 않는다');

  // 캐시 목록(SHELL)에는 화면 파일만 있어야 한다
  const shell = JSON.parse(src.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(shell.includes('/') && shell.includes('/app.js') && shell.includes('/manifest.webmanifest'));
  for (const p of shell) assert.ok(!p.startsWith('/api/') && p !== '/config.js', `캐시하면 안 되는 경로: ${p}`);
});

test('허용: 화면 스크립트(app.js)는 로그인 없이 받는다 — 세션이 만료돼도 스크립트가 떠서 로그인 화면으로 보낸다', async () => {
  const app = await fetch(`${BASE}/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /javascript/);
  const src = await app.text();
  assert.match(src, /serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(src, /location\.replace\(`\/login\?next=/, '401 이면 로그인 화면으로 보낸다');
});

test('거부: 로그인 없이 받는 파일은 정해진 것뿐 — 화면(HTML)과 데이터는 로그인 필요', async () => {
  for (const p of ['/index.html', '/api/me', '/api/inspections']) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
  }
  const page = await fetch(`${BASE}/index.html`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.ok([302, 308].includes(page.status), `/index.html → ${page.status}`);
});

// ---------- 설정이 빠진 서버 (fail closed) ----------

test('거부: 로그인 설정이 없으면 화면은 한국어 안내(503), API·설치 파일도 503', async () => {
  const port = 8797;
  const base = `http://127.0.0.1:${port}`;
  const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const bare = spawn(process.execPath, [wrangler, 'pages', 'dev', 'public', '--port', String(port), '--ip', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  try {
    let page;
    for (let i = 0; i < 120 && !page; i++) {
      try { page = await fetch(`${base}/`, { headers: { Accept: 'text/html' } }); } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert.ok(page, '설정 없는 서버가 뜨지 않음');
    assert.equal(page.status, 503);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /준비 중입니다/);
    assert.doesNotMatch(html, /GOOGLE_CLIENT_ID|ALLOWED_EMAILS|SESSION_SECRET/, '어떤 설정이 빠졌는지 화면에 드러내지 않는다');

    for (const p of ['/api/inspections', '/login', '/manifest.webmanifest', '/app.js']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 503, p);
    }
  } finally {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(bare.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    } else {
      bare.kill('SIGTERM');
    }
  }
});

// ---------- TBM → 안전 공지문 (Claude 는 고정 응답 서버) ----------

const tbmSamples = JSON.parse(readFileSync(path.join(root, 'public', 'tbm-samples.json'), 'utf8')).samples;
const tbmRecord = (id) => tbmSamples.find((s) => s.id === id).record;

async function postTbm(record, { cookie, origin = BASE } = {}) {
  return fetch(`${BASE}/api/tbm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ record }),
  });
}

test('허용: TBM 정상 기록 → 3단계까지 실행하고 공지문(5줄 이내)을 돌려준다', async () => {
  const cookie = cookieFrom(await login(idToken()));
  const before = claudeRequests.length;
  const res = await postTbm(tbmRecord('normal'), { cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.steps.map((s) => s.name), ['1단계 추출', '2단계 검사', '3단계 작성']);
  assert.ok(body.notice.lines.length >= 1 && body.notice.lines.length <= 5);
  for (const s of body.steps) {
    assert.ok('input' in s && 'output' in s && typeof s.ms === 'number', `${s.name}: 입력·출력·소요 시간`);
  }
  assert.equal(body.totals.calls, 2);

  // 실제 SDK 가 보낸 요청: 키·모델·구조화 출력·fallback
  const sent = claudeRequests.slice(before);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].headers.authorization, 'Bearer fake'); // SDK 1.x 는 API 키를 Bearer 로 보낸다
  assert.equal(sent[0].params.model, 'claude-haiku-5-5');
  assert.equal(sent[0].params.output_config.format.type, 'json_schema');
  assert.equal(sent[1].params.model, 'claude-opus-5-5');
  assert.equal(sent[1].params.fallbacks, 'default');
  assert.match(sent[1].headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
});

test('거부: TBM 대책 누락 기록 → 2단계에서 멈추고 누락 목록, 3단계 호출 없음', async () => {
  const cookie = cookieFrom(await login(idToken()));
  const before = claudeRequests.length;
  const res = await postTbm(tbmRecord('missing'), { cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'blocked');
  assert.deepEqual(body.missing.map((m) => m.hazard), ['장비와 작업자 협착', '감전']);
  assert.deepEqual(body.steps.map((s) => s.name), ['1단계 추출', '2단계 검사']);
  assert.equal(claudeRequests.length - before, 1, 'Claude 는 1단계에서 한 번만');
});

test('거부: TBM 빈 기록 → 422, Claude 호출 없음', async () => {
  const cookie = cookieFrom(await login(idToken()));
  const before = claudeRequests.length;
  const res = await postTbm(tbmRecord('empty'), { cookie });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.status, 'empty');
  assert.equal(claudeRequests.length, before);
});

test('거부: TBM API 는 로그인 필요, 다른 사이트 요청 403, GET 405', async () => {
  assert.equal((await postTbm(tbmRecord('normal'))).status, 401);
  const cookie = cookieFrom(await login(idToken()));
  assert.equal((await postTbm(tbmRecord('normal'), { cookie, origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/tbm`, { headers: { Cookie: cookie } })).status, 405);
  const page = await fetch(`${BASE}/tbm`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.equal(page.status, 302);
});

// ---------- 현장 민원 분류 (Claude 는 고정 응답 서버) ----------

const complaintSamples = JSON.parse(readFileSync(path.join(root, 'public', 'complaint-samples.json'), 'utf8')).samples;
const complaintOf = (id) => complaintSamples.find((s) => s.id === id);

async function postComplaint(body, { cookie, origin = BASE } = {}) {
  return fetch(`${BASE}/api/complaint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test('허용: 소음 민원 → Worker 분류 → 작업 예고 목록을 붙여 Agent 답변 초안', async () => {
  const cookie = cookieFrom(await login(idToken()));
  const s = complaintOf('noise-1');
  const before = claudeRequests.length;
  const res = await postComplaint({ complaint: s.complaint, date: s.date }, { cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'drafted');
  assert.equal(body.classification.category, '소음·진동');
  assert.equal(body.attachments.work_notices.length, 2);
  assert.ok(body.draft.draft.includes('07:00-12:00'), '붙인 자료의 시간대를 근거로 쓴다');
  const sent = claudeRequests.slice(before);
  assert.deepEqual(sent.map((r) => r.params.model), ['claude-haiku-5-5', 'claude-opus-5-5']);
});

test('허용: 교통 민원 → 장비 반입 예약 시간대를 붙여 답변 초안', async () => {
  const cookie = cookieFrom(await login(idToken()));
  const s = complaintOf('traffic-2');
  const body = await (await postComplaint({ complaint: s.complaint, date: s.date }, { cookie })).json();
  assert.equal(body.status, 'drafted');
  assert.deepEqual(body.attachments.equipment_bookings.map((b) => b.time), ['10:00-14:00']);
});

test('안전 민원 → 답변 초안 없이 긴급, Claude 는 분류 1회뿐', async () => {
  const cookie = cookieFrom(await login(idToken()));
  const s = complaintOf('safety-1');
  const before = claudeRequests.length;
  const body = await (await postComplaint({ complaint: s.complaint, date: s.date }, { cookie })).json();
  assert.equal(body.status, 'urgent');
  assert.equal(body.urgent, true);
  assert.equal(body.draft, undefined);
  assert.equal(claudeRequests.length - before, 1);
});

test('거부: 애매한 민원(확신도 < 0.7)·기타 → 대기열, 자동 답변 없음', async () => {
  const cookie = cookieFrom(await login(idToken()));
  for (const id of ['vague-2', 'etc-1']) {
    const s = complaintOf(id);
    const before = claudeRequests.length;
    const body = await (await postComplaint({ complaint: s.complaint, date: s.date }, { cookie })).json();
    assert.equal(body.status, 'queued', id);
    assert.equal(body.draft, undefined);
    assert.equal(claudeRequests.length - before, 1, `${id}: 답변 초안 호출 없음`);
  }
});

test('거부: 민원 API 빈 입력 422, 로그인 없음 401, 다른 사이트 403, GET 405', async () => {
  const cookie = cookieFrom(await login(idToken()));
  assert.equal((await postComplaint({ complaint: '' }, { cookie })).status, 422);
  assert.equal((await postComplaint({ complaint: '소음' })).status, 401);
  assert.equal((await postComplaint({ complaint: '소음' }, { cookie, origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/complaint`, { headers: { Cookie: cookie } })).status, 405);
  assert.equal((await fetch(`${BASE}/complaint`, { headers: { Accept: 'text/html' }, redirect: 'manual' })).status, 302);
});
