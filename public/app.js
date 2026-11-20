const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
let items = [];
let today = '';
let userEmail = ''; // 체크 기록을 사람별로 나누는 데 쓴다 (/api/me)

// 기기 시간 기준 오늘 날짜 (YYYY-MM-DD)
function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 같은 기기를 여러 사람이 써도 체크가 섞이지 않게 사용자별·날짜별로 저장한다
function storageKey() { return `safety-check:${userEmail}:${today}`; }

// records:start (test/app-records.test.js 가 이 구간만 떼어 실행한다)
// 예전 버전은 사용자 구분 없이 safety-check:YYYY-MM-DD 로 저장했다.
// 오늘 기록은 업데이트 직후 처음 로그인을 확인한 사람의 기록으로 옮겨(이미 있으면 합친다) 진행분을 지킨다.
// 지난 날짜 기록은 누구 것인지 알 수 없어 지운다.
function migrateUnattributedRecords(storage, email, day) {
  const OLD = /^safety-check:\d{4}-\d{2}-\d{2}$/;
  try {
    const old = storage.getItem(`safety-check:${day}`);
    if (old && email) {
      const key = `safety-check:${email}:${day}`;
      const merged = new Set([...JSON.parse(storage.getItem(key) || '[]'), ...JSON.parse(old)]);
      storage.setItem(key, JSON.stringify([...merged]));
    }
  } catch {
    // 옛 기록이 깨져 있으면 옮기지 않고 아래에서 지운다
  }
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
    for (const k of keys) if (OLD.test(k)) storage.removeItem(k);
  } catch {
    // 저장소를 못 쓰면 지울 것도 없다
  }
}
// records:end

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

// 요청 자체가 실패하면(오프라인·서버에 닿지 않음) null 을 돌려준다
async function getJson(path) {
  try {
    return await fetch(path, { headers: { Accept: 'application/json' } });
  } catch {
    return null;
  }
}

// 불러오는 중에 다시 불리면(예: 연결이 돌아옴) 새로 시작하지 않고 진행 중인 것을 기다린다
let loading = null;
function load() {
  loading ??= loadOnce().finally(() => { loading = null; });
  return loading;
}

async function loadOnce() {
  const state = document.getElementById('state');
  state.hidden = false;
  state.textContent = '점검 항목을 불러오는 중입니다…';

  // 사용자를 알아야 그 사람의 체크 기록을 열 수 있으므로 둘 다 받은 뒤 화면을 그린다
  const [me, list] = await Promise.all([getJson('/api/me'), getJson('/api/inspections')]);
  if (me?.status === 401 || list?.status === 401) return goLogin();
  try {
    if (!me?.ok || !list?.ok) throw new Error('load failed');
    userEmail = (await me.json()).email;
    items = (await list.json()).items;
    try { migrateUnattributedRecords(localStorage, userEmail, today); } catch { /* 저장소 사용 불가 */ }
    document.getElementById('who').textContent = userEmail;
    state.hidden = true;
    render();
  } catch {
    // 점검 항목(/api/)은 로그인한 사용자 데이터라 오프라인용으로 저장하지 않는다
    const text = me === null || list === null
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

// 로그아웃은 서버가 쿠키를 지웠다고 답한 뒤에만 로그인 화면으로 간다.
// 실패한 채 넘어가면 쿠키가 남아 다음 사람이 앞사람 계정으로 쓰게 된다.
document.getElementById('logout').addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  btn.disabled = true;
  let ok = false;
  try {
    const res = await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    location.replace('/login');
    return;
  }
  btn.disabled = false;
  alert('로그아웃하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.');
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
load();
