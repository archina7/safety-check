# safety-check — 현장 사무 DB MCP 서버

건설 현장의 **공종별 출역 인원**과 **장비 사용 예약**을 SQLite DB에서 조회하는 MCP 서버입니다.
Claude Code 같은 MCP 클라이언트에 연결하면 "판교 A현장 11월 24일 출역 인원 알려줘" 같은 질문을 도구 호출로 답할 수 있습니다.

## 파일 구성

| 파일 | 설명 |
|---|---|
| `office_mcp.py` | MCP 서버. `office.db`를 **읽기 전용**으로 열어 도구 2개를 제공 |
| `seed.py` | 예제 데이터로 `office.db`를 새로 만드는 스크립트 (기존 테이블은 삭제 후 재생성) |
| `.mcp.json` | Claude Code용 MCP 서버 설정 |

`office.db`는 저장소에 포함하지 않습니다(`.gitignore`). 아래 순서대로 직접 만드세요.

## 시작하기

MCP Python SDK **2.x** 가 필요합니다(`from mcp.server import MCPServer`). 1.x에서는 동작하지 않습니다.

```bash
python seed.py                                                     # office.db 생성
uv run --no-project --with "mcp>=2" python office_mcp.py           # stdio로 MCP 서버 실행
```

uv 없이 쓰려면 `pip install "mcp>=2"` 후 `python office_mcp.py`로 실행합니다.

## 제공 도구

### `site_workforce(site, date)`
현장 이름과 날짜(`YYYY-MM-DD`)로 공종별 출역 업체와 인원을 공종 순서로 돌려줍니다.

```json
[{"trade": "전기", "company": "전기 C사", "workers": 4},
 {"trade": "철근", "company": "철근 A사", "workers": 14},
 {"trade": "형틀", "company": "형틀 B사", "workers": 11}]
```

### `equipment_schedule(site, date)`
현장의 해당 날짜 장비 예약을 시작 시간 순서로 돌려줍니다.

```json
[{"equipment": "타워크레인 1호기", "start": "07:00", "end": "10:00", "company": "철근 A사"},
 {"equipment": "펌프카 52m", "start": "10:00", "end": "14:00", "company": "레미콘 D사"},
 {"equipment": "타워크레인 1호기", "start": "13:00", "end": "17:00", "company": "형틀 B사"}]
```

## DB 구조

```sql
CREATE TABLE workforce (site TEXT, date TEXT, trade TEXT, company TEXT, workers INTEGER);
CREATE TABLE bookings  (site TEXT, date TEXT, equipment TEXT, start TEXT, end TEXT, company TEXT);
```

예제 데이터: `판교 A현장`, `송도 B현장`의 `2026-11-24` 출역·장비 예약

## Claude Code 연결

이 폴더에서 Claude Code를 열면 `.mcp.json`에 등록된 서버 2개가 연결됩니다.

| 서버 | 실행 | 용도 |
|---|---|---|
| `office` | `uv run --no-project --with "mcp>=2" python office_mcp.py` | 이 저장소의 서버. 읽기 전용 조회 도구 2개 |
| `office-db` | `npx -y mcp-sqlite office.db` | 범용 SQLite 서버. 테이블 조회·SQL 실행에 더해 **레코드 추가·수정·삭제도 가능** |

| `office-remote` | `https://safety-check-mcp.archina7.workers.dev/mcp` | Cloudflare에 배포된 원격 서버. 도구는 `office`와 같음 |

`office-db`는 `office.db`를 직접 수정할 수 있으니, 조회만 필요하면 `office`를 쓰세요.
`uv`와 `npx`(Node.js)가 PATH에 있어야 합니다.

## Cloudflare 원격 서버 (`cloudflare/`)

`office_mcp.py`와 같은 도구 2개를 Cloudflare Workers에서 원격 MCP 서버(Streamable HTTP)로 제공합니다.

- 주소: `https://safety-check-mcp.archina7.workers.dev/mcp`
- DB: Cloudflare D1 `safety-check-office` (`cloudflare/seed.sql` = `seed.py`와 같은 데이터), 조회만 함
- 인증: `Authorization: Bearer <토큰>` 헤더가 없거나 틀리면 401

### 연결
`.mcp.json`의 `office-remote`는 토큰을 환경 변수 `SAFETY_CHECK_TOKEN`에서 읽습니다. 토큰은 저장소에 올리지 않습니다.

```powershell
[Environment]::SetEnvironmentVariable("SAFETY_CHECK_TOKEN", "<토큰>", "User")   # 설정 후 터미널 재시작
```

### 자동 배포

Cloudflare **Workers Builds**(Git 연동)로 `main`에 push하면 자동 배포됩니다. API 토큰은 쓰지 않습니다.
Cloudflare 대시보드 → Workers & Pages → `safety-check-mcp` → Settings → Builds 에 연결되어 있으며 설정은 다음과 같습니다.

| 항목 | 값 |
|---|---|
| Git 저장소 / 브랜치 | `archina7/safety-check` / `main` |
| Root directory | `cloudflare` |
| Build command | (비움) |
| Deploy command | `npx wrangler deploy` |
| Build watch paths | 포함 `cloudflare/*` |

D1 데이터 초기화(`seed.sql`)는 자동으로 하지 않습니다.

### 수동 배포·운영

```bash
cd cloudflare
npm install
npx wrangler types                                                   # 타입 생성
npx wrangler d1 execute safety-check-office --remote --file seed.sql # D1 데이터 초기화(기존 데이터 삭제)
npx wrangler deploy                                                  # 배포
npx wrangler secret put MCP_TOKEN                                    # 토큰 변경
```

로컬 테스트: `cloudflare/.dev.vars`에 `MCP_TOKEN=...`을 적고 `npx wrangler d1 execute safety-check-office --local --file seed.sql` 후 `npx wrangler dev`.

## 현장 안전점검 웹앱 (`public/`, `functions/`)

현장 안전관리자가 휴대폰으로 오늘 점검 항목 6개를 체크하는 Cloudflare Pages 앱입니다. 체크 상태는 브라우저에 날짜별로 저장됩니다.

```bash
npm install
npm run dev   # http://localhost:8788
npm test      # wrangler pages dev 를 띄워 API 허용·거부 확인
```

배포는 자동으로 하지 않습니다. `npm test` 통과 후 `npx wrangler pages deploy public --project-name safety-check --branch main`으로 직접 배포합니다 → https://safety-check-ezs.pages.dev . GitHub Actions(`.github/workflows/test.yml`)는 테스트만 돕니다.

Pages 환경 변수 `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `SESSION_SECRET`이 하나라도 없으면 사이트 전체가 "준비 중"(503)으로 막힙니다. 로컬은 `.dev.vars.example`을 `.dev.vars`로 복사해 채웁니다.
