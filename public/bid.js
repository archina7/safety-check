// 입찰 우선순위 화면 (공용 함수는 agent-ui.js, 점수 계산식은 bid-score.js — 서버와 같은 파일)
import { DEFAULT_WEIGHTS, FACTORS, FORMULA, MAX_WEIGHT, POINTS, rank } from './bid-score.js';

const HEAD = ['공고번호', '공고명', '발주기관', '공종', '지역', '추정가격', '마감일시', '참가자격'];
const weights = { ...DEFAULT_WEIGHTS };
let last = null; // 마지막 결과 (가중치를 바꾸면 이 결과로 순위만 다시 매긴다)

// 예시의 마감일은 '오늘부터 며칠 뒤' 로 적혀 있다 → 한국 날짜로 바꾼다
function dateAfter(days, time) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + days * 86_400_000);
  return `${d.toISOString().slice(0, 10)} ${time}`;
}

async function loadSamples() {
  try {
    const res = await fetch('/bid-samples.json');
    if (res.status === 401) return goLogin();
    const s = await res.json();
    $('samples').append(el('button', {
      type: 'button',
      textContent: `예시 · 조회 결과 ${s.bids.length}건`,
      onclick: () => {
        $('bids').value = [HEAD.join('\t'), ...s.bids.map((b) => [b.id, b.title, b.agency, b.trade, b.region, b.amount, dateAfter(b.days, b.time), b.qualification].join('\t'))].join('\n');
        $('company').value = s.company;
        $('bids').focus();
      },
    }));
  } catch {
    // 예시를 못 불러와도 직접 입력은 된다
  }
}

function weightInputs() {
  for (const f of FACTORS) {
    const id = `w-${f.key}`;
    const out = el('output', { htmlFor: id, textContent: String(weights[f.key]) });
    const input = el('input', {
      type: 'range', id, min: 0, max: MAX_WEIGHT, step: 1, value: weights[f.key],
      oninput: () => {
        weights[f.key] = Number(input.value);
        out.textContent = input.value;
        if (last?.rows) renderTable();
      },
    });
    $('weights').append(el('div', { className: 'weight' }, [el('label', { htmlFor: id, textContent: f.name }), input, out]));
  }
}

const allZero = () => FACTORS.every((f) => weights[f.key] === 0);
const POINT_TEXT = (r) => ({
  trade: `공종 ${r.review.trade_fit.level}`,
  region: `지역 ${r.review.region.status}`,
  deadline: r.days === 0 ? '오늘 마감' : `마감 D-${r.days}`,
  qualification: `자격 ${r.qualification}`,
});

function bidView(r) {
  const text = POINT_TEXT(r);
  const note = r.note;
  return el('li', { className: `bid${r.eligible ? '' : ' no'}` }, [
    el('div', { className: 'rank', textContent: String(r.rank), ariaLabel: `${r.rank}순위` }),
    el('h3', {}, [
      el('span', { textContent: r.title }),
      el('span', { className: 'score', textContent: `${r.score}점` }),
      r.eligible ? null : el('span', { className: 'badge bad', textContent: '참가 불가 가능성' }),
    ]),
    el('p', { className: 'sub', textContent: `${r.id} · ${r.agency || '발주기관 미기재'} · ${r.amount_text} · 마감 ${r.deadline}` }),
    el('ul', { className: 'chips' }, FACTORS.map((f) => el('li', {
      className: r.points[f.key] <= 30 ? 'low' : '',
      textContent: `${text[f.key]} (${r.points[f.key]})`,
    }))),
    el('p', { className: 'why' }, [
      r.eligible ? null : el('b', { textContent: `${r.ineligible_reasons.join(' · ')}. ` }),
      note ? note.reason : '이유를 쓰지 못했습니다.',
      note?.caution ? el('span', { className: 'caution', textContent: `확인: ${note.caution}` }) : null,
      note?.unsupported_numbers?.length ? el('span', { className: 'caution', textContent: `공고·검토 결과에 없는 숫자: ${note.unsupported_numbers.join(', ')} (확인 필요)` }) : null,
    ]),
  ]);
}

function renderTable() {
  const box = $('table');
  box.replaceChildren();
  if (allZero()) {
    box.append(el('div', { className: 'banner warn', textContent: '가중치를 하나 이상 0보다 크게 주세요.' }));
    return;
  }
  const ranked = rank(last.rows, weights);
  box.append(
    el('p', { className: 'formula', textContent: `${FORMULA} · 가중치 ${FACTORS.map((f) => `${f.name} ${weights[f.key]}`).join(', ')}` }),
    el('ol', { className: 'rows' }, ranked.map(bidView)),
  );
}

function bidList(title, kind, list, line) {
  if (!list?.length) return null;
  return el('div', { className: `banner ${kind}` }, [el('div', { textContent: `${title} ${list.length}건` }), el('ul', { className: 'list' }, list.map((b) => el('li', { textContent: line(b) })))]);
}

function render(r) {
  last = r;
  const out = $('result');
  out.replaceChildren();
  const kind = { ok: 'ok', partial: 'warn', invalid: 'warn', error: 'bad' }[r.status] || 'bad';
  const title = { ok: '우선순위를 정했습니다.', partial: '일부 결과로 우선순위를 정했습니다.', invalid: '입력을 확인해 주세요.', error: '우선순위를 정하지 못했습니다.' }[r.status] || '우선순위를 정하지 못했습니다.';
  out.append(el('div', { className: `banner ${kind}` }, [
    el('div', { textContent: title }),
    r.message ? el('div', { textContent: r.message, style: 'font-weight:400;margin-top:4px' }) : null,
  ]));

  if (r.rows) {
    if (r.summary?.text) out.append(el('p', { className: 'notice', textContent: r.summary.text }));
    out.append(el('h2', { textContent: `우선순위 (${r.rows.length}건)` }), el('div', { id: 'table' }));
    renderTable();
    out.append(el('details', {}, [
      el('summary', { textContent: '항목 점수 기준' }),
      el('div', { className: 'io' }, [el('pre', {
        textContent: [
          ...Object.entries(POINTS).map(([k, v]) => `${FACTORS.find((f) => f.key === k).name}: ${Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ')}`),
          '마감 여유: 2일 이하 30, 3~6일 70, 7일 이상 100',
          '지역 제한·참가 자격이 하나라도 미충족이면 점수와 관계없이 뒤로 보냅니다.',
        ].join('\n'),
      })]),
    ]));
  }
  out.append(
    bidList('검토 실패 공고', 'bad', r.failed, (b) => `${b.id} ${b.title} · ${b.amount_text} — ${b.message}`) || '',
    bidList('검토 제외 · 금액 순 11위 이하', 'warn', r.skipped?.overflow, (b) => `${b.id} ${b.title} · ${b.amount_text}`) || '',
    bidList('검토 제외 · 마감 지남', 'warn', r.skipped?.expired, (b) => `${b.id} ${b.title} · 마감 ${b.deadline}`) || '',
  );
  if (r.needs_check?.length) out.append(el('div', { className: 'banner warn' }, [el('div', { textContent: '확인 필요' }), el('ul', { className: 'list' }, r.needs_check.map((t) => el('li', { textContent: t })))]));
  if (r.totals) out.append(totalsView(r.totals));
  if (r.steps?.length) {
    out.append(el('h2', { textContent: '단계별 입력·출력' }));
    for (const s of r.steps) out.append(stepView(s));
  }
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  if (allZero()) return render({ status: 'invalid', message: '가중치를 하나 이상 0보다 크게 주세요.' });
  btn.disabled = true;
  btn.textContent = '공고를 3건씩 동시에 검토하는 중…';
  try {
    const data = await postJson('/api/bid', { bids: $('bids').value, company: $('company').value, weights });
    if (data) render(data);
  } catch {
    render({ status: 'error', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
  } finally {
    btn.disabled = false;
    btn.textContent = '우선순위 정하기';
  }
});

weightInputs();
loadSamples();
