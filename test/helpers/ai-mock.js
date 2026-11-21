// Claude 호출을 대신하는 고정 응답(mock). 요청의 system·user 내용을 보고 정해진 답을 돌려준다.
// 단위 테스트(가짜 client)와 e2e 테스트(로컬 HTTP 서버) 가 함께 쓴다.

const NORMAL_ITEMS = [
  { task: '철근 배근', hazard: '철근 끝에 찔림', measures: ['철근 끝에 보호캡 씌우기', '보호장갑 착용'] },
  { task: '외부 비계 위 거푸집 해체', hazard: '추락', measures: ['안전대 걸고 작업', '작업발판 고정 상태 확인'] },
  { task: '타워크레인 자재 인양', hazard: '낙하물', measures: ['인양 구간 출입 통제', '신호수 배치'] },
];

const MISSING_ITEMS = [
  { task: '배관 용접', hazard: '불티로 인한 화재', measures: ['소화기 비치', '불티 비산 방지포 설치'] },
  { task: '굴착기 터파기', hazard: '장비와 작업자 협착', measures: [] },
  { task: '임시 분전반 연결', hazard: '감전', measures: [] },
];

const NOTICE = {
  lines: [
    '철근 끝에는 보호캡을 씌우고 보호장갑을 착용하십시오.',
    '비계 위 거푸집 해체 시 안전대를 걸고 작업발판 고정을 확인하십시오.',
    '자재 인양 중에는 인양 구간 출입을 통제하고 신호수를 배치하십시오.',
  ],
  needs_check: [],
};

const attempts = new Map();

// 민원 분류 고정 응답: 민원 문장의 특징 문구 → 유형·확신도
const COMPLAINT_CLASSES = [
  ['쿵쿵', '소음·진동', 0.93],
  ['드릴 소리', '소음·진동', 0.9],
  ['레미콘 트럭이 골목', '교통·주차', 0.91],
  ['상가 앞 도로', '교통·주차', 0.88],
  ['펜스', '안전', 0.95],
  ['타워크레인', '안전', 0.92],
  ['빨래', '먼지', 0.9],
  ['흙먼지', '먼지', 0.89],
  ['준공', '기타', 0.85],
  ['화장실', '기타', 0.8],
  ['언제쯤 끝나나요', '기타', 0.45],
  ['트럭 소리도 시끄럽고 길도 막혀요', '소음·진동', 0.55],
  ['안전애매', '안전', 0.6],
  ['경계값', '소음·진동', 0.7],
];

function classifyComplaint(user) {
  if (user.includes('확신도오류')) return { category: '소음·진동', reason: '테스트', confidence: 1.5 };
  const hit = COMPLAINT_CLASSES.find(([k]) => user.includes(k));
  const [, category, confidence] = hit || [null, '기타', 0.5];
  return { category, reason: `민원 문장에 '${hit ? hit[0] : '특징 없음'}' 표현이 있어 ${category}(으)로 판단`, confidence };
}

function draftComplaint(user) {
  const attachments = JSON.parse(user.split('<attachments>')[1]?.split('</attachments>')[0] || '{}');
  const list = attachments.work_notices || attachments.equipment_bookings || [];
  const what = list.map((x) => `${x.work || x.equipment} (${x.time})`).join(', ');
  let draft = list.length
    ? `불편을 드려 죄송합니다. 해당 날짜에는 ${what} 일정이 있습니다. 작업 중 불편이 줄도록 현장에 전달하겠습니다.`
    : '불편을 드려 죄송합니다. 해당 날짜에 등록된 일정이 없어 확인 후 다시 안내드리겠습니다. (확인 필요)';
  if (user.includes('근거없는숫자')) draft += ' 5일 안에 조치하겠습니다.';
  return { draft, needs_check: list.length ? [] : ['해당 날짜 일정 없음'] };
}

// 계약서 검토 고정 응답: 관점(법무·원가·공정) × 계약서(일반 / 을에게 불리)
const F = (clause, risk, issue, recommendation = '협상 시 문구 수정을 요청한다.') => ({ clause, risk, issue, recommendation });
const CONTRACT_REVIEWS = {
  balanced: {
    법무: { findings: [F('제7조 제2항', '보통', '간접손해·특별손해를 배상 범위에서 빼 책임 범위가 제한된다.'), F('제8조', '낮음', '협의 후 현장 관할 법원으로 정해 절차가 명확하다.'), F('제6조', '낮음', '지연 책임을 귀책 사유로 나눈다.')], needs_check: [] },
    원가: {
      findings: [F('제4조', '보통', '지체상금률은 통상 수준이고 상한이 있다.'), F('제5조', '낮음', '발주자 요구 설계변경 비용은 발주자가 부담한다.')],
      needs_check: [],
      delay_penalty: { clause: '제4조', rate_quote: '계약금액의 1천분의 0.5', cap_quote: '계약금액의 100분의 30' },
      contract_amount_quote: '금 12,000,000,000원',
    },
    공정: { findings: [F('제3조', '낮음', '공사기간이 명확하다.'), F('제6조 제2항', '보통', '지연 사유 발생 후 7일 안에 서면 통지해야 해 기한 관리가 필요하다.')], needs_check: [] },
  },
  onesided: {
    법무: {
      findings: [F('제7조', '매우높음', '간접손해까지 한도 없이 배상해야 한다.'), F('제8조', '높음', '발주자가 지정한 중재기관에 이의를 제기할 수 없다.'), F('제6조', '보통', '연장 승인이 발주자 재량이다.'), F('제15조', '높음', '하자담보 책임 기간이 길다.')],
      needs_check: ['중재 조항 효력은 관련 법령 확인 필요'],
    },
    원가: {
      findings: [F('제4조', '매우높음', '지체상금 상한이 없다.'), F('제5조', '매우높음', '사유와 관계없이 설계변경 비용을 을이 모두 부담한다.')],
      needs_check: [],
      delay_penalty: { clause: '제4조', rate_quote: '계약금액의 1천분의 1', cap_quote: '' },
      contract_amount_quote: '금 8,500,000,000원',
    },
    공정: { findings: [F('제6조', '매우높음', '기상 악화·자재 수급 지연을 연장 사유로 인정하지 않는다.'), F('제3조', '높음', '준공일이 어떤 경우에도 바뀌지 않는다.')], needs_check: [] },
  },
};

function reviewContract(system, user) {
  const name = ['법무', '원가', '공정'].find((n) => system.includes(`${n} 관점에서만`));
  if (name === '원가' && user.includes('원가실패')) return 'JSON 이 아닌 답';
  if (name === '법무' && user.includes('조항번호없음')) return JSON.stringify({ findings: [F('', '높음', '근거 없음')], needs_check: [] });
  const base = CONTRACT_REVIEWS[user.includes('모든 설계변경 비용') ? 'onesided' : 'balanced'][name];
  if (name === '원가' && user.includes('문구조작')) return JSON.stringify({ ...base, delay_penalty: { ...base.delay_penalty, rate_quote: '계약금액의 1천분의 3' } });
  return JSON.stringify(base);
}

function textOf(content) {
  return typeof content === 'string' ? content : (content || []).map((c) => c.text || '').join('');
}

// params: Messages API 요청 본문. 돌려주는 값: Messages API 응답 본문
export function mockReply(params) {
  const system = textOf(params.system);
  const user = textOf(params.messages?.at(-1)?.content);
  let text;

  if (system.includes('관점에서만 검토하는 검토자')) {
    text = reviewContract(system, user);
  } else if (system.includes('민원 분류기')) {
    text = JSON.stringify(classifyComplaint(user));
  } else if (system.includes('민원 담당자')) {
    text = JSON.stringify(draftComplaint(user));
  } else if (system.includes('추출기')) {
    if (user.includes('판교')) text = JSON.stringify({ items: NORMAL_ITEMS });
    else if (user.includes('송도')) text = JSON.stringify({ items: MISSING_ITEMS });
    else if (user.includes('항목없음')) text = JSON.stringify({ items: [] });
    else if (user.includes('재시도')) {
      const key = user.split('<note>')[0].trim();
      const n = (attempts.get(key) || 0) + 1;
      attempts.set(key, n);
      text = n === 1 ? '{"items": "형식 오류"}' : JSON.stringify({ items: NORMAL_ITEMS });
    } else if (user.includes('항상실패')) text = 'JSON 이 아닌 답';
    else text = JSON.stringify({ items: NORMAL_ITEMS });
  } else if (system.includes('공지문')) {
    if (user.includes('여섯줄')) text = JSON.stringify({ lines: ['1', '2', '3', '4', '5', '6'], needs_check: [] });
    else text = JSON.stringify(NOTICE);
  } else {
    text = '{}';
  }

  return {
    id: `msg_mock_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: params.model,
    content: [{ type: 'text', text }],
    stop_reason: user.includes('거절') ? 'refusal' : 'end_turn',
    stop_sequence: null,
    stop_details: user.includes('거절') ? { type: 'refusal', category: null, explanation: 'mock' } : null,
    usage: { input_tokens: Math.ceil((system.length + user.length) / 2), output_tokens: Math.ceil(text.length / 2) },
  };
}

// 단위 테스트용 가짜 SDK client. 받은 요청을 requests 에 남긴다
export function fakeClient() {
  const requests = [];
  const create = (kind) => async (params) => {
    requests.push({ kind, params });
    return mockReply(params);
  };
  return { requests, messages: { create: create('messages') }, beta: { messages: { create: create('beta') } } };
}
