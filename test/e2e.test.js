// wrangler pages dev 를 실제로 띄워서 화면과 API의 허용·거부 경우를 확인한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799; // npm run dev(8788)와 겹치지 않게
const BASE = `http://127.0.0.1:${PORT}`;
let server;

async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (server.exitCode !== null) throw new Error('wrangler pages dev 가 시작 중에 종료됨');
    try {
      const res = await fetch(`${BASE}/api/inspections`);
      if (res.ok) return;
    } catch {
      // 아직 준비 안 됨
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler pages dev 가 제때 뜨지 않음');
}

before(async () => {
  const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  server = spawn(process.execPath, [wrangler, 'pages', 'dev', 'public', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  await waitForServer();
});

after(() => {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    // workerd 자식 프로세스까지 함께 종료
    try { execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    server.kill('SIGTERM');
  }
});

// 허용: 점검 항목 조회
test('GET /api/inspections 는 점검 항목 6개를 돌려준다', async () => {
  const res = await fetch(`${BASE}/api/inspections`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const { items } = await res.json();
  assert.equal(items.length, 6);
  for (const it of items) {
    for (const key of ['id', 'category', 'content', 'law']) {
      assert.equal(typeof it[key], 'string', `${key} 누락`);
      assert.ok(it[key].length > 0, `${key} 비어 있음`);
    }
  }
  assert.equal(new Set(items.map((it) => it.id)).size, 6, 'id 중복');
});

// 거부: 읽기 전용 API에 쓰기 요청
for (const method of ['POST', 'PUT', 'DELETE']) {
  test(`${method} /api/inspections 는 405로 거부한다`, async () => {
    const res = await fetch(`${BASE}/api/inspections`, { method, body: method === 'DELETE' ? undefined : '{}' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  });
}

// 허용: 화면
test('GET / 는 한국어 점검 화면을 돌려준다', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /오늘의 안전점검/);
  assert.match(html, /name="viewport"/);
});
