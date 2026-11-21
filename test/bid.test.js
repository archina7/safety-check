// 입찰공고 우선순위 단위 테스트: OpenAI 대신 가짜 client(고정 응답)로 API 키 없이 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  runBidWorkflow, parseBidTable, parseAmount, parseDeadline, daysLeft, selectTasks, mapLimit,
  validateWorker, validateOrchestrator, MAX_TASKS, WORKER_CONCURRENCY,
} from '../functions/_bid.js';
import { rank, score, deadlinePoints, weightProblem, DEFAULT_WEIGHTS } from '../public/bid-score.js';
import { fakeClient, mockReply, requestText } from './helpers/ai-mock.js';

const sample = JSON.parse(readFileSync(new URL('../public/bid-samples.json', import.meta.url), 'utf8'));
// 2026-11-21 09:00 (한국 시각)
const NOW = Date.UTC(2026, 10, 21, 0, 0);

const HEAD = ['공고번호', '공고명', '발주기관', '공종', '지역', '추정가격', '마감일시', '참가자격'];
function dateAfter(days, time) {
  const d = new Date(NOW + 9 * 3600 * 1000 + days * 86_400_000);
  return `${d.toISOString().slice(0, 10)} ${time}`;
}
function tableOf(bids) {
  return [HEAD.join('\t'), ...bids.map((b) => [b.id, b.title, b.agency, b.trade, b.region, b.amount, dateAfter(b.days, b.time), b.qualification].join('\t'))].join('\n');
}
const SAMPLE_TABLE = tableOf(sample.bids);

async function run(input, opts = {}) {
  const client = opts.client || fakeClient();
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    const result = await runBidWorkflow({ company: sample.company, bids: SAMPLE_TABLE, ...input }, opts.env || {}, { client, now: NOW });
    return { result, client, logs };
  } finally {
    console.log = orig;
  }
}

const workerCalls = (client) => client.requests.filter((r) => requestText(r.params, 'developer').includes('입찰공고 검토 Worker'));

test('표 읽기: 탭·| 구분, 머리글 별칭, 금액·마감 형식', () => {
  const t = parseBidTable('| 번호 | 건명 | 금액 | 마감 |\n|---|---|---|---|\n| A-1 | 신축 | 1,000원 | 2026.11.30 |');
  assert.equal(t.bids.length, 1);
  assert.equal(t.bids[0].amount, 1000);
  assert.equal(t.bids[0].deadline, '2026-11-30 23:59');
  assert.match(parseBidTable('공고번호,공고명\nA,B').error, /엑셀/);
  assert.match(parseBidTable('공고번호\t공고명\t마감일시\nA\tB\t2026-11-30').error, /추정가격/);
  assert.match(parseBidTable(`${HEAD.join('\t')}\nA\tB\t\t\t\t12억\t2026-11-30 10:00\t`).error, /원 단위/);
  assert.match(parseBidTable(`${HEAD.join('\t')}\nA\tB\t\t\t\t100\t2026-02-30\t\nA\tB\t\t\t\t100\t2026-03-01\t`).error, /마감일시/);
  assert.match(parseBidTable(`${HEAD.join('\t')}\nA\tB\t\t\t\t100\t2026-03-01\t\nA\tC\t\t\t\t100\t2026-03-01\t`).error, /두 번/);
  assert.equal(parseAmount('12,300,000,000'), 12300000000);
  assert.equal(parseAmount('12,30,0'), null);
  assert.equal(parseAmount('0'), null);
});

test('마감 남은 일수: 한국 날짜 기준, 오늘 마감은 0, 지난 마감은 음수', () => {
  assert.equal(daysLeft(parseDeadline('2026-11-21 18:00').at, NOW), 0);
  assert.equal(daysLeft(parseDeadline('2026-11-22 00:10').at, NOW), 1);
  assert.equal(daysLeft(parseDeadline('2026-11-20 18:00').at, NOW), -1);
});

test('Orchestrator 작업 만들기: 마감 지난 공고 제외, 금액 순 상위 10건, 나머지는 따로', () => {
  const { tasks, overflow, expired } = selectTasks(parseBidTable(SAMPLE_TABLE).bids, NOW);
  assert.equal(tasks.length, MAX_TASKS);
  assert.deepEqual(tasks.slice(0, 3).map((b) => b.id), ['2026-B-0105', '2026-B-0107', '2026-B-0108']);
  assert.deepEqual(overflow.map((b) => b.id), ['2026-B-0112', '2026-B-0106']);
  assert.deepEqual(expired.map((b) => b.id), ['2026-B-0113']);
});

test('mapLimit: 동시에 3개까지만, 실패해도 나머지는 끝까지', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    if (n === 4) throw new Error('x');
    return n * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(out[6].value, 70);
});

test('점수 계산식: 가중 평균, 참가 불가는 뒤로, 가중치 검사', () => {
  const p = { trade: 100, region: 0, deadline: 100, qualification: 50 };
  assert.equal(score(p, { trade: 1, region: 1, deadline: 1, qualification: 1 }), 62.5);
  assert.equal(score(p, { trade: 1, region: 0, deadline: 0, qualification: 0 }), 100);
  assert.deepEqual([deadlinePoints(0), deadlinePoints(2), deadlinePoints(3), deadlinePoints(6), deadlinePoints(7)], [30, 30, 70, 70, 100]);
  const rows = rank([
    { id: 'a', amount: 1, days: 5, eligible: false, points: { trade: 100, region: 100, deadline: 100, qualification: 100 } },
    { id: 'b', amount: 1, days: 5, eligible: true, points: { trade: 20, region: 100, deadline: 100, qualification: 100 } },
  ], DEFAULT_WEIGHTS);
  assert.deepEqual(rows.map((r) => [r.id, r.rank]), [['b', 1], ['a', 2]]);
  assert.equal(weightProblem(DEFAULT_WEIGHTS), null);
  assert.match(weightProblem({ trade: 0, region: 0, deadline: 0, qualification: 0 }), /하나 이상/);
  assert.match(weightProblem({ ...DEFAULT_WEIGHTS, trade: 11 }), /0~10/);
  assert.match(weightProblem({ ...DEFAULT_WEIGHTS, trade: 1.5 }), /정수/);
});

test('허용: 예시 13건 → Worker 10건(Worker 모델, 동시 3개) → 코드 점수 → Orchestrator 이유 (Agent 모델)', async () => {
  let running = 0;
  let peak = 0;
  const requests = [];
  const create = async (params) => {
    requests.push({ params });
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return mockReply(params);
  };
  const { result, logs } = await run({}, { client: { requests, responses: { create } } });
  assert.equal(result.status, 'ok');
  assert.equal(peak, WORKER_CONCURRENCY);
  const workers = requests.filter((r) => requestText(r.params, 'developer').includes('입찰공고 검토 Worker'));
  assert.equal(workers.length, 10);
  assert.ok(workers.every((r) => r.params.model === 'gpt-6-luna' && !r.params.reasoning && r.params.text.format.strict === true));
  const orch = requests.at(-1).params;
  assert.equal(orch.model, 'gpt-6.2-astra');
  assert.deepEqual(orch.reasoning, { effort: 'medium' });
  // Worker 하나는 공고 하나만 받는다
  assert.ok(workers.every((r) => (requestText(r.params, 'user').match(/"id":/g) || []).length === 1));

  assert.equal(result.rows.length, 10);
  assert.deepEqual(result.skipped.overflow.map((b) => b.id), ['2026-B-0112', '2026-B-0106']);
  assert.deepEqual(result.skipped.expired.map((b) => b.id), ['2026-B-0113']);
  // 지역 제한(광주)·면허(토목·조경) 미충족은 점수와 관계없이 뒤로
  const ineligible = result.rows.filter((r) => !r.eligible).map((r) => r.id).sort();
  assert.deepEqual(ineligible, ['2026-B-0103', '2026-B-0104', '2026-B-0107', '2026-B-0109']);
  assert.ok(result.rows.slice(0, 6).every((r) => r.eligible));
  // 화성 임대주택·성남 학교 리모델링이 모두 100점 → 같은 점수는 금액 큰 순
  assert.deepEqual(result.rows.slice(0, 2).map((r) => [r.id, r.score]), [['2026-B-0105', 100], ['2026-B-0101', 100]]);
  // 마감 1일 남은 고양 공고는 마감 여유 30점
  assert.equal(result.rows.find((r) => r.id === '2026-B-0110').points.deadline, 30);
  assert.ok(result.rows.every((r) => r.note && r.note.reason));
  assert.deepEqual(result.steps.map((s) => s.name).filter((n) => !n.startsWith('2단계')), ['1단계 Orchestrator: 검토 작업 만들기', '3단계 점수 계산', '4단계 Orchestrator: 우선순위 이유 작성']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'bid_run');
  assert.equal(logs[0].calls, 11);
});

test('가중치를 바꾸면 순위가 바뀐다 (요청의 weights 를 쓴다)', async () => {
  const { result } = await run({ weights: { trade: 0, region: 0, deadline: 10, qualification: 0 } });
  assert.equal(result.weights.deadline, 10);
  // 마감 여유만 보면 마감 1일 남은 고양 공고는 참가 가능한 공고 중 맨 뒤
  const eligible = result.rows.filter((r) => r.eligible);
  assert.equal(eligible.at(-1).id, '2026-B-0110');
});

test('Worker 하나가 실패해도 나머지로 표를 만들고, 실패한 공고를 따로 보여 준다', async () => {
  const table = SAMPLE_TABLE.replace('수원 행정복지센터 신축공사', '수원 검토실패 공사');
  const { result, client } = await run({ bids: table });
  assert.equal(result.status, 'partial');
  assert.equal(result.rows.length, 9);
  assert.deepEqual(result.failed.map((f) => f.id), ['2026-B-0102']);
  assert.match(result.failed[0].message, /스키마/);
  assert.match(result.message, /1건은 검토에 실패/);
  assert.equal(workerCalls(client).length, 11, '실패한 공고는 한 번 다시 요청한다');
  const step = result.steps.find((s) => s.name === '2단계 Worker: 2026-B-0102');
  assert.ok(step.error);
});

test('Orchestrator 이유 작성이 실패해도 코드가 계산한 표는 보여 준다', async () => {
  const table = SAMPLE_TABLE.replace('부천 근린생활시설 신축공사', '부천 이유실패 공사');
  const { result } = await run({ bids: table });
  assert.equal(result.status, 'partial');
  assert.equal(result.rows.length, 10);
  assert.ok(result.rows.every((r) => r.note === null));
  assert.match(result.message, /이유를 쓰지 못했습니다/);
});

test('Worker 가 모두 실패하면 error', async () => {
  const table = `${HEAD.join('\t')}\nX-1\t검토실패 공사\t\t건축\t\t1,000,000\t2026-12-01 10:00\t`;
  const { result } = await run({ bids: table });
  assert.equal(result.status, 'error');
  assert.equal(result.failed.length, 1);
});

test('이유에 공고·검토 결과에 없는 숫자가 있으면 표시한다', async () => {
  const table = SAMPLE_TABLE.replace('부천 근린생활시설 신축공사', '부천 근린생활시설 근거없는숫자 공사');
  const { result } = await run({ bids: table });
  const row = result.rows.find((r) => r.id === '2026-B-0111');
  assert.deepEqual(row.note.unsupported_numbers, ['87.745']);
});

test('거부: 입력 오류는 AI 를 부르지 않는다', async () => {
  for (const input of [{ bids: '' }, { company: '' }, { weights: { trade: 0, region: 0, deadline: 0, qualification: 0 } }, { bids: `${HEAD.join('\t')}\nA\tB\t\t\t\t100\t2026-11-01 10:00\t` }]) {
    const { result, client } = await run(input);
    assert.equal(result.status, 'invalid', JSON.stringify(input));
    assert.equal(client.requests.length, 0);
  }
});

test('검증: Worker·Orchestrator 응답 형식', () => {
  const ok = { trade_fit: { level: '높음', reason: 'r' }, region: { site: '', restriction: '', status: '제한 없음', reason: 'r' }, qualifications: [], needs_check: [] };
  assert.equal(validateWorker(ok), null);
  assert.match(validateWorker({ ...ok, region: { ...ok.region, restriction: '경기도 소재' } }), /제한 없음/);
  assert.match(validateWorker({ ...ok, trade_fit: { level: '최고', reason: 'r' } }), /trade_fit/);
  const notes = { reasons: [{ bid_id: 'A', reason: 'r', caution: '' }], summary: 's', needs_check: [] };
  assert.equal(validateOrchestrator(notes, ['A']), null);
  assert.match(validateOrchestrator(notes, ['A', 'B']), /빠진 공고: B/);
  assert.match(validateOrchestrator({ ...notes, reasons: [{ bid_id: 'Z', reason: 'r', caution: '' }] }, ['A']), /없는 공고번호/);
});
