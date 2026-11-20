-- ../seed.py와 같은 데이터 (D1용)
DROP TABLE IF EXISTS workforce;
DROP TABLE IF EXISTS bookings;
CREATE TABLE workforce (site TEXT, date TEXT, trade TEXT, company TEXT, workers INTEGER);
CREATE TABLE bookings (site TEXT, date TEXT, equipment TEXT, start TEXT, "end" TEXT, company TEXT);
INSERT INTO workforce VALUES
 ('판교 A현장','2026-11-24','철근','철근 A사',14),
 ('판교 A현장','2026-11-24','형틀','형틀 B사',11),
 ('판교 A현장','2026-11-24','전기','전기 C사',4),
 ('송도 B현장','2026-11-24','철근','철근 A사',9);
INSERT INTO bookings VALUES
 ('판교 A현장','2026-11-24','타워크레인 1호기','07:00','10:00','철근 A사'),
 ('판교 A현장','2026-11-24','펌프카 52m','10:00','14:00','레미콘 D사'),
 ('판교 A현장','2026-11-24','타워크레인 1호기','13:00','17:00','형틀 B사'),
 ('송도 B현장','2026-11-24','고소작업차','08:00','12:00','전기 C사');
