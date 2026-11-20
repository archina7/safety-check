// POST /api/complaint  { complaint, date? } → 분류·처리 결과 (로그인 필요: _middleware.js)
import { runComplaintWorkflow } from '../_complaint.js';

const STATUS_CODE = { drafted: 200, queued: 200, urgent: 200, invalid: 422, error: 502 };

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin || !(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return Response.json({ error: '허용되지 않은 요청입니다.' }, { status: 403 });
  }
  if (!env.ANTHROPIC_API_KEY) {
    console.error('[safety-check] ANTHROPIC_API_KEY 미설정');
    return Response.json({ status: 'error', message: 'AI 설정이 완료되지 않았습니다. 관리자에게 문의하세요.' }, { status: 503 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }
  const result = await runComplaintWorkflow({ complaint: body?.complaint, date: body?.date }, env);
  return Response.json(result, { status: STATUS_CODE[result.status] ?? 500, headers: { 'Cache-Control': 'no-store' } });
}

export function onRequest() {
  return Response.json({ error: '허용되지 않은 요청 방식입니다.' }, { status: 405, headers: { Allow: 'POST' } });
}
