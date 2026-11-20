const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
let items = [];
let today = '';

// 기기 시간 기준 오늘 날짜 (YYYY-MM-DD)
function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function storageKey() { return `safety-check:${today}`; }

function loadChecked() {
  try {
    const raw = localStorage.getItem(storageKey());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveChecked(set) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify([...set]));
  } catch {
    // 저장 불가(사생활 보호 모드 등) — 화면 체크는 그대로 둔다
  }
}

function showDate() {
  const d = new Date();
  document.getElementById('date').textContent =
    `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

function updateCount() {
  const checked = loadChecked();
  const done = items.filter((it) => checked.has(it.id)).length;
  const total = items.length;
  const allDone = total > 0 && done === total;

  document.getElementById('done').textContent = done;
  document.getElementById('total').textContent = total;
  document.getElementById('count').classList.toggle('done', allDone);

  const bar = document.getElementById('bar');
  bar.classList.toggle('done', allDone);
  bar.setAttribute('aria-valuemax', total);
  bar.setAttribute('aria-valuenow', done);
  bar.firstElementChild.style.width = total ? `${(done / total) * 100}%` : '0';

  document.getElementById('notice').hidden = !allDone;
}

function render() {
  const list = document.getElementById('list');
  const tpl = document.getElementById('item');
  const checked = loadChecked();
  list.replaceChildren();

  for (const it of items) {
    const node = tpl.content.cloneNode(true);
    const input = node.querySelector('input');
    input.checked = checked.has(it.id);
    input.addEventListener('change', () => {
      const set = loadChecked();
      input.checked ? set.add(it.id) : set.delete(it.id);
      saveChecked(set);
      updateCount();
    });
    node.querySelector('.tag').textContent = it.category;
    node.querySelector('.content').textContent = it.content;
    node.querySelector('.law').textContent = `근거: ${it.law}`;
    list.append(node);
  }

  list.hidden = false;
  updateCount();
}

async function load() {
  const state = document.getElementById('state');
  state.hidden = false;
  state.textContent = '점검 항목을 불러오는 중입니다…';
  let res;
  try {
    res = await fetch('/api/inspections', { headers: { Accept: 'application/json' } });
  } catch {
    res = null; // 요청 자체가 실패: 오프라인이거나 서버에 닿지 않음
  }
  try {
    if (res?.status === 401) return goLogin();
    if (!res?.ok) throw new Error(String(res?.status));
    items = (await res.json()).items;
    state.hidden = true;
    render();
  } catch {
    // 점검 항목(/api/)은 로그인한 사용자 데이터라 오프라인용으로 저장하지 않는다
    const text = res === null
      ? '오프라인이거나 서버에 연결할 수 없습니다. 인터넷에 연결되면 다시 시도해 주세요.'
      : '점검 항목을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
    state.replaceChildren(
      Object.assign(document.createElement('p'), { textContent: text }),
      Object.assign(document.createElement('button'), { type: 'button', textContent: '다시 시도', onclick: load }),
    );
  }
}

// 연결이 돌아오면 항목을 아직 못 불러온 경우 다시 불러온다
window.addEventListener('online', () => {
  if (!items.length) load();
  showUser();
});

// 날짜가 바뀐 채로 화면을 다시 열면 새 날짜의 체크 상태로 바꾼다
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localDateKey() !== today) {
    today = localDateKey();
    showDate();
    if (items.length) render();
  }
});

function goLogin() {
  location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
}

async function showUser() {
  try {
    const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    if (res.status === 401) return goLogin();
    if (res.ok) document.getElementById('who').textContent = (await res.json()).email;
  } catch {
    // 사용자 표시는 실패해도 점검은 계속할 수 있다
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  try {
    await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } finally {
    location.replace('/login');
  }
});

// ---- 앱 설치 (PWA) ----
const $ = (id) => document.getElementById(id);

if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('/sw.js');
let installEvt; // 설치 가능하면 브라우저가 보내는 이벤트를 보관한다
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); installEvt = e; $('install').hidden = false; });
$('install').onclick = () => { // 설치 창 열기 (한 이벤트로 한 번만 열 수 있다)
  installEvt?.prompt(); installEvt = null; $('install').hidden = true; };
addEventListener('appinstalled', () => { $('install').hidden = true; });

today = localDateKey();
showDate();
showUser();
load();
