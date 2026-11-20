// 점검표 체크 기록 옮기기(public/app.js 의 records 구간) 단위 테스트.
// app.js 는 브라우저 스크립트라 표시된 구간만 떼어 가짜 저장소로 실행한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const after = src.split('// records:start')[1] ?? '';
const part = after.slice(after.indexOf('\n')).split('// records:end')[0];
const ctx = {};
vm.runInNewContext(`${part}\nthis.migrate = migrateUnattributedRecords;`, ctx);
const migrate = ctx.migrate;

// localStorage 와 같은 모양의 가짜 저장소
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

const DAY = '2026-11-20';
const ME = 'kim@example.com';

test('구간을 찾았다', () => {
  assert.equal(typeof migrate, 'function');
});

test('허용: 업데이트 전 오늘 체크한 항목은 로그인한 사람의 기록으로 옮겨진다', () => {
  const s = fakeStorage({ [`safety-check:${DAY}`]: JSON.stringify(['a', 'b', 'c']) });
  migrate(s, ME, DAY);
  assert.deepEqual(s.dump(), { [`safety-check:${ME}:${DAY}`]: JSON.stringify(['a', 'b', 'c']) });
});

test('허용: 새 기록이 이미 있으면 합친다 (중복 없이)', () => {
  const s = fakeStorage({
    [`safety-check:${DAY}`]: JSON.stringify(['a', 'b']),
    [`safety-check:${ME}:${DAY}`]: JSON.stringify(['b', 'd']),
  });
  migrate(s, ME, DAY);
  assert.deepEqual(JSON.parse(s.getItem(`safety-check:${ME}:${DAY}`)).sort(), ['a', 'b', 'd']);
  assert.equal(s.getItem(`safety-check:${DAY}`), null);
});

test('거부: 지난 날짜의 옛 기록은 누구 것인지 몰라 옮기지 않고 지운다', () => {
  const s = fakeStorage({
    'safety-check:2026-11-19': JSON.stringify(['x']),
    'safety-check:other@example.com:2026-11-19': JSON.stringify(['y']),
  });
  migrate(s, ME, DAY);
  assert.deepEqual(s.dump(), { 'safety-check:other@example.com:2026-11-19': JSON.stringify(['y']) });
});

test('거부: 옛 기록이 깨져 있으면 옮기지 않고 지우기만 한다', () => {
  const s = fakeStorage({ [`safety-check:${DAY}`]: '{깨진' });
  migrate(s, ME, DAY);
  assert.deepEqual(s.dump(), {});
});

test('거부: 사용자를 모르면 옮기지 않는다', () => {
  const s = fakeStorage({ [`safety-check:${DAY}`]: JSON.stringify(['a']) });
  migrate(s, '', DAY);
  assert.deepEqual(s.dump(), {});
});
