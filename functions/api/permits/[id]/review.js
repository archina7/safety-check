// POST /api/permits/:id/review → 검토가 실패해 'Agent 검토'에 머문 허가서를 다시 검토한다
import { getPermit, isManager } from '../../../_permit-store.js';
import { badPost, json, notReady, runReview } from '../../../_permit-api.js';

export async function onRequestPost({ request, env, params, data }) {
  const bad = badPost(request) || notReady(env, { ai: true });
  if (bad) return bad;
  const id = String(params.id);
  if (!(await getPermit(env, id))) return json({ error: '허가서를 찾을 수 없습니다.' }, 404);
  const permit = await runReview(env, id);
  if (!permit) return json({ error: '지금 상태에서는 다시 검토할 수 없습니다.' }, 409);
  return json({ permit, can_decide: isManager(env, data.user.email) });
}

export function onRequest() {
  return json({ error: '허용되지 않은 요청 방식입니다.' }, 405);
}
