// 보도자료 초안 화면 (공용 함수는 agent-ui.js). 게시 기능은 없다. 승인은 이 화면에만 표시한다
async function loadSamples() {
  try {
    const res = await fetch('/press-samples.json');
    if (res.status === 401) return goLogin();
    const { rules, samples } = await res.json();
    if (!$('rules').value) $('rules').value = rules;
    for (const s of samples) {
      $('samples').append(el('button', {
        type: 'button',
        textContent: s.title,
        onclick: () => { $('facts').value = s.facts; $('rules').value = rules; $('facts').focus(); },
      }));
    }
  } catch {
    // 예시를 못 불러와도 직접 입력은 된다
  }
}

const releaseText = (d) => [d.title, '', ...d.paragraphs.flatMap((p) => [p, ''])].join('\n').trim();

function criteriaView(results) {
  return el('ul', { className: 'crit' }, results.map((r) => el('li', { className: r.pass ? '' : 'fail' }, [
    el('div', { className: 'head' }, [
      el('span', { className: `badge ${r.pass ? 'ok' : 'bad'}`, textContent: r.pass ? '통과' : '실패' }),
      el('span', { textContent: r.name }),
      el('span', { className: 'by', textContent: r.by }),
    ]),
    el('p', { textContent: r.reason }),
  ])));
}

// 승인: 사람이 누른다. 실패가 남은 초안은 확인란을 체크해야 누를 수 있다. 게시는 하지 않는다
function approveView(r) {
  const failedLeft = !r.results || r.results.some((x) => !x.pass);
  const check = failedLeft ? el('input', { type: 'checkbox', id: 'ack' }) : null;
  const btn = el('button', { type: 'button', className: 'primary', textContent: '승인', disabled: failedLeft });
  const copy = el('button', { type: 'button', textContent: '본문 복사', hidden: true });
  const done = el('p', { className: 'hint', hidden: true });
  if (check) check.addEventListener('change', () => { btn.disabled = !check.checked; });
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = '승인됨';
    if (check) check.disabled = true;
    done.hidden = false;
    done.textContent = `${new Date().toLocaleString('ko-KR')} 승인. 게시는 하지 않았습니다. 복사해서 배포 절차에 쓰세요.`;
    copy.hidden = false;
  });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(releaseText(r.draft));
      copy.textContent = '복사했습니다';
    } catch {
      copy.textContent = '복사하지 못했습니다';
    }
  });
  return el('div', { className: 'approve' }, [
    check ? el('label', { htmlFor: 'ack' }, [check, '실패한 기준을 사람이 확인했고, 이 초안을 승인합니다.']) : el('p', { style: 'margin:0;font-weight:600', textContent: '모든 기준을 통과했습니다. 내용을 읽고 승인해 주세요.' }),
    el('div', { className: 'btns' }, [btn, copy]),
    done,
  ]);
}

function render(r) {
  const out = $('result');
  out.replaceChildren();
  const kind = { passed: 'ok', review: 'warn', invalid: 'warn', error: 'bad' }[r.status] || 'bad';
  const title = { passed: '승인 대기', review: '사람 검토 필요', invalid: '입력을 확인해 주세요.', error: '초안을 만들지 못했습니다.' }[r.status] || '초안을 만들지 못했습니다.';
  out.append(el('div', { className: `banner ${kind}` }, [
    el('div', { textContent: title }),
    r.message ? el('div', { textContent: r.message, style: 'font-weight:400;margin-top:4px' }) : null,
  ]));

  if (r.draft) {
    if (r.results) {
      const failed = r.results.filter((x) => !x.pass);
      out.append(el('h2', { textContent: failed.length ? `남은 실패 기준 ${failed.length}개` : '기준표 평가 (최종)' }), criteriaView(r.results));
    }
    out.append(
      el('h2', { textContent: `초안${r.revisions ? ` (수정 ${r.revisions}회)` : ''}` }),
      el('article', { className: 'release' }, [el('h3', { textContent: r.draft.title }), ...r.draft.paragraphs.map((p) => el('p', { textContent: p }))]),
    );
    if (r.draft.needs_check?.length) out.append(el('div', { className: 'banner warn' }, [el('div', { textContent: '확인 필요' }), el('ul', { className: 'list' }, r.draft.needs_check.map((t) => el('li', { textContent: t })))]));
    out.append(approveView(r));
  }
  if (r.rounds?.length > 1) {
    out.append(el('h2', { textContent: '회차별 평가' }));
    for (const round of r.rounds) {
      out.append(el('details', {}, [
        el('summary', {}, [el('span', { className: 'step-name', textContent: round.round ? `수정 ${round.round}회차` : '첫 초안' }), el('span', { className: 'meta', textContent: `실패 ${round.results.filter((x) => !x.pass).length}개` })]),
        el('div', { className: 'io' }, [el('pre', { textContent: releaseText(round.draft) }), criteriaView(round.results)]),
      ]));
    }
  }
  if (r.totals) out.append(totalsView(r.totals));
  if (r.steps?.length) {
    out.append(el('h2', { textContent: '단계별 입력·출력' }));
    for (const s of r.steps) out.append(stepView(s));
  }
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = '작성·평가하는 중…';
  try {
    const data = await postJson('/api/press', { facts: $('facts').value, rules: $('rules').value });
    if (data) render(data);
  } catch {
    render({ status: 'error', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
  } finally {
    btn.disabled = false;
    btn.textContent = '초안 만들고 평가하기';
  }
});

loadSamples();
