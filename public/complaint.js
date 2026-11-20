// 현장 민원 분류 화면 (공용 함수는 agent-ui.js)
const ROUTE_BADGE = {
  draft: { text: '답변 초안', kind: 'ok' },
  queue: { text: '담당자 확인 대기', kind: 'warn' },
  urgent: { text: '긴급', kind: 'bad' },
};

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadSamples() {
  try {
    const res = await fetch('/complaint-samples.json');
    if (res.status === 401) return goLogin();
    const { samples } = await res.json();
    const groups = new Map();
    for (const s of samples) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    for (const [group, list] of groups) {
      $('samples').append(el('div', { className: 'sample-group' }, [
        el('span', { textContent: group }),
        ...list.map((s, i) => el('button', {
          type: 'button',
          textContent: `${i + 1}`,
          title: s.complaint,
          ariaLabel: `${group} 예시 ${i + 1}`,
          onclick: () => { $('complaint').value = s.complaint; $('date').value = s.date; $('complaint').focus(); },
        })),
      ]));
    }
  } catch {
    // 예시를 못 불러와도 직접 입력은 된다
  }
}

// 확신도 기준은 서버가 판정에 쓴 값을 받아 쓴다 (화면과 서버가 어긋나지 않게)
function classificationView(c, threshold) {
  const low = typeof threshold === 'number' && c.confidence < threshold;
  return el('dl', { className: 'cls' }, [
    el('dt', { textContent: '유형' }), el('dd', { textContent: c.category }),
    el('dt', { textContent: '확신도' }),
    el('dd', { className: 'conf' }, [
      el('span', { textContent: c.confidence.toFixed(2) }),
      el('span', { className: `conf-bar${low ? ' low' : ''}` }, [el('span', { style: `width:${Math.round(c.confidence * 100)}%` })]),
      low ? el('span', { className: 'meta', textContent: `${threshold} 미만` }) : null,
    ]),
    el('dt', { textContent: '판단 이유' }), el('dd', { textContent: c.reason, style: 'font-weight:400' }),
  ]);
}

function attachmentsView(a) {
  if (a.work_notices) {
    return [
      el('h2', { textContent: '붙인 자료: 작업 예고 목록' }),
      a.work_notices.length
        ? el('ul', { className: 'attach' }, a.work_notices.map((w) => el('li', {}, [el('b', { textContent: w.time }), ` ${w.work} · ${w.location}${w.note ? ` (${w.note})` : ''}`])))
        : el('p', { className: 'empty-state', textContent: '해당 날짜에 등록된 작업 예고가 없습니다.' }),
    ];
  }
  if (a.equipment_bookings) {
    return [
      el('h2', { textContent: '붙인 자료: 장비 반입 예약' }),
      a.equipment_bookings.length
        ? el('ul', { className: 'attach' }, a.equipment_bookings.map((b) => el('li', {}, [el('b', { textContent: b.time }), ` ${b.equipment} · ${b.gate}`])))
        : el('p', { className: 'empty-state', textContent: '해당 날짜에 등록된 장비 반입 예약이 없습니다.' }),
    ];
  }
  return [];
}

function render(r) {
  const out = $('result');
  out.replaceChildren();

  if (r.status === 'urgent') {
    out.append(el('div', { className: 'urgent', role: 'alert' }, [
      '긴급 — 안전 민원',
      el('small', { textContent: `즉시 현장을 확인하세요. 답변 초안은 만들지 않았습니다.${r.needs_review ? ' 확신도가 낮아 분류도 함께 확인이 필요합니다.' : ''}` }),
    ]));
  } else {
    const kind = { drafted: 'ok', queued: 'warn', invalid: 'warn', error: 'bad' }[r.status] || 'bad';
    const title = { drafted: '답변 초안을 만들었습니다.', queued: '담당자 확인 대기열로 보냈습니다.', invalid: '입력을 확인해 주세요.', error: '처리하지 못했습니다.' }[r.status] || '처리하지 못했습니다.';
    out.append(el('div', { className: `banner ${kind}` }, [
      el('div', { textContent: title }),
      r.message && r.status !== 'drafted' ? el('div', { textContent: r.message, style: 'font-weight:400;margin-top:4px' }) : null,
    ]));
  }

  if (r.classification) {
    out.append(el('h2', { textContent: `분류 결과 · ${r.date}` }), classificationView(r.classification, r.confidence_threshold));
  }
  if (r.status === 'drafted') {
    out.append(...attachmentsView(r.attachments));
    out.append(el('h2', { textContent: '답변 초안 (담당자 검토 후 발송)' }), el('div', { className: 'draft', textContent: r.draft.draft }));
    const checks = [...(r.draft.needs_check || [])];
    if (r.draft.unsupported_numbers?.length) checks.push(`근거 자료에 없는 숫자: ${r.draft.unsupported_numbers.join(', ')}`);
    if (checks.length) out.append(el('div', { className: 'banner warn' }, [el('div', { textContent: '확인 필요' }), el('ul', { style: 'margin:4px 0 0;padding-left:20px;font-weight:400' }, checks.map((c) => el('li', { textContent: c })))]));
  }

  if (r.totals) out.append(totalsView(r.totals));
  if (r.steps?.length) {
    out.append(el('h2', { textContent: '단계별 입력·출력' }));
    for (const s of r.steps) out.append(stepView(s, s.name === '2단계 처리 방식' ? ROUTE_BADGE[s.output?.route] : null));
  }
}

$('date').value = todayLocal();

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = '분류하는 중…';
  try {
    const data = await postJson('/api/complaint', { complaint: $('complaint').value, date: $('date').value });
    if (data) render(data);
  } catch {
    render({ status: 'error', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
  } finally {
    btn.disabled = false;
    btn.textContent = '분류하고 보내기';
  }
});

loadSamples();
