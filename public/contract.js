// 계약서 세 관점 검토 화면 (공용 함수는 agent-ui.js)
const NAMES = { legal: '법무', cost: '원가', schedule: '공정' };
const ORDER = ['legal', 'cost', 'schedule'];
let RISK_LEVELS = ['낮음', '보통', '높음', '매우높음']; // 서버가 보낸 값으로 바꾼다

const riskBadge = (risk) => el('span', { className: `risk risk-${Math.max(0, RISK_LEVELS.indexOf(risk))}`, textContent: risk });

async function loadSamples() {
  try {
    const res = await fetch('/contract-samples.json');
    if (res.status === 401) return goLogin();
    const { samples } = await res.json();
    for (const s of samples) {
      $('samples').append(el('button', {
        type: 'button',
        textContent: s.title,
        onclick: () => { $('contract').value = s.contract; $('contract').focus(); },
      }));
    }
  } catch {
    // 예시를 못 불러와도 직접 입력은 된다
  }
}

// 한 조항에 대한 세 관점 의견을 나란히 (평균·종합 점수는 만들지 않는다)
function clauseView(c, ran) {
  return el('div', { className: `clause${c.conflict ? ' conflict' : ''}` }, [
    el('h3', {}, [
      `${c.clause}${c.title ? ` (${c.title})` : ''}`,
      c.conflict ? el('span', { className: 'badge bad', textContent: `의견 충돌 · ${c.gap}단계 차이` }) : null,
    ]),
    el('div', { className: 'views' }, ORDER.map((k) => {
      const list = c.opinions[k] || [];
      if (!list.length) {
        return el('div', { className: 'view none' }, [
          el('h4', { textContent: NAMES[k] }),
          ran.includes(k) ? '이 관점의 지적 없음' : '검토 실패',
        ]);
      }
      return el('div', { className: 'view' }, [
        el('h4', {}, [NAMES[k], riskBadge(c.risks[k])]),
        ...list.flatMap((o) => [
          el('p', {}, [el('b', { textContent: `${o.ref} ` }), o.issue]),
          o.recommendation ? el('p', { className: 'rec', textContent: `제안: ${o.recommendation}` }) : null,
          o.unsupported_numbers?.length ? el('p', { className: 'rec', textContent: `계약서에 없는 숫자: ${o.unsupported_numbers.join(', ')} (확인 필요)` }) : null,
        ]),
      ]);
    })),
  ]);
}

function penaltyView(p) {
  if (!p.ok) return el('div', { className: 'banner warn' }, [el('div', { textContent: '지체상금을 계산하지 못했습니다' }), el('ul', { className: 'list' }, p.needs_check.map((t) => el('li', { textContent: t })))]);
  const rows = [
    ['근거 조항', p.clause],
    ['지체상금률', `${p.rate_quote} (${p.rate})`],
    ['계약금액', p.contract_amount],
    ['1일 지체상금', p.per_day],
    ['상한', p.cap || '없음'],
  ];
  if (p.days !== undefined) rows.push(['지체 일수', `${p.days}일`], ['계산액', p.total], ['적용액', `${p.applied}${p.capped ? ' (상한 적용)' : ''}`]);
  rows.push(['계산식', p.formula]);
  return [
    el('dl', { className: 'penalty' }, rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })])),
    p.needs_check?.length ? el('div', { className: 'banner warn' }, [el('div', { textContent: '참고' }), el('ul', { className: 'list' }, p.needs_check.map((t) => el('li', { textContent: t })))]) : null,
  ];
}

function render(r) {
  const out = $('result');
  out.replaceChildren();
  if (Array.isArray(r.risks)) RISK_LEVELS = r.risks;

  const kind = { ok: 'ok', partial: 'warn', invalid: 'warn', error: 'bad' }[r.status] || 'bad';
  const title = { ok: '세 관점 검토를 마쳤습니다.', partial: '일부 관점만 검토했습니다.', invalid: '입력을 확인해 주세요.', error: '검토하지 못했습니다.' }[r.status] || '검토하지 못했습니다.';
  out.append(el('div', { className: `banner ${kind}` }, [
    el('div', { textContent: title }),
    r.message ? el('div', { textContent: r.message, style: 'font-weight:400;margin-top:4px' }) : null,
  ]));

  if (r.review) {
    const { clauses, conflicts, perspectives: ran } = r.review;
    out.append(el('h2', { textContent: `조항별 의견 · 의견 충돌 ${conflicts}건` }));
    if (!clauses.length) out.append(el('p', { className: 'empty-state', textContent: '지적된 조항이 없습니다.' }));
    // 의견 충돌 조항을 먼저 보여 준다
    for (const c of [...clauses.filter((x) => x.conflict), ...clauses.filter((x) => !x.conflict)]) out.append(clauseView(c, ran));
  }
  if (r.discarded?.length) {
    out.append(el('div', { className: 'banner warn' }, [
      el('div', { textContent: `계약서에 없는 조항 번호라 버린 의견 ${r.discarded.length}건` }),
      el('ul', { className: 'list' }, r.discarded.map((d) => el('li', { textContent: `${NAMES[d.perspective]} · ${d.clause || '(번호 없음)'} · ${d.issue}` }))),
    ]));
  }
  if (r.delay_penalty) out.append(el('h2', { textContent: '지체상금 (코드 계산)' }), ...[].concat(penaltyView(r.delay_penalty)));
  const checks = Object.entries(r.needs_check || {}).flatMap(([k, list]) => list.map((t) => `${NAMES[k]}: ${t}`));
  if (checks.length) out.append(el('div', { className: 'banner warn' }, [el('div', { textContent: '확인 필요' }), el('ul', { className: 'list' }, checks.map((t) => el('li', { textContent: t })))]));

  if (r.totals) out.append(totalsView(r.totals));
  if (r.steps?.length) {
    out.append(el('h2', { textContent: '단계별 입력·출력' }));
    for (const s of r.steps) out.append(stepView(s));
  }
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = '세 관점이 동시에 검토하는 중…';
  try {
    const data = await postJson('/api/contract', { contract: $('contract').value, delay_days: $('days').value });
    if (data) render(data);
  } catch {
    render({ status: 'error', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
  } finally {
    btn.disabled = false;
    btn.textContent = '세 관점으로 검토하기';
  }
});

loadSamples();
