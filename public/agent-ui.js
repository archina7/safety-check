// AI 기능 화면 공용: 단계별 입력·출력·소요 시간·토큰을 펼쳐 볼 수 있게 그린다 (TBM 공지문, 민원 분류)
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...[].concat(children).filter((c) => c !== null && c !== undefined));
  return node;
};
const sec = (ms) => `${(ms / 1000).toFixed(1)}초`;
const pretty = (v) => JSON.stringify(v, null, 2);

function goLogin() {
  location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
}

// badge: { text, kind: 'ok' | 'bad' | 'warn' } 를 주면 기본 '통과/멈춤' 대신 쓴다
function stepView(step, badge = null) {
  const failed = Boolean(step.error) || step.output?.ok === false;
  const b = badge || { text: failed ? '멈춤' : '통과', kind: failed ? 'bad' : 'ok' };
  const meta = [
    step.agent,
    sec(step.ms ?? 0),
    step.calls?.length ? `호출 ${step.calls.length}회` : null,
    step.calls?.length ? `토큰 입력 ${step.input_tokens} · 출력 ${step.output_tokens}` : null,
  ].filter(Boolean).join(' · ');
  // 멈춘 단계는 처음부터 펼쳐 둔다
  const details = el('details', { open: failed }, [
    el('summary', {}, [
      el('span', { className: 'step-name', textContent: step.name }),
      el('span', { className: `badge ${b.kind}`, textContent: b.text }),
      el('span', { className: 'meta', textContent: meta }),
    ]),
    el('div', { className: 'io' }, [
      el('div', {}, [el('h3', { textContent: '입력' }), el('pre', { textContent: pretty(step.input) })]),
      el('div', {}, [el('h3', { textContent: step.error ? '오류' : '출력' }), el('pre', { textContent: step.error || pretty(step.output) })]),
    ]),
  ]);
  if (step.calls?.length > 1) {
    details.append(el('p', { className: 'calls', textContent: `스키마가 맞지 않아 다시 요청했습니다: ${step.calls.map((c) => `${c.attempt}차 ${sec(c.ms)}`).join(', ')}` }));
  }
  return details;
}

function totalsView(t) {
  return el('p', { className: 'totals' }, [
    el('span', { textContent: `전체 ${sec(t.ms)}` }),
    el('span', { textContent: `Claude 호출 ${t.calls}회` }),
    el('span', { textContent: `토큰 입력 ${t.input_tokens} · 출력 ${t.output_tokens}` }),
  ]);
}

// POST JSON. 401 이면 로그인 화면으로 보낸다
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) {
    goLogin();
    return null;
  }
  const data = await res.json().catch(() => ({ status: 'error', message: '서버 응답을 읽지 못했습니다.' }));
  return data.status ? data : { status: 'error', message: data.error || data.message || `오류 (${res.status})` };
}
