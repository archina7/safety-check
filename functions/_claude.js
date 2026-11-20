// Claude 호출 공용 모듈 (CLAUDE.md 'AI 기능 규칙')
// - 공식 SDK, 키·모델은 env, 구조화 출력(JSON Schema), 스키마가 안 맞으면 1회 재요청 후 오류
// - 호출마다 모델·토큰·소요 시간을 남긴다
import Anthropic from '@anthropic-ai/sdk';

export const MAX_ATTEMPTS = 2;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AgentError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.detail = detail;
  }
}

export function models(env) {
  return {
    agent: env.CLAUDE_MODEL || 'claude-opus-5-5',
    worker: env.CLAUDE_WORKER_MODEL || 'claude-haiku-5-5',
  };
}

// 테스트에서만 로컬 mock 서버로 보낼 수 있다. localhost 가 아니면 무시하고 실제 API를 쓴다
function baseURL(env) {
  try {
    const u = new URL(env.ANTHROPIC_BASE_URL);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin;
  } catch {
    // 없거나 잘못된 주소
  }
  return undefined;
}

// SDK 자체 재시도는 끈다(maxRetries: 0). 재시도는 callAgent 가 MAX_ATTEMPTS 안에서 하고, 그래야 모든 호출이 로그에 남는다
export function createClient(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: baseURL(env), maxRetries: 0 });
}

// 다시 시도해 볼 만한 오류: 연결 실패·시간 초과, 408·409·429·5xx
export function isRetryable(e) {
  if (e instanceof Anthropic.APIConnectionError) return true;
  const st = e?.status;
  return st === 408 || st === 409 || st === 429 || (typeof st === 'number' && st >= 500);
}

// 원인 추적용 오류 정보 (상태 코드·오류 종류·요청 ID). 메시지 본문은 남기지 않는다
export function errorInfo(e) {
  return {
    status: e?.status ?? null,
    type: e?.error?.error?.type ?? e?.constructor?.name ?? 'Error',
    request_id: e?.requestID ?? null,
  };
}

// 민원·TBM 기록처럼 사용자가 쓴 글을 태그 안에 넣을 때, 글 안의 태그가 지시처럼 읽히지 않게 꺾쇠를 바꾼다
export function escapeTags(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const RETRY_DELAY_MS = 1000;

export const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// 구조화 출력으로 한 번 부르고, 응답이 JSON 이 아니거나 validate 가 문제를 돌려주면 한 번 더 부른다.
// fallbacks: true 면 서버 측 대체 모델(거절 시)을 켠다 (Haiku 는 지원하지 않음)
export async function callAgent(client, { model, system, user, schema, validate, effort, fallbacks, retryDelayMs = RETRY_DELAY_MS }, log) {
  let lastProblem = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const content = attempt === 1
      ? user
      : `${user}\n\n<note>이전 응답이 형식 규칙을 어겼습니다: ${lastProblem}. 스키마와 규칙에 맞게 다시 답하세요.</note>`;
    const params = {
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
    const started = Date.now();
    let res;
    try {
      res = fallbacks
        ? await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
        : await client.messages.create(params);
    } catch (e) {
      // 실패한 호출도 호출 수에 넣고, 원인을 로그로 남긴다
      const error = errorInfo(e);
      log.calls.push({ attempt, model, input_tokens: 0, output_tokens: 0, ms: Date.now() - started, error });
      console.error(JSON.stringify({ event: 'claude_call_error', model, attempt, ...error }));
      if (attempt < MAX_ATTEMPTS && isRetryable(e)) {
        lastProblem = `API 오류 ${error.status ?? error.type}`;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw e;
    }
    log.calls.push({
      attempt,
      model: res.model,
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      ms: Date.now() - started,
    });

    if (res.stop_reason === 'refusal') {
      throw new AgentError('Claude가 요청을 거절했습니다.', { category: res.stop_details?.category ?? null });
    }
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      lastProblem = res.stop_reason === 'max_tokens' ? '응답이 길이 제한에서 잘림' : 'JSON 아님';
      continue;
    }
    const problem = validate(parsed);
    if (!problem) return parsed;
    lastProblem = problem;
  }
  throw new AgentError(`응답이 스키마에 맞지 않습니다 (${MAX_ATTEMPTS}회 시도): ${lastProblem}`);
}

export function errorText(e) {
  if (e instanceof AgentError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API 키가 올바르지 않습니다.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude API 호출 한도를 넘었습니다. 잠시 후 다시 시도하세요.';
  if (e instanceof Anthropic.APIConnectionError) return 'Claude API에 연결하지 못했습니다.';
  if (e instanceof Anthropic.APIError) return `Claude API 오류 (${e.status ?? '알 수 없음'})`;
  return '처리 중 오류가 발생했습니다.';
}

// ---------- 실행 기록 (단계별 입력·출력·소요 시간·토큰) ----------

const sum = (calls, key) => calls.reduce((a, c) => a + c[key], 0);

export function newLog() {
  return { calls: [] };
}

export function stepRecord(name, agent, input, startedAt, log, extra = {}) {
  return {
    name,
    agent,
    input,
    ms: Date.now() - startedAt,
    calls: log.calls,
    input_tokens: sum(log.calls, 'input_tokens'),
    output_tokens: sum(log.calls, 'output_tokens'),
    ...extra,
  };
}

export function codeStep(name, input, output, startedAt = Date.now()) {
  return { name, agent: '코드', input, output, ms: Date.now() - startedAt, calls: [], input_tokens: 0, output_tokens: 0 };
}

// 실행 결과를 정리하고, 실행마다 호출 수와 토큰을 로그 한 줄로 남긴다
export function finishRun(event, status, steps, runStarted, extra = {}) {
  const calls = steps.flatMap((s) => s.calls);
  const totals = { calls: calls.length, input_tokens: sum(calls, 'input_tokens'), output_tokens: sum(calls, 'output_tokens'), ms: Date.now() - runStarted };
  console.log(JSON.stringify({
    event,
    status,
    ...totals,
    steps: steps.map((s) => ({
      name: s.name, calls: s.calls.length, input_tokens: s.input_tokens, output_tokens: s.output_tokens, ms: s.ms,
      ...(s.error ? { error: s.error, api_errors: s.calls.filter((c) => c.error).map((c) => c.error) } : {}),
    })),
  }));
  return { status, steps, totals, ...extra };
}

// 답변·공지문에 나온 숫자 중 근거 자료에 없는 것 (근거 없는 수치 의심). 표시만 하고 판단은 사람에게 맡긴다
// 숫자 단위로 비교한다 ('52m' 안의 '5' 처럼 일부만 겹치는 것은 근거로 치지 않는다)
// 값으로 비교한다: '07' 과 '7', '1.50' 과 '1.5' 는 같은 숫자다.
// 근거 자료의 시각(07:00)은 숫자 바로 뒤에 '시'·'분'이 올 때만 시·분으로 인정한다
// ('오전 7시', '30분', 13:00 → '오후 1시'). '17:00' 이 있다고 '5일' 까지 근거로 치지는 않는다
const NUMBER_RE = /\d+(?:[.:]\d+)?/g;
const norm = (n) => n.split(':').map((p) => String(Number(p))).join(':');
export function unsupportedNumbers(texts, source) {
  const haystack = typeof source === 'string' ? source : JSON.stringify(source);
  const known = new Set();
  const hours = new Set();
  const minutes = new Set();
  for (const n of haystack.match(NUMBER_RE) || []) {
    known.add(norm(n));
    if (n.includes(':')) {
      const [h, m] = n.split(':').map(Number);
      hours.add(h);
      if (h > 12) hours.add(h - 12);
      minutes.add(m);
    }
  }
  const found = new Set();
  for (const t of [].concat(texts)) {
    for (const match of String(t).matchAll(NUMBER_RE)) {
      const n = match[0];
      const after = String(t).slice(match.index + n.length).trimStart();
      const ok = known.has(norm(n))
        || (after.startsWith('시') && hours.has(Number(n)))
        || (after.startsWith('분') && minutes.has(Number(n)));
      if (!ok) found.add(n);
    }
  }
  return [...found];
}
