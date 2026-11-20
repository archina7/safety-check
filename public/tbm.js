// TBM 기록 → 안전 공지문 화면 (공용 함수는 agent-ui.js)
async function loadSamples() {
  try {
    const res = await fetch('/tbm-samples.json');
    if (res.status === 401) return goLogin();
    const { samples } = await res.json();
    for (const s of samples) {
      $('samples').append(el('button', { type: 'button', textContent: s.label, onclick: () => { $('record').value = s.record; $('record').focus(); } }));
    }
  } catch {
    // 예시를 못 불러와도 직접 입력은 된다
  }
}

function render(result) {
  const out = $('result');
  out.replaceChildren();
  const kind = { ok: 'ok', blocked: 'bad', empty: 'warn', error: 'bad' }[result.status] || 'bad';
  const title = {
    ok: '공지문을 만들었습니다.',
    blocked: '2단계에서 멈췄습니다: 대책 누락',
    empty: '입력을 확인해 주세요.',
    error: '처리하지 못했습니다.',
  }[result.status] || '처리하지 못했습니다.';
  out.append(el('div', { className: `banner ${kind}` }, [el('div', { textContent: title }), result.message ? el('div', { textContent: result.message, style: 'font-weight:400;margin-top:4px' }) : null]));

  if (result.status === 'blocked' && result.missing?.length) {
    out.append(el('h2', { textContent: '대책 누락 목록' }));
    out.append(el('ul', { className: 'missing' }, result.missing.map((m) => el('li', {}, [el('b', { textContent: m.hazard }), ` — ${m.task}`]))));
  }

  if (result.status === 'ok' && result.notice) {
    out.append(el('h2', { textContent: '현장 게시용 공지문' }));
    out.append(el('ol', { className: 'notice' }, result.notice.lines.map((l) => el('li', { textContent: l }))));
    const checks = [...(result.notice.needs_check || [])];
    if (result.notice.unsupported_numbers?.length) checks.push(`기록에 없는 숫자: ${result.notice.unsupported_numbers.join(', ')}`);
    if (checks.length) out.append(el('div', { className: 'banner warn' }, [el('div', { textContent: '확인 필요' }), el('ul', { style: 'margin:4px 0 0;padding-left:20px;font-weight:400' }, checks.map((c) => el('li', { textContent: c })))]));
  }

  if (result.totals) out.append(totalsView(result.totals));
  if (result.steps?.length) {
    out.append(el('h2', { textContent: '단계별 입력·출력' }));
    result.steps.forEach((s) => out.append(stepView(s)));
  }
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = '만드는 중… (최대 1~2분)';
  try {
    const data = await postJson('/api/tbm', { record: $('record').value });
    if (data) render(data);
  } catch {
    render({ status: 'error', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
  } finally {
    btn.disabled = false;
    btn.textContent = '공지문 만들기';
  }
});

loadSamples();
