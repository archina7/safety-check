// POST /api/permits/:id/decision  { decision: '승인'|'반려', reason? }
// 허가서를 승인·반려하는 유일한 경로. 관리자(MANAGER_EMAILS)만, '관리자 확인 대기'에서만, 한 번만 된다.
// Agent 권고와 다른 결정은 사유가 있어야 한다
import { DECISIONS, MATCHING, MAX_REASON_CHARS, STATUS, decide, getPermit, isManager } from '../../../_permit-store.js';
import { badPost, json, notReady, readJson } from '../../../_permit-api.js';

export async function onRequestPost({ request, env, params, data }) {
  const bad = badPost(request) || notReady(env);
  if (bad) return bad;
  const email = data.user?.email;
  if (!isManager(env, email)) return json({ error: '관리자만 승인·반려할 수 있습니다.' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  const decision = body.decision;
  if (!DECISIONS.includes(decision)) return json({ error: '결정은 승인 또는 반려입니다.' }, 422);
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON_CHARS) return json({ error: `사유는 ${MAX_REASON_CHARS}자까지입니다.` }, 422);

  const id = String(params.id);
  const permit = await getPermit(env, id);
  if (!permit) return json({ error: '허가서를 찾을 수 없습니다.' }, 404);
  if (permit.status !== STATUS.WAITING) return json({ error: `'${STATUS.WAITING}' 상태에서만 결정할 수 있습니다 (지금: ${permit.status}).` }, 409);
  const recommendation = permit.review?.recommendation ?? null;
  if (MATCHING[recommendation] !== decision && !reason) {
    return json({ error: `Agent 권고(${recommendation})와 다른 결정입니다. 사유를 입력해 주세요.`, needs_reason: true }, 422);
  }
  const record = await decide(env, id, { decision, by: email, reason, recommendation });
  if (!record) return json({ error: '다른 관리자가 먼저 결정했습니다.' }, 409);
  return json({ permit: await getPermit(env, id), record });
}

export function onRequest() {
  return json({ error: '허용되지 않은 요청 방식입니다.' }, 405);
}
