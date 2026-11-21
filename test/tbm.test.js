// TBM 워크플로 단위 테스트: OpenAI 대신 가짜 client(고정 응답)를 써서 API 키 없이 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTbmWorkflow, checkMeasures, validateExtraction, validateNotice, unsupportedNumbers } from '../functions/_tbm.js';
import { fakeClient } from './helpers/ai-mock.js';

const { samples } = JSON.parse(readFileSync(new URL('../public/tbm-samples.json', import.meta.url), 'utf8'));
const sample = (id) => samples.find((s) => s.id === id).record;
const env = {}; // 모델 기본값을 쓴다

// console.log 실행 로그를 잠시 모아 본다
async function withLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(line);
  try {
    return { result: await fn(), logs: logs.map((l) => JSON.parse(l)) };
  } finally {
    console.log = orig;
  }
}

test('합성 기록 3건이 있다 (정상·대책 누락·빈 기록)', () => {
  assert.deepEqual(samples.map((s) => s.id), ['normal', 'missing', 'empty']);
});

test('허용: 정상 기록 → 1단계 추출 → 2단계 통과 → 3단계 공지문 (5줄 이내)', async () => {
  const client = fakeClient();
  const { result, logs } = await withLogs(() => runTbmWorkflow(sample('normal'), env, { client }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.steps.map((s) => s.name), ['1단계 추출', '2단계 검사', '3단계 작성']);
  assert.ok(result.notice.lines.length >= 1 && result.notice.lines.length <= 5);
  assert.deepEqual(result.notice.unsupported_numbers, []);

  // 모델·구조화 출력(strict)·reasoning effort 설정
  const [extract, write] = client.requests;
  assert.equal(extract.params.model, 'gpt-6-luna');
  assert.equal(extract.params.text.format.type, 'json_schema');
  assert.equal(write.params.model, 'gpt-6.2-astra');
  assert.equal(write.params.text.format.strict, true);
  assert.equal(write.params.reasoning.effort, 'medium');
  assert.ok(!('temperature' in write.params), 'GPT-6.2 는 temperature 를 받지 않는다');
  assert.ok(!('reasoning' in extract.params), 'Worker 는 모델 기본 effort');

  // 3단계 입력은 2단계를 통과한 항목뿐
  assert.deepEqual(result.steps[2].input.items, result.steps[1].output.passed);

  // 단계마다 소요 시간, 실행마다 호출 수·토큰 로그
  for (const s of result.steps) assert.equal(typeof s.ms, 'number');
  assert.equal(result.totals.calls, 2);
  assert.ok(result.totals.input_tokens > 0 && result.totals.output_tokens > 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'tbm_run');
  assert.equal(logs[0].calls, 2);
  assert.equal(logs[0].input_tokens, result.totals.input_tokens);
});

test('거부: 대책 누락 기록 → 2단계에서 멈추고 누락 목록, 3단계 호출 없음', async () => {
  const client = fakeClient();
  const { result } = await withLogs(() => runTbmWorkflow(sample('missing'), env, { client }));
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.steps.map((s) => s.name), ['1단계 추출', '2단계 검사']);
  assert.deepEqual(result.missing, [
    { task: '굴착기 터파기', hazard: '장비와 작업자 협착' },
    { task: '임시 분전반 연결', hazard: '감전' },
  ]);
  assert.equal(client.requests.length, 1, '3단계(작성) AI 호출이 없어야 한다');
  assert.equal(result.notice, undefined);
});

test('거부: 빈 기록 → 입력 검사에서 멈추고 AI를 부르지 않는다', async () => {
  for (const record of [sample('empty'), '   \n  ', undefined, null, 123]) {
    const client = fakeClient();
    const { result } = await withLogs(() => runTbmWorkflow(record, env, { client }));
    assert.equal(result.status, 'empty', String(record));
    assert.equal(client.requests.length, 0);
    assert.equal(result.totals.calls, 0);
  }
});

test('거부: 기록에서 위험요인을 하나도 못 찾으면 2단계에서 멈춘다', async () => {
  const client = fakeClient();
  const { result } = await withLogs(() => runTbmWorkflow('항목없음 — 오늘은 회의만 했다', env, { client }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.steps[1].output.total, 0);
  assert.equal(client.requests.length, 1);
});

test('스키마가 안 맞으면 한 번 다시 요청해서 통과한다', async () => {
  const client = fakeClient();
  const { result } = await withLogs(() => runTbmWorkflow('재시도 기록 A', env, { client }));
  assert.equal(result.status, 'ok');
  assert.equal(result.steps[0].calls.length, 2);
  assert.match(client.requests[1].params.input[1].content, /형식 규칙을 어겼습니다/);
});

test('거부: 두 번 다 스키마가 안 맞으면 오류로 처리하고 더 부르지 않는다', async () => {
  const client = fakeClient();
  const { result } = await withLogs(() => runTbmWorkflow('항상실패 기록', env, { client }));
  assert.equal(result.status, 'error');
  assert.match(result.message, /스키마에 맞지 않습니다 \(2회 시도\)/);
  assert.equal(client.requests.length, 2);
});

test('거부: 공지문이 5줄을 넘으면 다시 요청하고, 그래도 넘으면 오류', async () => {
  const client = fakeClient();
  // 추출은 정상 항목, 작성 요청 본문에 '여섯줄' 이 들어가도록 항목 이름을 바꾼다
  const orig = client.responses.create;
  client.responses.create = async (p) => {
    const r = await orig(p);
    r.output[0].content[0].text = r.output[0].content[0].text.replace('철근 배근', '여섯줄 테스트');
    return r;
  };
  const { result } = await withLogs(() => runTbmWorkflow(sample('normal'), env, { client }));
  assert.equal(result.status, 'error');
  assert.match(result.message, /줄 수 6/);
  assert.equal(result.steps.at(-1).calls.length, 2);
});

test('거부: AI가 거절(refusal)하면 오류로 처리한다', async () => {
  const client = fakeClient();
  const { result } = await withLogs(() => runTbmWorkflow('거절 기록', env, { client }));
  assert.equal(result.status, 'error');
  assert.match(result.message, /거절/);
});

test('모델은 OPENAI_MODEL·OPENAI_WORKER_MODEL 환경 변수로 바꿀 수 있다', async () => {
  const client = fakeClient();
  await withLogs(() => runTbmWorkflow(sample('normal'), { OPENAI_MODEL: 'gpt-6.2-sol', OPENAI_WORKER_MODEL: 'gpt-6.1-terra' }, { client }));
  assert.deepEqual(client.requests.map((r) => r.params.model), ['gpt-6.1-terra', 'gpt-6.2-sol']);
});

test('2단계 검사(코드): 공백만 있는 대책은 대책으로 치지 않는다', () => {
  const r = checkMeasures([
    { task: 'A', hazard: '추락', measures: ['안전대'] },
    { task: 'B', hazard: '감전', measures: ['  ', ''] },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [{ task: 'B', hazard: '감전' }]);
  assert.deepEqual(r.passed, [{ task: 'A', hazard: '추락', measures: ['안전대'] }]);
  assert.equal(checkMeasures([]).ok, false);
});

test('스키마 검사 함수', () => {
  assert.equal(validateExtraction({ items: [] }), null);
  assert.match(validateExtraction({ items: [{ task: '', hazard: 'x', measures: [] }] }), /task/);
  assert.match(validateExtraction({ items: [{ task: 'a', hazard: 'x', measures: [1] }] }), /measures/);
  assert.match(validateExtraction({}), /items/);
  assert.equal(validateNotice({ lines: ['a'], needs_check: [] }), null);
  assert.match(validateNotice({ lines: [], needs_check: [] }), /줄 수 0/);
  assert.match(validateNotice({ lines: ['a', ' '], needs_check: [] }), /빈 줄/);
});

test('근거 없는 수치 표시: 공지문의 숫자가 입력 항목에 없으면 알려 준다', () => {
  const items = [{ task: '비계', hazard: '추락', measures: ['폭 40cm 작업발판'] }];
  assert.deepEqual(unsupportedNumbers(['작업발판 폭 40cm 를 지키십시오.'], items), []);
  assert.deepEqual(unsupportedNumbers(['2m 이상에서는 안전대를 거십시오.'], items), ['2']);
});
