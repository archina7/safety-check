// OpenAI 호출을 대신하는 고정 응답(mock). 요청의 system·user 내용을 보고 정해진 답을 돌려준다.
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

// 입찰공고 Worker 고정 응답: 공고의 공종·참가자격 문구와 회사 정보를 단순 규칙으로 맞춰 본다
const between = (s, tag) => s.split(`<${tag}>`)[1]?.split(`</${tag}>`)[0]?.trim() ?? '';
function reviewBid(user) {
  const bid = JSON.parse(between(user, 'bid'));
  const company = between(user, 'company');
  if (bid.title.includes('검토실패')) return 'JSON 이 아닌 답';
  const parts = bid.qualification.split(',').map((s) => s.trim()).filter(Boolean);
  const regionPart = parts.find((p) => p.includes('지역제한')) || '';
  const regionOk = regionPart && company.includes(regionPart.split(' ')[0]);
  const qualifications = parts.filter((p) => p !== regionPart).map((p) => {
    if (p.endsWith('실적')) {
      const what = p.replace(/\s*실적$/, '');
      return company.includes(what) ? { requirement: p, status: '충족', evidence: `회사 실적에 ${what} 있음` } : { requirement: p, status: '확인 필요', evidence: '회사 정보에 없음' };
    }
    const license = p.replace(/\s*등록$/, '');
    return company.includes(license) ? { requirement: p, status: '충족', evidence: `보유 면허 ${license}` } : { requirement: p, status: '미충족', evidence: '보유 면허에 없음' };
  });
  const fit = bid.trade.includes('건축') ? '높음' : '낮음';
  return JSON.stringify({
    trade_fit: { level: fit, reason: `공고 공종은 ${bid.trade}, 회사 주력은 건축` },
    region: {
      site: bid.region,
      restriction: regionPart,
      status: regionPart ? (regionOk ? '충족' : '미충족') : '제한 없음',
      reason: regionPart ? `본사 소재지와 지역 제한 비교` : '지역 제한 없음',
    },
    qualifications,
    needs_check: qualifications.filter((q) => q.status === '확인 필요').map((q) => `${q.requirement} 확인 필요`),
  });
}

function prioritizeBids(user) {
  const list = JSON.parse(between(user, 'review'));
  if (list.some((b) => b.title.includes('이유실패'))) return 'JSON 이 아닌 답';
  return JSON.stringify({
    reasons: list.map((b) => ({
      bid_id: b.id,
      reason: b.eligible ? `${b.title}: 공종 적합도 ${b.trade_fit.level}, 참가 자격을 맞춘다.` : `참가가 어렵다: ${b.ineligible_reasons.join(', ')}`,
      caution: b.title.includes('근거없는숫자') ? '낙찰률 87.745% 를 노린다.' : '',
    })),
    summary: '참가 자격을 맞추는 건축 공고를 먼저 준비한다.',
    needs_check: [],
  });
}

// 보도자료 작성 고정 응답: 사실 'key: value' 줄을 그대로 옮긴다.
// 첫 초안에는 근거 없는 '업계 최초'를 넣고, <feedback> 을 받으면 뺀다. '고집' 이 있으면 끝까지 '국내 최고' 를 남긴다
function writePress(user) {
  const facts = Object.fromEntries(between(user, 'facts').split('\n').map((l) => l.split(/:\s*/)).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(': ').trim()]));
  const revising = user.includes('<feedback>');
  const lead = `${facts['회사']}은 ${facts['날짜']} ${facts['내용']}을 했다고 밝혔다.`;
  const rest = Object.entries(facts).filter(([k]) => !['회사', '날짜', '내용'].includes(k)).map(([k, v]) => `${k}: ${v}.`).join(' ');
  const paragraphs = [lead, rest];
  if (!revising && facts['내용']?.includes('준공')) paragraphs.push('이번 공사는 업계 최초의 성과다.');
  if (user.includes('숫자추가')) paragraphs.push('공사비는 350억 원이다.');
  if (user.includes('고집')) paragraphs.push('국내 최고 수준의 품질을 인정받았다.');
  if (user.includes('줄바꿈제목')) return JSON.stringify({ title: '제목\n둘째 줄', paragraphs, needs_check: [] });
  return JSON.stringify({ title: `${facts['회사']}, ${facts['내용']}`, paragraphs, needs_check: [] });
}

// 보도자료 평가 고정 응답: 과장 표현과 '(주)' 표기만 본다 (숫자 검사는 코드가 한다)
function evaluatePress(user) {
  const draft = between(user, 'draft');
  const hype = ['최초', '최고'].filter((w) => draft.includes(w));
  const ok = (reason) => ({ pass: true, reason });
  return JSON.stringify({
    facts: ok('초안의 사실이 입력에 있다.'),
    naming: draft.includes('(주)') ? { pass: false, reason: "'(주)' 표기는 규칙 위반" } : ok('회사명 표기를 지켰다.'),
    lead: ok('첫 문단에 회사·내용·날짜가 있다.'),
    hype: hype.length ? { pass: false, reason: `근거 없는 '${hype.join("', '")}' 표현이 있다.` } : ok('과장 표현이 없다.'),
  });
}

// 현장 질의 Agent 고정 응답: 질문의 낱말로 부를 도구를 정하고, 도구 결과(function_call_output)가 다 모이면 답한다
const QA_TRADES = ['토공', '골조', '설비', '전기', '마감'];
function qaDate(q, today) {
  const iso = q.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const md = q.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (md) return `2026-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  return today;
}
function qaPlan(q, today) {
  if (q.includes('반복')) return ['18', '19', '20', '21', '23', '24', '25'].map((d) => ['get_workforce', { date: `2026-11-${d}` }]);
  const plan = [];
  const date = qaDate(q, today);
  if (q.includes('잘못된인자')) plan.push(['get_workforce', { date: '어제' }]);
  if (q.includes('공정')) plan.push(['get_progress', { trade: QA_TRADES.find((t) => q.includes(t)) || '전체' }]);
  if (q.includes('출역') || q.includes('인원')) plan.push(['get_workforce', { date }]);
  if (q.includes('점검')) plan.push(['get_inspections', { date }]);
  return plan;
}
function siteQa(params) {
  const items = params.input || [];
  const first = textOf(items.find((m) => m.role === 'user')?.content);
  const q = between(first, 'question');
  const today = between(first, 'today');
  const outputs = items.filter((m) => m.type === 'function_call_output').map((m) => JSON.parse(m.output));
  const plan = qaPlan(q, today);
  if (outputs.length < plan.length && params.tool_choice !== 'none') {
    const next = q.includes('동시') ? plan.slice(outputs.length) : [plan[outputs.length]];
    return { calls: next.map(([name, args], i) => ({ name, arguments: JSON.stringify(args), call_id: `call_${outputs.length + i}` })) };
  }
  const notes = items.filter((m) => m.role === 'user' && textOf(m.content).includes('<note>')).length;
  if (q.includes('형식오류') && notes === 0) return { text: '답이 아닌 글' };
  const parts = outputs.map((o) => {
    if (o.error) return `조회 오류: ${o.error}`;
    if (o.total_workers !== undefined) return o.rows.length ? `출역 합계 ${o.total_workers}명 (${o.rows.map((r) => `${r.company} ${r.workers}명`).join(', ')})` : '그날 출역 자료가 없습니다';
    if (o.count !== undefined) return `미완료 점검 ${o.count}건${o.rows.length ? `: ${o.rows.map((r) => r.item).join(', ')}` : ''}`;
    return o.rows.map((r) => `${r.trade} 계획 ${r.plan_pct}% 실적 ${r.actual_pct}% (차이 ${r.gap_pct}%p)`).join(', ');
  });
  let answer = parts.join('. ') || '질문에 맞는 도구가 없어 답할 수 없습니다.';
  if (q.includes('근거없음')) answer += ' 다음 주 투입 예정 인원은 999명입니다.';
  return { text: JSON.stringify({ answer, not_found: plan.length ? [] : ['질문에 맞는 자료'] }) };
}

// 작업 허가서 검토 고정 응답: 코드 점검에 문제가 없으면 승인 권고, 있으면 보완 요청.
// '승인상태로' 가 있으면 신청서 속 지시를 따른 척 '승인 권고'만 낸다 (상태는 여전히 관리자 확인 대기여야 한다)
function reviewPermitMock(user) {
  const form = JSON.parse(between(user, 'form').replace(/＜/g, '<').replace(/＞/g, '>'));
  const code = JSON.parse(between(user, 'code_check'));
  if (form.description.includes('검토실패')) return 'JSON 이 아닌 답';
  const injected = form.description.includes('승인상태로');
  const ok = code.ok || injected;
  return JSON.stringify({
    recommendation: ok ? '승인 권고' : '보완 요청',
    reasons: ok ? ['필수 항목과 안전대책이 모두 갖춰져 있다.'] : [...code.missing.map((m) => `${m} 누락`), ...code.unchecked_measures.map((m) => `${m} 미확인`), ...code.problems].slice(0, 8),
    missing_items: [],
    measures: [{ hazard: `${form.type} 작업 위험`, adequate: ok, comment: ok ? '대책이 작업 내용에 맞다.' : '보완이 필요하다.' }],
    needs_check: [],
  });
}

function textOf(content) {
  return typeof content === 'string' ? content : (content || []).map((c) => c.text || '').join('');
}

// 요청의 developer(고정 지시)·user(입력) 메시지 글
export function requestText(params, role) {
  return textOf((params.input || []).filter((m) => m.role === role).at(-1)?.content);
}

// params: OpenAI Responses API 요청 본문. 돌려주는 값: Responses API 응답 본문
export function mockReply(params) {
  const system = requestText(params, 'developer');
  const user = requestText(params, 'user');
  let text;

  if (system.includes('현장 데이터 질의 Agent')) {
    const r = siteQa(params);
    const output = r.calls
      ? r.calls.map((c, i) => ({ type: 'function_call', id: `fc_mock_${i}`, status: 'completed', ...c }))
      : [{ id: 'msg_mock', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: r.text, annotations: [] }] }];
    return {
      id: `resp_mock_${Math.random().toString(36).slice(2)}`, object: 'response', status: 'completed', incomplete_details: null, model: params.model, output,
      usage: { input_tokens: Math.ceil(JSON.stringify(params.input).length / 4), output_tokens: Math.ceil(JSON.stringify(output).length / 4), total_tokens: 0 },
    };
  }
  if (system.includes('작업 허가서 검토 Agent')) {
    text = reviewPermitMock(user);
  } else if (system.includes('보도자료 작성 Agent')) {
    text = writePress(user);
  } else if (system.includes('보도자료 평가 Agent')) {
    text = evaluatePress(user);
  } else if (system.includes('입찰공고 검토 Worker')) {
    text = reviewBid(user);
  } else if (system.includes('입찰 우선순위 정리')) {
    text = prioritizeBids(user);
  } else if (system.includes('관점에서만 검토하는 검토자')) {
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

  const refused = user.includes('거절');
  return {
    id: `resp_mock_${Math.random().toString(36).slice(2)}`,
    object: 'response',
    status: 'completed',
    incomplete_details: null,
    model: params.model,
    output: [{
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [refused ? { type: 'refusal', refusal: 'mock' } : { type: 'output_text', text, annotations: [] }],
    }],
    usage: { input_tokens: Math.ceil((system.length + user.length) / 2), output_tokens: Math.ceil(text.length / 2), total_tokens: 0 },
  };
}

// 단위 테스트용 가짜 SDK client. 받은 요청을 requests 에 남긴다
export function fakeClient() {
  const requests = [];
  const create = async (params) => {
    requests.push({ params });
    return mockReply(params);
  };
  return { requests, responses: { create } };
}
