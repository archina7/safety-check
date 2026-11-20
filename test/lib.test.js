// 서버 없이 _lib.js 판정 함수를 직접 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configError, isAllowed, safeNext, makeSession, readSession } from '../functions/_lib.js';

const SECRET = 'x'.repeat(32);
const full = { GOOGLE_CLIENT_ID: 'id', ALLOWED_EMAILS: 'a@example.com', SESSION_SECRET: SECRET };

test('거부: 설정이 하나라도 빠지면 configError 가 이유를 돌려준다 (fail closed)', () => {
  assert.equal(configError(full), null);
  assert.match(configError({ ...full, GOOGLE_CLIENT_ID: '' }), /GOOGLE_CLIENT_ID/);
  assert.match(configError({ ...full, ALLOWED_EMAILS: ' , ' }), /ALLOWED_EMAILS/);
  assert.match(configError({ ...full, SESSION_SECRET: undefined }), /SESSION_SECRET/);
  assert.match(configError({ ...full, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
});

test('허용 목록: 공백·대소문자를 무시하고, 목록 밖은 거부', () => {
  const env = { ALLOWED_EMAILS: ' A@Example.com ,b@example.com' };
  assert.equal(isAllowed(env, 'a@example.com'), true);
  assert.equal(isAllowed(env, 'B@EXAMPLE.COM'), true);
  assert.equal(isAllowed(env, 'c@example.com'), false);
  assert.equal(isAllowed(env, ''), false);
  assert.equal(isAllowed(env, undefined), false);
});

test('safeNext: 같은 사이트 경로만 허용', () => {
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/?site=A'), '/?site=A');
  assert.equal(safeNext('/?site=A%20B'), '/?site=A%20B');
  // 탭·줄바꿈·공백은 브라우저가 지우거나 바꿔서 '//evil.com' 이 될 수 있다
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', null, undefined,
    '/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/ /evil.com', '/a\\b', '/\x00/evil.com', '/\x7f']) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
});

test('세션: 같은 비밀값으로만 읽히고, 점이 더 붙은 값은 거부', async () => {
  const v = await makeSession({ email: 'a@example.com', name: '가' }, SECRET);
  assert.deepEqual(await readSession(v, SECRET), { email: 'a@example.com', name: '가' });
  assert.equal(await readSession(v, 'y'.repeat(32)), null);
  assert.equal(await readSession(`${v}.extra`, SECRET), null);
  assert.equal(await readSession('', SECRET), null);
});
