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

```bash
pip install mcp        # MCP Python SDK
python seed.py         # office.db 생성
python office_mcp.py   # stdio로 MCP 서버 실행
```

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

현재 `.mcp.json`은 범용 SQLite MCP 서버(`npx -y mcp-sqlite`)를 `office-db`라는 이름으로 등록합니다.
이 저장소의 `office_mcp.py`를 쓰려면 아래처럼 등록하세요.

```json
{
  "mcpServers": {
    "office": {
      "type": "stdio",
      "command": "python",
      "args": ["office_mcp.py"]
    }
  }
}
```
