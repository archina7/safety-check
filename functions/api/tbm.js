// POST /api/tbm  { record } → 3단계 워크플로 결과 (로그인 필요: _middleware.js)
import { apiKey } from '../_ai.js';
import { runTbmWorkflow } from '../_tbm.js';

const STATUS_CODE = { ok: 200, blocked: 200, empty: 422, error: 502 };

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  // 다른 사이트에서 보낸 요청(CSRF)은 거부한다
  if (request.headers.get('Origin') !== url.origin || !(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return Response.json({ error: '허용되지 않은 요청입니다.' }, { status: 403 });
  }
  if (!apiKey(env)) {
    console.error('[safety-check] OPENAI_API_KEY 미설정');
    return Response.json({ status: 'error', message: 'AI 설정이 완료되지 않았습니다. 관리자에게 문의하세요.' }, { status: 503 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }
  const result = await runTbmWorkflow(body?.record, env);
  return Response.json(result, { status: STATUS_CODE[result.status] ?? 500, headers: { 'Cache-Control': 'no-store' } });
}

export function onRequest() {
  return Response.json({ error: '허용되지 않은 요청 방식입니다.' }, { status: 405, headers: { Allow: 'POST' } });
}
