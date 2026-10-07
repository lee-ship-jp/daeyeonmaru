/**
 * 대연마루 주문 API — Cloudflare Pages Functions + D1 (서버 v3)
 * ------------------------------------------------------------------
 * Apps Script 서버 v2(apps-script/Code.gs)와 같은 의미의 REST API.
 * 주문 전체 객체는 orders.json 컬럼에 보관하고 조회 컬럼을 동기화한다.
 *
 *   GET    /api/health                → { ok, version }
 *   GET    /api/orders                → { ok, version:3, orders:[...] }  (deleted 제외, 기본 최근 60일)
 *          ?since=<ISO>               → created_at ≥ since 만
 *          ?all=1                     → 전체 (매출·PDF용)
 *   POST   /api/orders                → 주문 생성(번호 서버 확정)
 *          { ok, id, number } / number_busy(busy) / all_busy / invalid
 *          같은 clientOrderId 재시도 → { ok, id, duplicate:true, number } (멱등)
 *   PATCH  /api/orders/:id            → { fields } 화이트리스트만 수정, completed 되면 번호 해제
 *   DELETE /api/orders/:id            → soft delete + 번호 해제
 *   POST   /api/orders/:id/restore    → 삭제 취소
 *
 * 전체 삭제 API는 제공하지 않는다(인증이 없는 이상 피해가 너무 크다).
 * 쓰기 요청은 같은 출처(Origin 일치) 또는 Origin 없음(curl 등)만 허용한다.
 * 도메인 오류(invalid·number_busy 등)는 HTTP 200 + ok:false 로 돌려준다
 * — 프런트가 본문 코드로 분기하기 때문. HTTP 오류는 출처 거부(403)·미지원 경로(404)뿐.
 */
import {
  validateOrder, validateUpdateFields,
  NUM_MIN, NUM_MAX, BUSY_WINDOW_MS,
} from "../../lib/validate.js";

const SERVER_VERSION = 3;
const LIST_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;   // 목록 기본 범위: 최근 60일

const json = (obj, status = 200) =>
  new Response(JSON.stringify({ version: SERVER_VERSION, ...obj }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/* 쓰기 허용 출처: 같은 출처이거나 Origin 헤더가 없는 요청만 */
function originAllowed(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

/* 감사 로그 INSERT 문 — 실패해도 본 작업을 막지 않도록 batch에 함께 넣는다 */
function auditStmt(DB, at, action, orderId, summary) {
  return DB.prepare("INSERT INTO audit_log (at, action, order_id, summary) VALUES (?1, ?2, ?3, ?4)")
    .bind(at, action, orderId || "", String(summary || "").slice(0, 300));
}

async function busyList(DB) {
  const { results } = await DB.prepare("SELECT number FROM active_numbers ORDER BY number").all();
  return results.map(r => Number(r.number));
}

/* ── GET /api/orders ───────────────────────────────────────── */
async function listOrders(DB, url) {
  let sql = "SELECT json FROM orders WHERE deleted = 0";
  const binds = [];
  if (url.searchParams.get("all") !== "1") {
    const since = Date.parse(url.searchParams.get("since") || "");
    const cutoff = Number.isFinite(since) ? since : Date.now() - LIST_WINDOW_MS;
    sql += " AND created_at >= ?1";
    binds.push(new Date(cutoff).toISOString());
  }
  sql += " ORDER BY created_at";
  const { results } = await DB.prepare(sql).bind(...binds).all();
  const orders = [];
  for (const r of results) {
    try { orders.push(JSON.parse(r.json)); } catch (e) { /* 깨진 행은 건너뜀 */ }
  }
  return json({ ok: true, orders });
}

/* ── POST /api/orders (addOrder) ───────────────────────────── */
async function addOrder(DB, request) {
  const payload = await request.json().catch(() => null);
  const order = validateOrder(payload);
  if (!order) return json({ ok: false, error: "invalid" });

  /* clientOrderId 멱등 — 이미 접수된 주문이면 새로 만들지 않는다 */
  const findDup = () => DB.prepare("SELECT id, customer_number FROM orders WHERE client_order_id = ?1")
    .bind(order.clientOrderId).first();
  if (order.clientOrderId) {
    const dup = await findDup();
    if (dup) return json({ ok: true, id: dup.id, duplicate: true, number: Number(dup.customer_number) });
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  /* 24시간 지난 점유 정리 → 현재 사용 중 번호 확인 */
  await DB.prepare("DELETE FROM active_numbers WHERE since < ?1")
    .bind(new Date(now - BUSY_WINDOW_MS).toISOString()).run();
  const busy = await busyList(DB);
  if (busy.length >= NUM_MAX - NUM_MIN + 1) return json({ ok: false, error: "all_busy", busy });
  if (busy.includes(order.customerNumber))  return json({ ok: false, error: "number_busy", busy });

  order.id = "order_" + now + "_" + Math.floor(Math.random() * 10000);
  order.createdAt = nowIso;
  const summary = "#" + order.customerNumber + " 합계 " + order.total + "원 · " +
    order.items.length + "줄" + (order.source ? " · " + order.source : "");

  try {
    /* 번호 점유 + 주문 + 감사 로그를 한 번에(원자적) — 점유 PK 충돌이면 전체 롤백 */
    await DB.batch([
      DB.prepare("INSERT INTO active_numbers (number, order_id, since) VALUES (?1, ?2, ?3)")
        .bind(order.customerNumber, order.id, nowIso),
      DB.prepare(
        "INSERT INTO orders (id, client_order_id, customer_number, source, pay_method, pay_status, " +
        " order_status, total, created_at, updated_at, deleted, json) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)"
      ).bind(order.id, order.clientOrderId ?? null, order.customerNumber, order.source ?? null,
             order.payMethod ?? null, order.payStatus, order.orderStatus, order.total,
             nowIso, nowIso, JSON.stringify(order)),
      auditStmt(DB, nowIso, "addOrder", order.id, summary),
    ]);
  } catch (e) {
    /* 동시 생성 경쟁에서 진 경우 — clientOrderId 중복이면 멱등 응답, 아니면 번호 충돌 */
    if (order.clientOrderId) {
      const dup = await findDup();
      if (dup) return json({ ok: true, id: dup.id, duplicate: true, number: Number(dup.customer_number) });
    }
    return json({ ok: false, error: "number_busy", busy: await busyList(DB) });
  }
  return json({ ok: true, id: order.id, number: order.customerNumber });
}

/* ── PATCH /api/orders/:id ─────────────────────────────────── */
async function updateOrder(DB, request, id) {
  const body = await request.json().catch(() => null);
  const clean = body && validateUpdateFields(body.fields);
  if (!id || !clean) return json({ ok: false, error: "invalid" });

  const row = await DB.prepare("SELECT json, created_at FROM orders WHERE id = ?1 AND deleted = 0").bind(id).first();
  if (!row) return json({ ok: false, error: "order not found" });

  let order;
  try { order = JSON.parse(row.json); } catch (e) { return json({ ok: false, error: "order not found" }); }
  Object.assign(order, clean);
  const nowIso = new Date().toISOString();

  const stmts = [
    DB.prepare(
      "UPDATE orders SET json = ?1, order_status = ?2, pay_status = ?3, total = ?4, updated_at = ?5 WHERE id = ?6"
    ).bind(JSON.stringify(order), order.orderStatus, order.payStatus ?? null, order.total, nowIso, id),
    auditStmt(DB, nowIso, "update", id, Object.keys(clean).join(",")),
  ];
  if (clean.orderStatus === "completed") {
    /* 완료되면 번호 반납 */
    stmts.push(DB.prepare("DELETE FROM active_numbers WHERE order_id = ?1").bind(id));
  } else if (clean.orderStatus) {
    /* 완료 취소(pending/partial 복귀) — 생성 24시간 이내면 번호를 다시 점유해 둔다 */
    if (Date.now() - Date.parse(row.created_at) <= BUSY_WINDOW_MS) {
      stmts.push(DB.prepare("INSERT OR IGNORE INTO active_numbers (number, order_id, since) VALUES (?1, ?2, ?3)")
        .bind(Number(order.customerNumber), id, row.created_at));
    }
  }
  await DB.batch(stmts);
  return json({ ok: true });
}

/* ── DELETE /api/orders/:id (soft delete) ──────────────────── */
async function deleteOrder(DB, id) {
  const row = await DB.prepare("SELECT json FROM orders WHERE id = ?1 AND deleted = 0").bind(id).first();
  if (!row) return json({ ok: false, error: "order not found" });
  let order;
  try { order = JSON.parse(row.json); } catch (e) { order = {}; }
  const nowIso = new Date().toISOString();
  order.deleted = true;
  order.deletedAt = nowIso;
  await DB.batch([
    DB.prepare("UPDATE orders SET json = ?1, deleted = 1, deleted_at = ?2, updated_at = ?2 WHERE id = ?3")
      .bind(JSON.stringify(order), nowIso, id),
    DB.prepare("DELETE FROM active_numbers WHERE order_id = ?1").bind(id),
    auditStmt(DB, nowIso, "delete", id, "#" + order.customerNumber + " 합계 " + (order.total || 0) + "원"),
  ]);
  return json({ ok: true });
}

/* ── POST /api/orders/:id/restore ──────────────────────────── */
async function restoreOrder(DB, id) {
  const row = await DB.prepare("SELECT json, created_at FROM orders WHERE id = ?1 AND deleted = 1").bind(id).first();
  if (!row) return json({ ok: false, error: "order not found" });
  let order;
  try { order = JSON.parse(row.json); } catch (e) { return json({ ok: false, error: "order not found" }); }
  delete order.deleted;
  delete order.deletedAt;
  const nowIso = new Date().toISOString();
  const stmts = [
    DB.prepare("UPDATE orders SET json = ?1, deleted = 0, deleted_at = NULL, updated_at = ?2 WHERE id = ?3")
      .bind(JSON.stringify(order), nowIso, id),
    auditStmt(DB, nowIso, "restore", id, "#" + order.customerNumber),
  ];
  /* 아직 활성 범위(미완료·24시간 이내)면 번호 점유도 복구 — 이미 다른 주문이 쓰면 그대로 둔다 */
  if (order.orderStatus !== "completed" && Date.now() - Date.parse(row.created_at) <= BUSY_WINDOW_MS) {
    stmts.push(DB.prepare("INSERT OR IGNORE INTO active_numbers (number, order_id, since) VALUES (?1, ?2, ?3)")
      .bind(Number(order.customerNumber), id, row.created_at));
  }
  await DB.batch(stmts);
  return json({ ok: true });
}

export async function onRequest(context) {
  const { request, env } = context;
  const DB = env.DB;
  const url = new URL(request.url);
  const route = Array.isArray(context.params.route) ? context.params.route : [];
  const method = request.method.toUpperCase();

  try {
    if (route[0] === "health" && route.length === 1 && method === "GET") {
      return json({ ok: true });
    }

    if (route[0] === "orders") {
      if (route.length === 1 && method === "GET") return listOrders(DB, url);

      /* 이하 전부 쓰기 — 같은 출처(또는 Origin 없음)만 */
      if (!originAllowed(request)) return json({ ok: false, error: "forbidden" }, 403);

      if (route.length === 1 && method === "POST")   return addOrder(DB, request);
      if (route.length === 2 && method === "PATCH")  return updateOrder(DB, request, route[1]);
      if (route.length === 2 && method === "DELETE") return deleteOrder(DB, route[1]);
      if (route.length === 3 && route[2] === "restore" && method === "POST") return restoreOrder(DB, route[1]);
    }

    return json({ ok: false, error: "not_found" }, 404);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}
