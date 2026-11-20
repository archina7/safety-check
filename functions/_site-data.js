// 합성(예시) 현장 일정. 실제 현장 자료가 아니다.
// 민원 답변 초안에 붙이는 근거 자료로, 날짜로 찾는 것은 코드가 한다.

const WORK_NOTICES = [
  { date: '2026-11-24', time: '07:00-12:00', work: '지하 1층 암반 브레이커 작업', location: '동측 터파기 구간', note: '소음·진동 큼' },
  { date: '2026-11-24', time: '13:00-17:00', work: '3층 철근 배근', location: '본동', note: '' },
  { date: '2026-11-25', time: '08:00-12:00', work: '외벽 앵커 천공', location: '북측 외벽', note: '드릴 소음' },
  { date: '2026-11-25', time: '13:00-16:00', work: '콘크리트 타설', location: '4층 슬래브', note: '펌프카 가동' },
];

const EQUIPMENT_BOOKINGS = [
  { date: '2026-11-24', time: '07:00-10:00', equipment: '레미콘 트럭 12대', gate: '1번 게이트(동측 골목)' },
  { date: '2026-11-24', time: '13:00-15:00', equipment: '철근 운반 트럭 3대', gate: '2번 게이트(정문)' },
  { date: '2026-11-25', time: '10:00-14:00', equipment: '펌프카 52m 1대, 레미콘 트럭 20대', gate: '2번 게이트(정문)' },
];

export function workNoticesOn(date) {
  return WORK_NOTICES.filter((w) => w.date === date);
}

export function equipmentBookingsOn(date) {
  return EQUIPMENT_BOOKINGS.filter((b) => b.date === date);
}
