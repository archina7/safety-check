// 작업 허가서 저장소 (Cloudflare D1, 바인딩 이름 DB)
// 상태: 신청 → Agent 검토 → 관리자 확인 대기 → 승인 또는 반려
// - 상태를 바꾸는 함수는 이 파일에만 있다. '승인'·'반려'로 바꾸는 것은 decide() 하나뿐이고,
//   decide() 는 관리자 확인(isManager)을 통과한 결정 API(functions/api/permits/[id]/decision.js)만 부른다
// - Agent 검토 결과를 저장하는 saveReview() 는 상태를 '관리자 확인 대기'로만 바꾼다 (Agent 권고와 관계없이)
// - 모든 상태 변경은 'WHERE status = 이전 상태' 조건으로 한다 → 두 번 결정하거나 단계를 건너뛸 수 없다

export const STATUS = Object.freeze({
  APPLIED: '신청',
  REVIEWING: 'Agent 검토',
  WAITING: '관리자 확인 대기',
  APPROVED: '승인',
  REJECTED: '반려',
});
export const DECISIONS = [STATUS.APPROVED, STATUS.REJECTED];
// Agent 권고와 같은 결정: 승인 권고 ↔ 승인, 보완 요청 ↔ 반려. 다르면 사유를 받아 기록한다
export const MATCHING = { '승인 권고': STATUS.APPROVED, '보완 요청': STATUS.REJECTED };
export const MAX_REASON_CHARS = 1000;

// 관리자: MANAGER_EMAILS(쉼표 구분) 이면서 로그인 허용 목록(ALLOWED_EMAILS)에도 있는 사람
export function managerEmails(env) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set(list(env.ALLOWED_EMAILS));
  return new Set(list(env.MANAGER_EMAILS).filter((e) => allowed.has(e)));
}
export function isManager(env, email) {
  return typeof email === 'string' && managerEmails(env).has(email.toLowerCase());
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS permits (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, applicant TEXT NOT NULL,
    form_json TEXT NOT NULL, status TEXT NOT NULL, review_json TEXT, review_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS permit_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, permit_id TEXT NOT NULL, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL,
    recommendation TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL, mismatch INTEGER NOT NULL)`,
];

const ready = new WeakSet();
async function db(env) {
  const d = env.DB;
  if (!d) throw new Error('DB 바인딩 없음');
  if (!ready.has(d)) {
    for (const sql of SCHEMA) await d.prepare(sql).run();
    ready.add(d);
  }
  return d;
}

const now = () => new Date().toISOString();
const parse = (s) => (s ? JSON.parse(s) : null);
function toPermit(row) {
  if (!row) return null;
  return {
    id: row.id, type: row.type, title: row.title, applicant: row.applicant, status: row.status,
    form: parse(row.form_json), review: parse(row.review_json), review_error: row.review_error || null,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

// 상태를 from → to 로 바꾼다. 이전 상태가 맞을 때만 바뀐다 (바뀐 줄 수로 확인)
async function move(d, id, from, to, sets = {}) {
  const keys = Object.keys(sets);
  const assign = ['status = ?', 'updated_at = ?', ...keys.map((k) => `${k} = ?`)].join(', ');
  const fromList = [].concat(from);
  const res = await d.prepare(`UPDATE permits SET ${assign} WHERE id = ? AND status IN (${fromList.map(() => '?').join(', ')})`)
    .bind(to, now(), ...keys.map((k) => sets[k]), id, ...fromList).run();
  return (res.meta?.changes ?? 0) === 1;
}

export async function createPermit(env, form, applicant) {
  const d = await db(env);
  const id = `P-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const t = now();
  await d.prepare('INSERT INTO permits (id, type, title, applicant, form_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, form.type, form.title || '(작업명 없음)', applicant, JSON.stringify(form), STATUS.APPLIED, t, t).run();
  return id;
}

export async function startReview(env, id) {
  return move(await db(env), id, [STATUS.APPLIED, STATUS.REVIEWING], STATUS.REVIEWING, { review_error: null });
}

// Agent 검토 결과 저장: 다음 상태는 언제나 '관리자 확인 대기'
export async function saveReview(env, id, review) {
  return move(await db(env), id, STATUS.REVIEWING, STATUS.WAITING, { review_json: JSON.stringify(review), review_error: null });
}

// 검토가 실패하면 'Agent 검토'에 머문다 (다시 검토할 수 있다)
export async function saveReviewError(env, id, message) {
  return move(await db(env), id, STATUS.REVIEWING, STATUS.REVIEWING, { review_error: message });
}

// 관리자 결정. 결정 API 만 부른다. 'WHERE status = 관리자 확인 대기' 로 한 번만 결정된다
export async function decide(env, id, { decision, by, reason, recommendation }) {
  if (!DECISIONS.includes(decision)) throw new Error('결정은 승인 또는 반려');
  if (!isManager(env, by)) throw new Error('관리자만 결정할 수 있습니다');
  const d = await db(env);
  const ok = await move(d, id, STATUS.WAITING, decision);
  if (!ok) return null;
  const mismatch = MATCHING[recommendation] !== decision;
  const at = now();
  await d.prepare('INSERT INTO permit_decisions (permit_id, decided_by, decided_at, recommendation, decision, reason, mismatch) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, by, at, recommendation || null, decision, reason || '', mismatch ? 1 : 0).run();
  return { permit_id: id, decided_by: by, decided_at: at, recommendation, decision, reason: reason || '', mismatch };
}

export async function getPermit(env, id) {
  const d = await db(env);
  return toPermit(await d.prepare('SELECT * FROM permits WHERE id = ?').bind(id).first());
}

export async function listPermits(env, limit = 50) {
  const d = await db(env);
  const { results } = await d.prepare('SELECT * FROM permits ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return results.map(toPermit);
}

// 승인·반려 이력: 누가, 언제, Agent 권고, 최종 결정 (+ 다를 때 사유)
export async function listDecisions(env, limit = 100) {
  const d = await db(env);
  const { results } = await d.prepare(`SELECT h.*, p.title, p.type FROM permit_decisions h JOIN permits p ON p.id = h.permit_id ORDER BY h.decided_at DESC, h.id DESC LIMIT ?`).bind(limit).all();
  return results.map((r) => ({ permit_id: r.permit_id, title: r.title, type: r.type, decided_by: r.decided_by, decided_at: r.decided_at, recommendation: r.recommendation, decision: r.decision, reason: r.reason, mismatch: Boolean(r.mismatch) }));
}
