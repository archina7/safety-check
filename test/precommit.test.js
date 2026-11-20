// .githooks/pre-commit 테스트: 임시 저장소에서 실제로 커밋해 본다.
// 한글·공백이 든 파일 이름도 검사를 건너뛰지 않는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../.githooks', import.meta.url));
// 이 파일 자체가 훅에 걸리지 않게 키 모양 문자열은 이어 붙여 만든다
const FAKE_KEY = ['sk', 'ant', 'a'.repeat(30)].join('-');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'core.hooksPath', HOOKS);
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function tryCommit(files) {
  const r = repo();
  try {
    for (const [name, body] of Object.entries(files)) {
      const p = join(r.dir, name);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
      r.git('add', '--', name);
    }
    r.git('commit', '-q', '-m', 't');
    return true;
  } catch {
    return false;
  } finally {
    r.done();
  }
}

test('허용: 평범한 파일은 한글·공백 이름이어도 커밋된다', () => {
  assert.equal(tryCommit({ '회의 노트.txt': '오늘 회의 내용' }), true);
});

test('거부: 한글·공백 이름 파일 안의 API 키도 막는다', () => {
  assert.equal(tryCommit({ '회의 노트.txt': `키 ${FAKE_KEY}` }), false);
});

test('거부: 한글 폴더 안의 .env 파일도 막는다', () => {
  assert.equal(tryCommit({ '메모/.env': 'X=1' }), false);
});

test('거부: 영문 이름 파일의 키와 .dev.vars 는 전처럼 막는다', () => {
  assert.equal(tryCommit({ 'a.txt': FAKE_KEY }), false);
  assert.equal(tryCommit({ '.dev.vars': 'X=1' }), false);
  assert.equal(tryCommit({ '.dev.vars.example': 'X=' }), true);
});
