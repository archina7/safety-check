// 보도자료 작성·평가 단위 테스트: OpenAI 대신 가짜 client(고정 응답)로 API 키 없이 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPressWorkflow, mergeChecks, hypeWithoutBasis, validateDraft, validateEvaluation, CRITERIA, MAX_REVISIONS } from '../functions/_press.js';
import { fakeClient, requestText } from './helpers/ai-mock.js';

const sample = JSON.parse(readFileSync(new URL('../public/press-samples.json', import.meta.url), 'utf8'));
const factsOf = (id) => sample.samples.find((s) => s.id === id).facts;

async function run(input, opts = {}) {
  const client = opts.client || fakeClient();
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    const result = await runPressWorkflow({ rules: sample.rules, ...input }, opts.env || {}, { client });
    return { result, client, logs };
  } finally {
    console.log = orig;
  }
}

const roleOf = (r) => (requestText(r.params, 'developer').includes('작성 Agent') ? 'writer' : 'evaluator');

test('허용: 첫 초안에 근거 없는 과장 → 평가 실패 → 실패 이유만 넘겨 1회 수정 → 통과 (승인 대기)', async () => {
  const { result, client, logs } = await run({ facts: factsOf('completion') });
  assert.equal(result.status, 'passed');
  assert.equal(result.revisions, 1);
  assert.deepEqual(client.requests.map(roleOf), ['writer', 'evaluator', 'writer', 'evaluator']);
  assert.ok(client.requests.every((r) => r.params.model === 'gpt-6.2-astra' && r.params.text.format.strict === true));
  // 1차 평가: 과장 표현만 실패 (평가 Agent 와 코드 검사 모두)
  const first = result.rounds[0].results;
  assert.deepEqual(first.filter((r) => !r.pass).map((r) => r.key), ['hype']);
  assert.equal(first.find((r) => r.key === 'hype').by, '평가 Agent·코드 검사');
  // 수정 요청에는 실패한 기준의 이유만 들어간다 (통과한 기준의 이유는 넣지 않는다)
  const revise = requestText(client.requests[2].params, 'user');
  const feedback = revise.split('<feedback>')[1].split('</feedback>')[0];
  assert.match(feedback, /근거 없는 과장 표현/);
  assert.doesNotMatch(feedback, /회사명 표기를 지켰다|첫 문단에 회사/);
  assert.match(revise, /<previous>/);
  // 평가 Agent 는 초안·사실·규칙만 본다 (작성 Agent 의 이전 피드백은 넘기지 않는다)
  assert.doesNotMatch(requestText(client.requests[3].params, 'user'), /<feedback>/);
  assert.ok(result.draft.paragraphs.length <= 5);
  assert.doesNotMatch(result.draft.paragraphs.join(' '), /최초/);
  assert.deepEqual(result.results.map((r) => r.key), CRITERIA.map((c) => c.key));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'press_run');
  assert.equal(logs[0].calls, 4);
});

test('허용: 처음부터 통과하면 수정하지 않는다', async () => {
  const { result, client } = await run({ facts: factsOf('safety') });
  assert.equal(result.status, 'passed');
  assert.equal(result.revisions, 0);
  assert.equal(client.requests.length, 2);
});

test(`${MAX_REVISIONS}회 수정 뒤에도 실패가 남으면 사람 검토 필요 + 남은 실패 항목`, async () => {
  const { result, client } = await run({ facts: `${factsOf('safety')}\n비고: 고집` });
  assert.equal(result.status, 'review');
  assert.equal(result.revisions, MAX_REVISIONS);
  assert.equal(client.requests.length, 2 * (MAX_REVISIONS + 1));
  assert.deepEqual(result.results.filter((r) => !r.pass).map((r) => r.key), ['hype']);
  assert.match(result.message, /사람 검토가 필요/);
});

test('코드 검사: 평가 Agent 가 통과로 봐도 입력에 없는 숫자는 실패', async () => {
  const { result } = await run({ facts: `${factsOf('safety')}\n비고: 숫자추가` });
  const facts = result.rounds[0].results.find((r) => r.key === 'facts');
  assert.equal(facts.pass, false);
  assert.equal(facts.by, '코드 검사');
  assert.match(facts.reason, /350/);
});

test('과장 표현은 입력에 같은 말이 있으면 근거가 있는 것으로 본다', () => {
  const draft = { title: '국내 최초 공법 적용', paragraphs: ['최대 규모'] };
  assert.deepEqual(hypeWithoutBasis(draft, '국내 최초로 특허 공법 적용'), ['최대']);
  const ok = Object.fromEntries(CRITERIA.map((c) => [c.key, { pass: true, reason: 'r' }]));
  const merged = mergeChecks(ok, draft, '국내 최초');
  assert.equal(merged.results.find((r) => r.key === 'hype').pass, false);
  assert.equal(merged.results.find((r) => r.key === 'facts').pass, true);
});

test('형식 검사: 제목 한 줄, 본문 1~5문단, 기준 4개 모두', () => {
  assert.equal(validateDraft({ title: 't', paragraphs: ['a'], needs_check: [] }), null);
  assert.match(validateDraft({ title: 'a\nb', paragraphs: ['a'], needs_check: [] }), /한 줄/);
  assert.match(validateDraft({ title: 't', paragraphs: ['1', '2', '3', '4', '5', '6'], needs_check: [] }), /1~5/);
  assert.match(validateDraft({ title: 't', paragraphs: [], needs_check: [] }), /1~5/);
  assert.match(validateEvaluation({ facts: { pass: true, reason: 'r' } }), /naming/);
});

test('제목이 두 줄이면 한 번 다시 요청하고, 그래도 안 되면 오류', async () => {
  const { result, client } = await run({ facts: `${factsOf('safety')}\n비고: 줄바꿈제목` });
  assert.equal(result.status, 'error');
  assert.equal(client.requests.length, 2);
  assert.match(result.message, /제목은 한 줄/);
});

test('거부: 빈 사실·빈 규칙은 AI 를 부르지 않는다', async () => {
  for (const input of [{ facts: '' }, { facts: 'a', rules: ' ' }, { facts: 'a'.repeat(5001) }]) {
    const { result, client } = await run(input);
    assert.equal(result.status, 'invalid');
    assert.equal(client.requests.length, 0);
  }
});
