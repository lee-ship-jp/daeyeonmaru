-- 대연마루 주문 DB 초기 스키마 (D1 / SQLite)
-- json 컬럼에 주문 객체 전체(items 포함)를 보관하고,
-- 조회·집계에 쓰는 컬럼(번호·금액·상태·시각)은 저장할 때마다 동기화한다.

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  client_order_id TEXT UNIQUE,
  customer_number INTEGER,
  source          TEXT,
  pay_method      TEXT,
  pay_status      TEXT,
  order_status    TEXT,
  total           INTEGER,
  created_at      TEXT,
  updated_at      TEXT,
  deleted         INTEGER DEFAULT 0,
  deleted_at      TEXT,
  json            TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_deleted_created ON orders (deleted, created_at);

-- 활성 주문의 번호 점유 (1~10 공용 번호대의 중복 방지)
-- 주문 생성 시 INSERT(PK 충돌 = number_busy), 완료·삭제 시 DELETE.
-- since가 24시간 지난 점유는 다음 주문 생성 시 정리한다.
CREATE TABLE IF NOT EXISTS active_numbers (
  number   INTEGER PRIMARY KEY,
  order_id TEXT,
  since    TEXT
);

-- 감사 로그 — 추가/수정/삭제/복구를 남겨 실수를 추적·복구할 수 있게 한다
CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT,
  action   TEXT,
  order_id TEXT,
  summary  TEXT
);
