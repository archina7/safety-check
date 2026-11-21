// 작업 허가서 API 공용: 요청 검사, 검토 실행(신청 → Agent 검토 → 관리자 확인 대기)
import { apiKey } from './_ai.js';
import { reviewPermit } from './_permit.js';
import { getPermit, saveReview, saveReviewError, startReview } from './_permit-store.js';

export const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// POST 는 같은 사이트의 JSON 요청만 받는다
export function badPost(request) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin || !(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return json({ error: '허용되지 않은 요청입니다.' }, 403);
  }
  return null;
}

export function notReady(env, { ai = false } = {}) {
  if (!env.DB) {
    console.error('[safety-check] D1 바인딩(DB) 미설정');
    return json({ error: '저장소 설정이 완료되지 않았습니다. 관리자에게 문의하세요.' }, 503);
  }
  if (ai && !apiKey(env)) {
    console.error('[safety-check] OPENAI_API_KEY 미설정');
    return json({ error: 'AI 설정이 완료되지 않았습니다. 관리자에게 문의하세요.' }, 503);
  }
  return null;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Agent 검토를 돌리고 결과를 저장한다. 저장은 saveReview(→ 관리자 확인 대기)뿐이다
export async function runReview(env, id, opts = {}) {
  if (!(await startReview(env, id))) return null;
  const permit = await getPermit(env, id);
  let result;
  try {
    result = await reviewPermit(permit.form, env, opts);
  } catch (e) {
    result = { status: 'error', message: '검토 중 오류가 발생했습니다.' };
    console.error(JSON.stringify({ event: 'permit_review_error', id, error: String(e?.message || e) }));
  }
  if (result.status === 'ok') {
    await saveReview(env, id, { ...result.review, steps: result.steps, totals: result.totals });
  } else {
    await saveReviewError(env, id, result.message);
  }
  return getPermit(env, id);
}
