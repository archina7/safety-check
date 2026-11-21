// 입찰공고 우선순위 점수 계산식 (서버 functions/_bid.js 와 화면 public/bid.js 가 같은 파일을 쓴다)
// - AI 는 공종 적합도·지역·참가 자격을 '판단'만 하고, 점수·순위는 이 코드가 정한다
// - 가중치는 화면에서 바꾸며, 바꾸면 AI 를 다시 부르지 않고 이 계산식으로 순위만 다시 매긴다

export const FACTORS = [
  { key: 'trade', name: '공종 적합도' },
  { key: 'region', name: '지역' },
  { key: 'deadline', name: '마감 여유' },
  { key: 'qualification', name: '참가 자격' },
];

export const DEFAULT_WEIGHTS = { trade: 4, region: 2, deadline: 1, qualification: 3 };
export const MAX_WEIGHT = 10;

export const TRADE_LEVELS = ['높음', '보통', '낮음', '확인 필요'];
export const REGION_LEVELS = ['제한 없음', '충족', '확인 필요', '미충족'];
export const QUAL_LEVELS = ['충족', '확인 필요', '미충족'];

// 항목 점수 (0~100)
export const POINTS = {
  trade: { 높음: 100, 보통: 60, 낮음: 20, '확인 필요': 40 },
  region: { '제한 없음': 100, 충족: 100, '확인 필요': 50, 미충족: 0 },
  qualification: { 충족: 100, '확인 필요': 50, 미충족: 0, 없음: 50 },
};

// 마감까지 남은 일수 → 준비 기간 점수. 2일 이하 30, 3~6일 70, 7일 이상 100
export function deadlinePoints(days) {
  if (days <= 2) return 30;
  if (days <= 6) return 70;
  return 100;
}

// 참가 자격 요건 전체 판정: 하나라도 미충족이면 미충족, 하나라도 확인 필요면 확인 필요, 요건이 없으면 '없음'
export function qualificationStatus(list) {
  if (!list.length) return '없음';
  if (list.some((q) => q.status === '미충족')) return '미충족';
  if (list.some((q) => q.status === '확인 필요')) return '확인 필요';
  return '충족';
}

export function factorPoints(review, days) {
  const qual = qualificationStatus(review.qualifications);
  return {
    trade: POINTS.trade[review.trade_fit.level],
    region: POINTS.region[review.region.status],
    deadline: deadlinePoints(days),
    qualification: POINTS.qualification[qual],
  };
}

// 지역 제한이나 참가 자격을 하나라도 못 맞추면 '참가 불가 가능성'으로 보고 점수와 관계없이 뒤로 보낸다
export function eligibility(review) {
  const reasons = [];
  if (review.region.status === '미충족') reasons.push('지역 제한 미충족');
  const missed = review.qualifications.filter((q) => q.status === '미충족').map((q) => q.requirement);
  if (missed.length) reasons.push(`자격 미충족: ${missed.join(', ')}`);
  return { eligible: reasons.length === 0, reasons };
}

// 가중치 검사: 항목마다 0~MAX_WEIGHT 정수, 합이 0 이면 안 된다. 문제가 없으면 null
export function weightProblem(weights) {
  if (!weights || typeof weights !== 'object') return '가중치가 없습니다';
  for (const f of FACTORS) {
    const w = weights[f.key];
    if (!Number.isInteger(w) || w < 0 || w > MAX_WEIGHT) return `${f.name} 가중치는 0~${MAX_WEIGHT} 사이 정수`;
  }
  if (FACTORS.every((f) => weights[f.key] === 0)) return '가중치를 하나 이상 0보다 크게 주세요';
  return null;
}

// 점수 = Σ(가중치 × 항목 점수) / Σ가중치, 소수 첫째 자리까지
export function score(points, weights) {
  let num = 0;
  let den = 0;
  for (const f of FACTORS) {
    num += weights[f.key] * points[f.key];
    den += weights[f.key];
  }
  return Math.round((num / den) * 10) / 10;
}

export const FORMULA = '점수 = Σ(가중치 × 항목 점수) ÷ Σ가중치';

// rows: [{ id, amount, days, points, eligible }] → 순위를 붙여 정렬한 새 배열
// 참가 가능한 공고를 먼저, 그 안에서 점수 높은 순 → 같으면 금액 큰 순 → 같으면 마감이 이른 순
export function rank(rows, weights) {
  const scored = rows.map((r) => ({ ...r, score: score(r.points, weights) }));
  scored.sort((a, b) => (Number(b.eligible) - Number(a.eligible)) || (b.score - a.score) || (b.amount - a.amount) || (a.days - b.days));
  return scored.map((r, i) => ({ ...r, rank: i + 1 }));
}

export function formatWon(n) {
  return `${Math.round(n).toLocaleString('en-US')}원`;
}
