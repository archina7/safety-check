import { inspections } from '../_data.js';

// GET /api/inspections → 오늘 점검 항목 목록
export function onRequestGet() {
  return Response.json(
    { items: inspections },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

// GET 외의 메서드는 거부한다 (읽기 전용 API)
export function onRequest() {
  return Response.json(
    { error: '허용되지 않은 요청 방식입니다.' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}
