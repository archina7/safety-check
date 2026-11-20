import sqlite3
from pathlib import Path
from mcp.server import MCPServer

DB = Path(__file__).with_name("office.db")
app = MCPServer("office")

def rows(sql: str, *args) -> list[dict]:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)  # 읽기 전용
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, args)]
    finally:
        con.close()

@app.tool()
def site_workforce(site: str, date: str) -> list[dict]:
    """현장 이름과 YYYY-MM-DD 날짜로 공종별 출역 업체와 인원을 찾는다."""
    return rows("SELECT trade, company, workers FROM workforce "
                "WHERE site = ? AND date = ? ORDER BY trade", site, date)

@app.tool()
def equipment_schedule(site: str, date: str) -> list[dict]:
    """현장의 YYYY-MM-DD 날짜 장비 사용 예약을 시작 시간 순서로 돌려준다."""
    return rows("SELECT equipment, start, end, company FROM bookings "
                "WHERE site = ? AND date = ? ORDER BY start", site, date)

if __name__ == "__main__":
    app.run()                                    # 기본 stdio 전송
