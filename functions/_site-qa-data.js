// 합성(예시) 현장 데이터. 실제 현장 자료가 아니다. 현장 질의 Agent 의 읽기 전용 도구가 쓴다.
// 쓰기·삭제 함수는 두지 않는다 (배열은 얼려 둔다)

const freeze = (rows) => Object.freeze(rows.map((r) => Object.freeze(r)));

export const DATA_RANGE = { from: '2026-11-18', to: '2026-11-25' };
export const TRADES = ['전체', '토공', '골조', '설비', '전기', '마감'];

// 공종별 계획·실적 공정률 (%), 기준일 2026-11-20
const PROGRESS = freeze([
  { trade: '전체', as_of: '2026-11-20', plan_pct: 46.5, actual_pct: 43.2 },
  { trade: '토공', as_of: '2026-11-20', plan_pct: 100, actual_pct: 100 },
  { trade: '골조', as_of: '2026-11-20', plan_pct: 62.0, actual_pct: 55.4 },
  { trade: '설비', as_of: '2026-11-20', plan_pct: 30.0, actual_pct: 31.5 },
  { trade: '전기', as_of: '2026-11-20', plan_pct: 28.0, actual_pct: 24.0 },
  { trade: '마감', as_of: '2026-11-20', plan_pct: 8.0, actual_pct: 6.5 },
]);

// 날짜별 협력사 출역 인원 (명)
const WORKFORCE = freeze([
  ...['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25'].flatMap((date, i) => [
    { date, company: '○○골조', trade: '골조', workers: [38, 41, 40, 35, 42, 44, 39][i] },
    { date, company: '△△설비', trade: '설비', workers: [12, 12, 14, 10, 15, 15, 13][i] },
    { date, company: '□□전기', trade: '전기', workers: [9, 10, 10, 8, 11, 12, 10][i] },
    { date, company: '◇◇도장', trade: '마감', workers: [0, 0, 4, 4, 6, 6, 6][i] },
  ]),
]);

// 날짜별 미완료 안전점검 항목
const INSPECTIONS = freeze([
  { date: '2026-11-20', item: '개구부 안전난간 설치 상태', category: '추락', location: '5층 슬래브 동측', owner: '○○골조' },
  { date: '2026-11-21', item: '임시 분전반 누전차단기 작동 시험', category: '전기', location: '지하 1층', owner: '□□전기' },
  { date: '2026-11-21', item: '비계 작업발판 고정', category: '비계', location: '북측 외부 비계', owner: '○○골조' },
  { date: '2026-11-24', item: '용접 작업장 소화기 비치', category: '화재', location: '3층 기계실', owner: '△△설비' },
  { date: '2026-11-24', item: '굴착기 작업 반경 출입 통제', category: '건설기계', location: '동측 터파기 구간', owner: '○○골조' },
  { date: '2026-11-24', item: '안전대 부착설비 점검', category: '추락', location: '6층 외곽', owner: '○○골조' },
]);

export function progressOf(trade) {
  return PROGRESS.filter((p) => p.trade === trade);
}

export function workforceOn(date) {
  return WORKFORCE.filter((w) => w.date === date);
}

export function openInspectionsOn(date) {
  return INSPECTIONS.filter((x) => x.date === date);
}
