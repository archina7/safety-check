// 현장 질의 Agent 단위 테스트: OpenAI 대신 가짜 client(고정 응답)로 API 키 없이 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSiteQa, checkArgs, TOOLS, TOOL_DEFS, MAX_TOOL_CALLS } from '../functions/_site-qa.js';
import * as data from '../functions/_site-qa-data.js';
import { fakeClient } from './helpers/ai-mock.js';

const NOW = Date.UTC(2026, 10, 24, 0, 0); // 2026-11-24 09:00 한국 시각

async function run(question, opts = {}) {
  const client = opts.client || fakeClient();
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    const result = await runSiteQa({ question }, opts.env || {}, { client, now: NOW });
    return { result, client, logs };
  } finally {
    console.log = orig;
  }
}

test('도구 3개: 입력 JSON Schema·설명·strict, 읽기 전용 (쓰기·삭제 도구 없음)', () => {
  assert.deepEqual(TOOL_DEFS.map((t) => t.name), ['get_progress', 'get_workforce', 'get_inspections']);
  for (const t of TOOL_DEFS) {
    assert.equal(t.type, 'function');
    assert.equal(t.strict, true);
    assert.ok(t.description.length > 10);
    assert.equal(t.parameters.additionalProperties, false);
    assert.deepEqual(t.parameters.required, Object.keys(t.parameters.properties));
  }
  assert.ok(TOOL_DEFS.every((t) => /^get_/.test(t.name)));
  // 데이터 모듈은 읽기 함수만 내보내고, 자료는 얼려 있다
  assert.deepEqual(Object.keys(data).filter((k) => typeof data[k] === 'function').sort(), ['openInspectionsOn', 'progressOf', 'workforceOn']);
  const rows = data.workforceOn('2026-11-24');
  assert.throws(() => { rows[0].workers = 0; });
  assert.equal(data.workforceOn('2026-11-24')[0].workers, 44);
  const src = readFileSync(new URL('../functions/_site-qa.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(set|update|delete|remove|insert|write)_[a-z]+/);
});

test('인자 검사: strict 와 같은 규칙 (추가 인자·enum·날짜 형식·없는 날짜)', () => {
  const [progress, workforce] = TOOLS;
  assert.deepEqual(checkArgs(progress, '{"trade":"골조"}'), { args: { trade: '골조' } });
  assert.match(checkArgs(progress, '{"trade":"도배"}').error, /중 하나/);
  assert.match(checkArgs(progress, '{"trade":"골조","x":1}').error, /허용되지 않은/);
  assert.match(checkArgs(workforce, '{}').error, /문자열/);
  assert.match(checkArgs(workforce, '{"date":"어제"}').error, /YYYY-MM-DD/);
  assert.match(checkArgs(workforce, '{"date":"2026-02-30"}').error, /없는 날짜/);
  assert.match(checkArgs(workforce, 'not json').error, /JSON/);
});

test('허용: 질문에 필요한 도구만 부른다 (출역 질문 → get_workforce 하나), 조회 조건 표는 코드가 만든다', async () => {
  const { result, client, logs } = await run('오늘 출역 인원 알려줘');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tools_used, [{ n: 1, tool: 'get_workforce', condition: '날짜 = 2026-11-24', rows: 4, error: null }]);
  assert.match(result.answer, /합계 77명/);
  assert.deepEqual(result.unsupported_numbers, []);
  assert.equal(client.requests.length, 2);
  const p = client.requests[0].params;
  assert.equal(p.model, 'gpt-6.2-astra');
  assert.equal(p.tools.length, 3);
  assert.ok(p.tools.every((t) => t.strict === true));
  assert.equal(p.text.format.strict, true);
  // 두 번째 요청에 모델의 호출 항목과 도구 결과가 call_id 로 이어져 들어간다
  const second = client.requests[1].params.input;
  const call = second.find((x) => x.type === 'function_call');
  const out = second.find((x) => x.type === 'function_call_output');
  assert.equal(out.call_id, call.call_id);
  assert.equal(JSON.parse(out.output).total_workers, 77);
  assert.equal(logs[0].event, 'site_qa_run');
  assert.equal(logs[0].calls, 2);
});

test('허용: 여러 도구가 필요한 질문은 필요한 것만 (공정+점검 → 2개, 출역은 안 부름)', async () => {
  const { result } = await run('골조 공정률이랑 11월 21일 미완료 점검 항목은?');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tools_used.map((u) => [u.tool, u.condition]), [['get_progress', '공종 = 골조'], ['get_inspections', '날짜 = 2026-11-21']]);
  assert.match(result.answer, /골조 계획 62% 실적 55.4% \(차이 -6.6%p\)/);
  assert.match(result.answer, /미완료 점검 2건/);
});

test(`도구 호출이 ${MAX_TOOL_CALLS}회를 넘으면 멈추고 지금까지 찾은 내용으로만 답한다`, async () => {
  const { result, client } = await run('반복 출역 조회');
  assert.equal(result.status, 'limit');
  assert.equal(result.tools_used.length, MAX_TOOL_CALLS);
  assert.match(result.message, /5회를 넘어 멈췄습니다/);
  // 6번째 호출은 실행하지 않고, 다음 요청은 도구 없이(tool_choice none) 답하게 한다
  const last = client.requests.at(-1).params;
  assert.equal(last.tool_choice, 'none');
  assert.match(result.answer, /출역 합계/);
  const skipped = last.input.filter((x) => x.type === 'function_call_output').at(-1);
  assert.match(JSON.parse(skipped.output).error, /한도 5회/);
});

test('한 번에 여러 호출(병렬)이 와도 한도를 넘는 호출은 실행하지 않는다', async () => {
  const { result } = await run('반복 동시 출역 조회');
  assert.equal(result.status, 'limit');
  assert.equal(result.tools_used.length, MAX_TOOL_CALLS);
});

test('잘못된 인자는 실행하지 않고 오류를 도구 결과로 돌려준다 (호출 수에는 넣는다)', async () => {
  const { result } = await run('잘못된인자 출역 인원');
  assert.equal(result.status, 'ok');
  assert.equal(result.tools_used[0].error, 'date 는 YYYY-MM-DD 형식');
  assert.equal(result.tools_used[0].rows, null);
  assert.equal(result.tools_used[1].condition, '날짜 = 2026-11-24');
});

test('도구 결과에 없는 숫자는 표시한다', async () => {
  const { result } = await run('출역 인원 근거없음');
  assert.deepEqual(result.unsupported_numbers, ['999']);
});

test('최종 답 형식이 틀리면 한 번 다시 요청한다', async () => {
  const { result, client } = await run('출역 인원 형식오류');
  assert.equal(result.status, 'ok');
  assert.equal(client.requests.length, 3);
});

test('자료가 없는 날은 빈 결과로 답한다 (일요일 11월 22일)', async () => {
  const { result } = await run('11월 22일 출역 인원');
  assert.equal(result.tools_used[0].rows, 0);
  assert.match(result.answer, /자료가 없습니다/);
});

test('거부: 빈 질문·너무 긴 질문은 AI 를 부르지 않는다', async () => {
  for (const q of ['', ' ', 'a'.repeat(501)]) {
    const { result, client } = await run(q);
    assert.equal(result.status, 'invalid');
    assert.equal(client.requests.length, 0);
  }
});
