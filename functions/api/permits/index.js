// GET  /api/permits  → 허가서 목록, 승인·반려 이력, 내가 결정할 수 있는지(can_decide)
// POST /api/permits  { form } → 신청 저장 → Agent 검토 → '관리자 확인 대기' (로그인 필요: _middleware.js)
// 요청 본문의 status 같은 값은 읽지 않는다. 상태는 서버가 정한 순서로만 바뀐다
import { COMMON_FIELDS, PERMIT_TYPES, normalizeForm } from '../../_permit.js';
import { createPermit, isManager, listDecisions, listPermits, managerEmails } from '../../_permit-store.js';
import { badPost, json, notReady, readJson, runReview } from '../../_permit-api.js';

export async function onRequestGet({ env, data }) {
  const blocked = notReady(env);
  if (blocked) return blocked;
  const email = data.user?.email || '';
  const [permits, history] = await Promise.all([listPermits(env), listDecisions(env)]);
  return json({
    me: email,
    can_decide: isManager(env, email),
    managers_configured: managerEmails(env).size > 0,
    fields: COMMON_FIELDS,
    types: PERMIT_TYPES,
    permits: permits.map(({ form, review, ...p }) => ({ ...p, recommendation: review?.recommendation ?? null })),
    history,
  });
}

export async function onRequestPost({ request, env, data }) {
  const bad = badPost(request) || notReady(env, { ai: true });
  if (bad) return bad;
  const body = await readJson(request);
  if (!body) return json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  const { form, error } = normalizeForm(body.form);
  if (error) return json({ error }, 422);
  const id = await createPermit(env, form, data.user.email);
  const permit = await runReview(env, id);
  return json({ permit, can_decide: isManager(env, data.user.email) }, 201);
}

export function onRequest() {
  return json({ error: '허용되지 않은 요청 방식입니다.' }, 405);
}
