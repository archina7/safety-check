// AI 호출 공용 모듈 (CLAUDE.md 'AI 기능 규칙') — OpenAI Responses API
// - 공식 SDK(openai), 키·모델은 env, 구조화 출력(JSON Schema, strict), 스키마가 안 맞으면 1회 재요청 후 오류
// - 호출마다 모델·토큰·소요 시간을 남긴다
import OpenAI from 'openai';

export const MAX_ATTEMPTS = 2;

export class AgentError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.detail = detail;
  }
}

export const DEFAULT_MODELS = { agent: 'gpt-6.2-astra', worker: 'gpt-6-luna' };

export function models(env) {
  return {
    agent: env.OPENAI_MODEL || DEFAULT_MODELS.agent,
    worker: env.OPENAI_WORKER_MODEL || DEFAULT_MODELS.worker,
  };
}

// 키 이름은 OPENAI_API_KEY. Cloudflare 에 OPEN_API_KEY 로 등록한 값도 받는다
export function apiKey(env) {
  return env.OPENAI_API_KEY || env.OPEN_API_KEY || '';
}

// 테스트에서만 로컬 mock 서버로 보낼 수 있다. localhost 가 아니면 무시하고 실제 API를 쓴다
function baseURL(env) {
  try {
    const u = new URL(env.OPENAI_BASE_URL);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin;
  } catch {
    // 없거나 잘못된 주소
  }
  return undefined;
}

// SDK 자체 재시도는 끈다(maxRetries: 0). 재시도는 callAgent 가 MAX_ATTEMPTS 안에서 하고, 그래야 모든 호출이 로그에 남는다
// 호출 하나는 최대 90초 (SDK 기본 10분이면 화면이 먼저 포기한다)
export const CALL_TIMEOUT_MS = 90_000;
export function createClient(env) {
  return new OpenAI({ apiKey: apiKey(env), baseURL: baseURL(env), maxRetries: 0, timeout: CALL_TIMEOUT_MS });
}

// 다시 시도해 볼 만한 오류: 연결 실패, 408·409·429·5xx. 시간 초과는 다시 기다리지 않는다
export function isRetryable(e) {
  if (e instanceof OpenAI.APIConnectionTimeoutError) return false;
  if (e instanceof OpenAI.APIConnectionError) return true;
  const st = e?.status;
  return st === 408 || st === 409 || st === 429 || (typeof st === 'number' && st >= 500);
}

// 원인 추적용 오류 정보 (상태 코드·오류 종류·요청 ID). 메시지 본문은 남기지 않는다
export function errorInfo(e) {
  return {
    status: e?.status ?? null,
    type: e?.type ?? e?.code ?? e?.constructor?.name ?? 'Error',
    request_id: e?.requestID ?? null,
  };
}

// 민원·TBM 기록처럼 사용자가 쓴 글을 태그 안에 넣을 때, 글 안의 태그가 지시처럼 읽히지 않게 꺾쇠를 전각 꺾쇠(＜＞)로 바꾼다.
// &lt; 같은 엔티티로 바꾸면 모델이 그대로 베껴 공지·답변에 '&amp;' 가 보이므로 쓰지 않는다
export function escapeTags(s) {
  return String(s).replace(/</g, '＜').replace(/>/g, '＞');
}

export const RETRY_DELAY_MS = 1000;
const MAX_OUTPUT_TOKENS = 16000;

export const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Responses API 응답에서 글과 거절 문구를 꺼낸다 (SDK 의 output_text 편의 속성에 기대지 않는다)
function readOutput(res) {
  const parts = (res.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
  return {
    text: parts.filter((c) => c.type === 'output_text').map((c) => c.text).join(''),
    refusal: parts.find((c) => c.type === 'refusal')?.refusal ?? null,
  };
}

// 구조화 출력으로 한 번 부르고, 응답이 JSON 이 아니거나 validate 가 문제를 돌려주면 한 번 더 부른다.
// effort 를 주면 reasoning.effort 로 보낸다 (Worker 는 모델 기본값을 쓰도록 비워 둔다)
export async function callAgent(client, { model, system, user, schema, name = 'result', validate, effort = null, retryDelayMs = RETRY_DELAY_MS }, log) {
  let lastProblem = '';
  let formatProblem = ''; // 이전 '응답'이 형식을 어겼을 때만 채운다. API 오류로 다시 부를 때는 안내를 붙이지 않는다
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const content = formatProblem
      ? `${user}\n\n<note>이전 응답이 형식 규칙을 어겼습니다: ${formatProblem}. 스키마와 규칙에 맞게 다시 답하세요.</note>`
      : user;
    formatProblem = '';
    // 고정 지시는 첫 developer 메시지로 둔다 (프롬프트 캐시가 잘 맞도록)
    const params = {
      model,
      input: [
        { role: 'developer', content: system },
        { role: 'user', content },
      ],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
      ...(effort ? { reasoning: { effort } } : {}),
    };
    const started = Date.now();
    let res;
    try {
      res = await client.responses.create(params);
    } catch (e) {
      // 실패한 호출도 호출 수에 넣고, 원인을 로그로 남긴다
      const error = errorInfo(e);
      log.calls.push({ attempt, model, input_tokens: 0, output_tokens: 0, ms: Date.now() - started, error });
      console.error(JSON.stringify({ event: 'ai_call_error', model, attempt, ...error }));
      if (attempt < MAX_ATTEMPTS && isRetryable(e)) {
        lastProblem = `API 오류 ${error.status ?? error.type}`;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw e;
    }
    log.calls.push({
      attempt,
      model: res.model || model,
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      ms: Date.now() - started,
    });

    const { text, refusal } = readOutput(res);
    const reason = res.incomplete_details?.reason ?? null;
    if (refusal !== null || reason === 'content_filter') {
      throw new AgentError('AI가 요청을 거절했습니다.', { reason: refusal !== null ? 'refusal' : reason });
    }
    let parsed = null;
    try {
      if (res.status && res.status !== 'completed') throw new Error(res.status);
      parsed = JSON.parse(text);
    } catch {
      lastProblem = reason === 'max_output_tokens' ? '응답이 길이 제한에서 잘림' : 'JSON 아님';
      formatProblem = lastProblem;
      continue;
    }
    const problem = validate(parsed);
    if (!problem) return parsed;
    lastProblem = problem;
    formatProblem = problem;
  }
  throw new AgentError(`응답이 스키마에 맞지 않습니다 (${MAX_ATTEMPTS}회 시도): ${lastProblem}`);
}

// 도구를 쓰는 Agent 용: 요청 하나를 보내고 호출 기록을 남긴다. API 오류는 MAX_ATTEMPTS 안에서 다시 보낸다.
// 응답 해석(도구 호출·최종 답)은 부르는 쪽이 한다
export async function createResponse(client, params, log, { retryDelayMs = RETRY_DELAY_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const res = await client.responses.create({ max_output_tokens: MAX_OUTPUT_TOKENS, ...params });
      log.calls.push({
        attempt,
        model: res.model || params.model,
        input_tokens: res.usage?.input_tokens ?? 0,
        output_tokens: res.usage?.output_tokens ?? 0,
        ms: Date.now() - started,
      });
      const { text, refusal } = readOutput(res);
      if (refusal !== null || res.incomplete_details?.reason === 'content_filter') {
        throw new AgentError('AI가 요청을 거절했습니다.', { reason: refusal !== null ? 'refusal' : 'content_filter' });
      }
      return { res, text };
    } catch (e) {
      if (e instanceof AgentError) throw e;
      const error = errorInfo(e);
      log.calls.push({ attempt, model: params.model, input_tokens: 0, output_tokens: 0, ms: Date.now() - started, error });
      console.error(JSON.stringify({ event: 'ai_call_error', model: params.model, attempt, ...error }));
      if (attempt < MAX_ATTEMPTS && isRetryable(e)) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw e;
    }
  }
}

export function errorText(e) {
  if (e instanceof AgentError) return e.message;
  if (e instanceof OpenAI.AuthenticationError) return 'OpenAI API 키가 올바르지 않습니다.';
  if (e instanceof OpenAI.RateLimitError) return 'OpenAI API 호출 한도를 넘었습니다. 잠시 후 다시 시도하세요.';
  if (e instanceof OpenAI.APIConnectionError) return 'OpenAI API에 연결하지 못했습니다.';
  if (e instanceof OpenAI.APIError) return `OpenAI API 오류 (${e.status ?? '알 수 없음'})`;
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
// '5시간'·'30분간'·'분기' 처럼 시각이 아닌 말은 빼고, 시각의 '시'·'분'만 받는다
const CLOCK_HOUR = /^시(?!간)/;
const CLOCK_MINUTE = /^분(?![간기])/;
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
        || (CLOCK_HOUR.test(after) && hours.has(Number(n)))
        || (CLOCK_MINUTE.test(after) && minutes.has(Number(n)));
      if (!ok) found.add(n);
    }
  }
  return [...found];
}
