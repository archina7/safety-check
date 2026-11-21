// 현장 데이터 질의 화면 (공용 함수는 agent-ui.js)
const SAMPLES = [
  '오늘 협력사별 출역 인원 알려줘',
  '골조 공정률이 계획보다 얼마나 늦어?',
  '11월 24일 미완료 안전점검 항목과 출역 인원은?',
  '전체 공정률과 전기 공정률을 비교해줘',
];

for (const q of SAMPLES) {
  $('samples').append(el('button', { type: 'button', textContent: q, onclick: () => { $('question').value = q; $('question').focus(); } }));
}

function usedTable(used) {
  return el('table', { className: 'used' }, [
    el('caption', { className: 'hint', style: 'text-align:left;caption-side:top;margin-bottom:4px', textContent: '사용한 도구와 조회 조건 (호출 기록)' }),
    el('thead', {}, el('tr', {}, ['#', '도구', '조회 조건', '결과'].map((h) => el('th', { scope: 'col', textContent: h })))),
    el('tbody', {}, used.length
      ? used.map((u) => el('tr', {}, [
        el('td', { textContent: String(u.n) }),
        el('td', { textContent: u.tool }),
        el('td', { textContent: u.condition }),
        el('td', { textContent: u.error ? `오류: ${u.error}` : `${u.rows}건` }),
      ]))
      : el('tr', {}, el('td', { colSpan: 4, textContent: '부른 도구 없음' }))),
  ]);
}

function render(r) {
  const out = $('result');
  out.replaceChildren();
  const kind = { ok: 'ok', limit: 'warn', invalid: 'warn', error: 'bad' }[r.status] || 'bad';
  const title = { ok: '답변', limit: '도구 호출 한도에서 멈췄습니다', invalid: '질문을 확인해 주세요', error: '답하지 못했습니다' }[r.status] || '답하지 못했습니다';
  out.append(el('div', { className: `banner ${kind}` }, [
    el('div', { textContent: title }),
    r.message ? el('div', { textContent: r.message, style: 'font-weight:400;margin-top:4px' }) : null,
  ]));
  if (r.answer) out.append(el('p', { className: 'answer', textContent: r.answer }));
  if (r.unsupported_numbers?.length) out.append(el('div', { className: 'banner warn', textContent: `도구 결과에 없는 숫자: ${r.unsupported_numbers.join(', ')} (확인 필요)` }));
  if (r.not_found?.length) out.append(el('div', { className: 'banner warn' }, [el('div', { textContent: '찾지 못한 내용' }), el('ul', { className: 'list' }, r.not_found.map((t) => el('li', { textContent: t })))]));
  if (!r.answer && r.partial?.length) out.append(el('h2', { textContent: '지금까지 찾은 내용' }), el('pre', { textContent: JSON.stringify(r.partial, null, 2) }));
  if (r.tools_used && r.status !== 'invalid') out.append(usedTable(r.tools_used));
  if (r.totals) out.append(totalsView(r.totals));
  if (r.steps?.length) {
    out.append(el('h2', { textContent: '단계별 입력·출력' }));
    for (const s of r.steps) out.append(stepView(s));
  }
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = '찾는 중…';
  try {
    const data = await postJson('/api/ask', { question: $('question').value });
    if (data) render(data);
  } catch {
    render({ status: 'error', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
  } finally {
    btn.disabled = false;
    btn.textContent = '물어보기';
  }
});
