// GET /api/permits/:id → 허가서 한 건 (신청서·Agent 검토 결과·상태)
import { getPermit, isManager } from '../../_permit-store.js';
import { json, notReady } from '../../_permit-api.js';

export async function onRequestGet({ env, params, data }) {
  const blocked = notReady(env);
  if (blocked) return blocked;
  const permit = await getPermit(env, String(params.id));
  if (!permit) return json({ error: '허가서를 찾을 수 없습니다.' }, 404);
  return json({ permit, can_decide: isManager(env, data.user?.email) });
}

export function onRequest() {
  return json({ error: '허용되지 않은 요청 방식입니다.' }, 405);
}
