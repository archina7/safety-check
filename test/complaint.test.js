// 민원 분류·처리 단위 테스트: Claude 대신 가짜 client(고정 응답)로 API 키 없이 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runComplaintWorkflow, decideRoute, validateClassification, validateDraft, todayKst, isValidDate, CATEGORIES, CONFIDENCE_THRESHOLD } from '../functions/_complaint.js';
import { fakeClient } from './helpers/claude-mock.js';

const { samples } = JSON.parse(readFileSync(new URL('../public/complaint-samples.json', import.meta.url), 'utf8'));
const env = {};

async function run(input, opts = {}) {
  const client = opts.client || fakeClient();
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    const result = await runComplaintWorkflow(input, opts.env || env, { client, now: opts.now });
    return { result, client, logs };
  } finally {
    console.log = orig;
  }
}

// 합성 민원 12건의 기대 결과
const EXPECTED = {
  'noise-1': { status: 'drafted', category: '소음·진동', attach: 'work_notices', count: 2 },
  'noise-2': { status: 'drafted', category: '소음·진동', attach: 'work_notices', count: 2 },
  'traffic-1': { status: 'drafted', category: '교통·주차', attach: 'equipment_bookings', count: 2 },
  'traffic-2': { status: 'drafted', category: '교통·주차', attach: 'equipment_bookings', count: 1 },
  'safety-1': { status: 'urgent', category: '안전' },
  'safety-2': { status: 'urgent', category: '안전' },
  'dust-1': { status: 'queued', category: '먼지' },
  'dust-2': { status: 'queued', category: '먼지' },
  'etc-1': { status: 'queued', category: '기타' },
  'etc-2': { status: 'queued', category: '기타' },
  'vague-1': { status: 'queued', category: '기타' },
  'vague-2': { status: 'queued', category: '소음·진동' },
};

test('합성 민원: 유형별 2건씩(5유형 10건) + 애매한 민원 2건', () => {
  const groups = samples.reduce((a, s) => ({ ...a, [s.group]: (a[s.group] || 0) + 1 }), {});
  assert.deepEqual(groups, { '소음·진동': 2, '교통·주차': 2, 안전: 2, 먼지: 2, 기타: 2, 애매: 2 });
  assert.deepEqual(Object.keys(EXPECTED).sort(), samples.map((s) => s.id).sort());
});

for (const s of samples) {
  test(`${s.group} ${s.id}: ${EXPECTED[s.id].status}`, async () => {
    const exp = EXPECTED[s.id];
    const { result, client, logs } = await run({ complaint: s.complaint, date: s.date });
    assert.equal(result.status, exp.status);
    assert.equal(result.classification.category, exp.category);
    assert.equal(typeof result.classification.reason, 'string');
    assert.ok(result.classification.confidence >= 0 && result.classification.confidence <= 1);

    // 분류는 Worker 모델
    assert.equal(client.requests[0].params.model, 'claude-haiku-5-5');
    assert.equal(client.requests[0].params.output_config.format.type, 'json_schema');

    if (exp.status === 'drafted') {
      // 답변 초안은 Agent 모델, 해당 날짜 자료를 붙인다
      assert.equal(client.requests.length, 2);
      assert.equal(client.requests[1].params.model, 'claude-opus-5-5');
      assert.equal(client.requests[1].params.fallbacks, 'default');
      const list = result.attachments[exp.attach];
      assert.equal(list.length, exp.count);
      assert.ok(list.every((x) => x.date === s.date), '해당 날짜 자료만');
      assert.ok(result.draft.draft.length > 0);
      assert.deepEqual(result.draft.unsupported_numbers, []);
      assert.deepEqual(result.steps.map((x) => x.name), ['1단계 분류', '2단계 처리 방식', '3단계 답변 초안']);
    } else {
      // 대기열·긴급은 답변 초안을 만들지 않는다 (Claude 는 분류 1회뿐)
      assert.equal(client.requests.length, 1);
      assert.equal(result.draft, undefined);
      assert.deepEqual(result.steps.map((x) => x.name), ['1단계 분류', '2단계 처리 방식']);
    }
    if (exp.status === 'urgent') {
      assert.equal(result.urgent, true);
      assert.equal(result.label, '긴급');
    }
    if (exp.status === 'queued') assert.equal(result.label, '담당자 확인 대기');

    // 실행마다 호출 수·토큰 로그
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'complaint_run');
    assert.equal(logs[0].calls, client.requests.length);
    assert.equal(logs[0].input_tokens, result.totals.input_tokens);
  });
}

test('확신도 경계: 0.7 은 통과(답변 초안), 0.7 미만은 대기열', () => {
  assert.equal(decideRoute({ category: '소음·진동', confidence: 0.7 }, '2026-11-24').route, 'draft');
  assert.equal(decideRoute({ category: '소음·진동', confidence: 0.69 }, '2026-11-24').route, 'queue');
  assert.equal(decideRoute({ category: '교통·주차', confidence: 0.2 }, '2026-11-24').route, 'queue');
  assert.equal(decideRoute({ category: '기타', confidence: 0.99 }, '2026-11-24').route, 'queue');
});

test('화면이 쓸 확신도 기준은 서버가 판정에 쓴 값을 그대로 보낸다', async () => {
  for (const complaint of ['쿵쿵 소리', '언제쯤 끝나나요', '펜스가 흔들려요']) {
    const { result } = await run({ complaint, date: '2026-11-24' });
    assert.equal(result.confidence_threshold, CONFIDENCE_THRESHOLD, complaint);
  }
  const ui = readFileSync(new URL('../public/complaint.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /0\.7/, '화면 코드에 기준값을 따로 적지 않는다');
  assert.match(ui, /r\.confidence_threshold/);
});

test('안전은 확신도가 낮아도 긴급, 대신 분류 확인 필요 표시', async () => {
  const { result, client } = await run({ complaint: '안전애매 — 뭔가 이상해요', date: '2026-11-24' });
  assert.equal(result.status, 'urgent');
  assert.equal(result.needs_review, true);
  assert.equal(client.requests.length, 1);
  assert.equal(decideRoute({ category: '안전', confidence: 0.95 }, '2026-11-24').needs_review, false);
});

test('해당 날짜 일정이 없으면 빈 목록을 붙이고, 초안은 확인 필요로 남긴다', async () => {
  const { result } = await run({ complaint: '드릴 소리가 심합니다', date: '2026-12-01' });
  assert.equal(result.status, 'drafted');
  assert.deepEqual(result.attachments.work_notices, []);
  assert.ok(result.draft.needs_check.length > 0);
});

test('근거 없는 숫자가 초안에 나오면 표시한다', async () => {
  const { result } = await run({ complaint: '쿵쿵 소리 근거없는숫자', date: '2026-11-24' });
  assert.deepEqual(result.draft.unsupported_numbers, ['5']); // 첨부의 '52m' 와 겹쳐도 숫자 단위로 비교
});

test('거부: 빈 민원·잘못된 날짜는 Claude 를 부르지 않는다', async () => {
  for (const input of [{ complaint: '' }, { complaint: '   ' }, {}, { complaint: '쿵쿵', date: '2026-02-30' }, { complaint: '쿵쿵', date: '11/24' }]) {
    const { result, client } = await run(input);
    assert.equal(result.status, 'invalid', JSON.stringify(input));
    assert.equal(client.requests.length, 0);
  }
});

test('날짜를 비우면 한국 시간 오늘로 처리한다', async () => {
  const now = Date.parse('2026-11-23T16:30:00Z'); // 한국 시간 11월 24일 01:30
  assert.equal(todayKst(now), '2026-11-24');
  const { result } = await run({ complaint: '쿵쿵 소리', date: '' }, { now });
  assert.equal(result.date, '2026-11-24');
  assert.equal(result.attachments.work_notices.length, 2);
});

test('거부: 확신도가 0~1 을 벗어나면 다시 요청하고, 그래도 안 되면 오류', async () => {
  const { result, client } = await run({ complaint: '확신도오류', date: '2026-11-24' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /confidence/);
  assert.equal(client.requests.length, 2);
});

test('모델은 환경 변수로 바꿀 수 있다', async () => {
  const { client } = await run({ complaint: '쿵쿵', date: '2026-11-24' }, { env: { CLAUDE_MODEL: 'claude-sonnet-5-5', CLAUDE_WORKER_MODEL: 'claude-haiku-4-5' } });
  assert.deepEqual(client.requests.map((r) => r.params.model), ['claude-haiku-4-5', 'claude-sonnet-5-5']);
});

test('스키마 검사 함수', () => {
  assert.deepEqual(CATEGORIES, ['소음·진동', '교통·주차', '안전', '먼지', '기타']);
  assert.equal(validateClassification({ category: '먼지', reason: 'x', confidence: 0 }), null);
  assert.match(validateClassification({ category: '공사', reason: 'x', confidence: 0.5 }), /category/);
  assert.match(validateClassification({ category: '먼지', reason: '', confidence: 0.5 }), /reason/);
  assert.match(validateClassification({ category: '먼지', reason: 'x', confidence: '0.9' }), /confidence/);
  assert.equal(validateDraft({ draft: '안녕하세요', needs_check: [] }), null);
  assert.match(validateDraft({ draft: 'a'.repeat(801), needs_check: [] }), /800/);
  assert.equal(isValidDate('2026-11-24'), true);
  assert.equal(isValidDate('2026-13-01'), false);
});
