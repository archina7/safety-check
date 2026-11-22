// 작업 허가서 화면 (공용 함수는 agent-ui.js)
// 승인·반려 버튼은 서버가 can_decide(관리자)라고 할 때만 그린다. 서버도 결정 API 에서 다시 확인한다
const FLOW = ['신청', 'Agent 검토', '관리자 확인 대기'];
const MATCHING = { '승인 권고': '승인', '보완 요청': '반려' };
let meta = null; // { fields, types, can_decide, managers_configured, me }
let current = null;

const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const tomorrow = () => new Date(Date.now() + 9 * 3600 * 1000 + 86_400_000).toISOString().slice(0, 10);

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 401) { goLogin(); return null; }
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: data.error || `오류 (${res.status})` };
}

async function send(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { goLogin(); return null; }
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: data.error || `오류 (${res.status})`, needs_reason: data.needs_reason };
}

// ---------- 신청서 ----------

function inputFor(f) {
  const id = `f-${f.key}`;
  const attrs = { id, name: f.key };
  const control = f.key === 'description'
    ? el('textarea', attrs)
    : el('input', { ...attrs, type: f.kind === 'number' ? 'number' : f.kind, ...(f.kind === 'number' ? { min: f.min, max: f.max, step: 'any', inputMode: 'decimal' } : {}) });
  return el('div', { className: f.key === 'description' ? 'wide' : '' }, [el('label', { className: 'lbl', htmlFor: id, textContent: f.label }), control]);
}

function drawForm() {
  const type = $('type').value;
  const t = meta.types[type];
  $('fields').replaceChildren(...[...meta.fields, ...t.extra].map(inputFor));
  $('measures').replaceChildren(
    el('legend', { textContent: `필수 안전대책 · ${t.name} (확인한 것만 체크)` }),
    ...t.measures.map((m, i) => el('label', { htmlFor: `m-${i}` }, [el('input', { type: 'checkbox', id: `m-${i}`, value: m }), m])),
  );
}

function fillForm(form) {
  $('type').value = form.type;
  drawForm();
  for (const f of [...meta.fields, ...meta.types[form.type].extra]) {
    const v = f.key === 'work_date' ? tomorrow() : form[f.key];
    $(`f-${f.key}`).value = v ?? '';
  }
  for (const box of $('measures').querySelectorAll('input')) box.checked = form.measures.includes(box.value);
  $('other_measures').value = form.other_measures || '';
}

function readForm() {
  const type = $('type').value;
  const form = { type, other_measures: $('other_measures').value };
  for (const f of [...meta.fields, ...meta.types[type].extra]) form[f.key] = $(`f-${f.key}`).value;
  form.measures = [...$('measures').querySelectorAll('input:checked')].map((b) => b.value);
  return form;
}

// ---------- 허가서 보기 ----------

function flowView(status) {
  const done = ['승인', '반려'].includes(status);
  const steps = [...FLOW, done ? status : '승인 또는 반려'];
  const at = steps.indexOf(status);
  return el('ol', { className: 'flow', ariaLabel: '진행 단계' }, steps.map((s, i) => el('li', {
    className: `${i < at ? 'done' : i === at ? 'now' : ''}${s === '반려' ? ' rej' : ''}`,
    textContent: s,
    ariaCurrent: i === at ? 'step' : null,
  })));
}

function reviewView(r) {
  const ok = r.recommendation === '승인 권고';
  const c = r.code_check;
  const codeList = [...c.missing.map((m) => `누락: ${m}`), ...c.unchecked_measures.map((m) => `대책 미확인: ${m}`), ...c.problems];
  return [
    el('div', { className: `rec ${ok ? 'ok' : 'no'}` }, [
      el('h3', { textContent: `Agent 권고: ${r.recommendation}` }),
      r.overridden_by_code ? el('p', { className: 'hint', style: 'margin:0 0 6px', textContent: `Agent 는 '${r.agent_recommendation}'을 냈지만, 코드 점검에서 문제가 나와 '보완 요청'으로 두었습니다.` }) : null,
      el('ul', { className: 'list' }, r.reasons.map((x) => el('li', { textContent: x }))),
    ]),
    codeList.length ? el('div', { className: 'banner warn' }, [el('div', { textContent: '코드 점검 결과' }), el('ul', { className: 'list' }, codeList.map((x) => el('li', { textContent: x })))]) : null,
    r.measures.length ? el('details', { open: !ok }, [
      el('summary', { textContent: `위험별 대책 점검 ${r.measures.length}건` }),
      el('ul', { className: 'list', style: 'padding:0 12px 12px 32px' }, r.measures.map((m) => el('li', { textContent: `${m.adequate ? '충분' : '부족'} · ${m.hazard}: ${m.comment}` }))),
    ]) : null,
    [...r.missing_items, ...r.needs_check].length ? el('div', { className: 'banner warn' }, [el('div', { textContent: '추가 확인' }), el('ul', { className: 'list' }, [...r.missing_items, ...r.needs_check].map((x) => el('li', { textContent: x })))]) : null,
    r.unsupported_numbers?.length ? el('div', { className: 'banner warn', textContent: `신청서에 없는 숫자: ${r.unsupported_numbers.join(', ')} (확인 필요)` }) : null,
  ];
}

function decideView(p) {
  const rec = p.review?.recommendation;
  const reason = el('textarea', { id: 'reason', maxLength: 1000, placeholder: 'Agent 권고와 다르게 결정할 때는 사유가 필요합니다' });
  const msg = el('p', { className: 'hint', role: 'alert' });
  const go = async (decision) => {
    if (MATCHING[rec] !== decision && !reason.value.trim()) {
      msg.textContent = `Agent 권고(${rec})와 다른 결정입니다. 사유를 입력해 주세요.`;
      reason.focus();
      return;
    }
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    const data = await send(`/api/permits/${encodeURIComponent(p.id)}/decision`, { decision, reason: reason.value });
    if (!data) return;
    if (data.error) {
      msg.textContent = data.error;
      for (const b of box.querySelectorAll('button')) b.disabled = false;
      return;
    }
    await refresh(p.id);
  };
  const box = el('div', { className: 'decide' }, [
    el('h3', { style: 'margin:0 0 6px;font-size:1rem', textContent: '관리자 결정' }),
    el('label', { className: 'lbl', htmlFor: 'reason', textContent: '결정 사유' }),
    reason,
    msg,
    el('div', { className: 'btns' }, [
      el('button', { type: 'button', className: 'approve', textContent: '승인', onclick: () => go('승인') }),
      el('button', { type: 'button', className: 'reject', textContent: '반려', onclick: () => go('반려') }),
    ]),
  ]);
  return box;
}

function showPermit(p, canDecide) {
  current = p;
  const out = $('detail');
  out.replaceChildren();
  const f = p.form;
  out.append(
    el('h3', { style: 'margin:0 0 6px', textContent: `[${f.type}] ${p.title}` }),
    el('p', { className: 'hint', style: 'margin:0 0 8px', textContent: `${p.id} · 신청 ${p.applicant} · ${fmt(p.created_at)} · ${f.location || '장소 미기재'} · ${f.work_date || '날짜 미기재'} ${f.start_time || ''}~${f.end_time || ''}` }),
    flowView(p.status),
  );
  if (p.review) out.append(...reviewView(p.review).filter(Boolean));
  if (p.status === 'Agent 검토') {
    // review_error 가 없으면 아직 검토가 진행 중이다 (실패로 보이지 않게 한다)
    out.append(el('div', { className: `banner ${p.review_error ? 'bad' : 'warn'}` }, [
      el('div', { textContent: p.review_error ? `검토하지 못했습니다: ${p.review_error}` : 'Agent 가 검토하고 있습니다. 잠시 후 다시 열어 보세요. (오래 멈춰 있으면 다시 검토할 수 있습니다)' }),
      el('button', { type: 'button', textContent: '다시 검토하기', style: 'margin-top:8px', onclick: async (e) => { e.target.disabled = true; const d = await send(`/api/permits/${encodeURIComponent(p.id)}/review`, {}); if (d?.error) { e.target.disabled = false; alert(d.error); } else await refresh(p.id); } }),
    ]));
  }
  if (p.status === '관리자 확인 대기') {
    if (canDecide) out.append(decideView(p));
    else out.append(el('p', { className: 'banner warn', textContent: meta.managers_configured ? '관리자 확인을 기다리고 있습니다. 승인·반려는 관리자만 할 수 있습니다.' : '관리자 목록(MANAGER_EMAILS)이 설정되지 않아 아직 아무도 승인·반려할 수 없습니다.' }));
  }
  if (p.review?.steps?.length) {
    out.append(el('h3', { style: 'font-size:0.9375rem', textContent: '검토 단계별 입력·출력' }));
    if (p.review.totals) out.append(totalsView(p.review.totals));
    for (const s of p.review.steps) out.append(stepView(s));
  }
}

// ---------- 목록·이력 ----------

function drawList(permits) {
  $('list').replaceChildren(...(permits.length ? permits.map((p) => el('li', {}, el('button', {
    type: 'button',
    ariaCurrent: current?.id === p.id ? 'true' : 'false',
    onclick: () => openPermit(p.id),
  }, [
    el('span', { className: 't', textContent: `[${p.type}] ${p.title}` }),
    el('span', { className: 's', textContent: `${p.status}${p.recommendation ? ` · 권고 ${p.recommendation}` : ''} · ${p.applicant} · ${fmt(p.created_at)}` }),
  ]))) : [el('li', { className: 'empty-state', textContent: '아직 신청한 허가서가 없습니다.' })]));
}

function drawHistory(history) {
  if (!history.length) {
    $('history').replaceChildren(el('p', { className: 'empty-state', textContent: '아직 승인·반려한 허가서가 없습니다.' }));
    return;
  }
  $('history').replaceChildren(el('table', { className: 'hist' }, [
    el('thead', {}, el('tr', {}, ['허가서', '결정자·시각', 'Agent 권고', '최종 결정'].map((h) => el('th', { scope: 'col', textContent: h })))),
    el('tbody', {}, history.map((h) => el('tr', {}, [
      el('td', { textContent: `[${h.type}] ${h.title}` }),
      el('td', { textContent: `${h.decided_by} · ${fmt(h.decided_at)}` }),
      el('td', { textContent: h.recommendation || '-' }),
      el('td', {}, [el('b', { textContent: h.decision }), h.mismatch ? el('div', { textContent: `권고와 다름 · 사유: ${h.reason}` }) : (h.reason ? el('div', { textContent: h.reason }) : null)]),
    ]))),
  ]));
}

async function refresh(openId) {
  const data = await getJson('/api/permits');
  if (!data) return;
  if (data.error) {
    $('detail').replaceChildren(el('div', { className: 'banner bad', textContent: data.error }));
    return;
  }
  const first = !meta;
  meta = data;
  if (first) {
    $('type').replaceChildren(...Object.entries(data.types).map(([k, t]) => el('option', { value: k, textContent: t.name })));
    drawForm();
  }
  $('me').textContent = `${data.me} · ${data.can_decide ? '관리자 (승인·반려 가능)' : '신청자'}`;
  drawList(data.permits);
  drawHistory(data.history);
  if (openId) await openPermit(openId);
}

async function openPermit(id) {
  const data = await getJson(`/api/permits/${encodeURIComponent(id)}`);
  if (!data) return;
  if (data.error) return $('detail').replaceChildren(el('div', { className: 'banner bad', textContent: data.error }));
  showPermit(data.permit, data.can_decide);
  drawList(meta.permits);
}

$('type').addEventListener('change', drawForm);

$('submit').addEventListener('click', async () => {
  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = '검토 Agent 가 점검하는 중…';
  try {
    const data = await send('/api/permits', { form: readForm() });
    if (!data) return;
    if (data.error) {
      $('detail').replaceChildren(el('div', { className: 'banner warn', textContent: data.error }));
      return;
    }
    await refresh(data.permit.id);
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    $('detail').replaceChildren(el('div', { className: 'banner bad', textContent: '서버에 연결하지 못했습니다.' }));
  } finally {
    btn.disabled = false;
    btn.textContent = '신청하고 검토받기';
  }
});

async function loadSamples() {
  try {
    const res = await fetch('/permit-samples.json');
    if (!res.ok) return;
    const { samples } = await res.json();
    for (const s of samples) $('samples').append(el('button', { type: 'button', textContent: s.title, onclick: () => fillForm(s.form) }));
  } catch {
    // 예시를 못 불러와도 직접 입력은 된다
  }
}

refresh().then(loadSamples);
