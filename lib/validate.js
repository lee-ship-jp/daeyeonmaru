/**
 * 주문 입력 검증 — Apps Script 서버 v2(apps-script/Code.gs)의 규칙을 그대로 이식.
 * Pages Functions(functions/api)와 테스트(tests/api.mjs)가 함께 사용한다.
 */

/* 번호·점유 규칙 — 키오스크·직원앱과 동일해야 한다 */
export const NUM_MIN = 1, NUM_MAX = 10;
export const BUSY_WINDOW_MS = 24 * 60 * 60 * 1000;   // completed가 아니어도 24시간 지나면 번호를 돌려준다

/* 입력 검증 한도 */
export const MAX_ITEMS = 50, MAX_NAME_LEN = 100, MAX_ID_LEN = 100, MAX_MONEY = 1e9, MAX_QTY = 1000;

export function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function validItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) return null;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== "object") return null;
    if (typeof it.name !== "string" || !it.name || it.name.length > MAX_NAME_LEN) return null;
    const price = intIn(it.price, 0, MAX_MONEY);
    const qty = intIn(it.qty, 0, MAX_QTY);
    if (price === null || qty === null) return null;
    out.push({
      itemId: it.itemId == null ? "i_" + i : String(it.itemId).slice(0, MAX_ID_LEN),
      name: it.name,
      price,
      temp: it.temp === "ice" || it.temp === "hot" ? it.temp : null,
      qty,
      status: it.status === "completed" ? "completed" : "pending",
    });
  }
  return out;
}

/* 주문 payload를 허용 키만 남겨 정규화한다. 형식이 틀리면 null */
export function validateOrder(p) {
  if (!p || typeof p !== "object") return null;
  const customerNumber = intIn(p.customerNumber, NUM_MIN, NUM_MAX);
  if (customerNumber === null) return null;
  const items = validItems(p.items);
  if (!items) return null;
  if (p.payMethod != null && p.payMethod !== "transfer" && p.payMethod !== "cash") return null;
  if (p.source != null && p.source !== "kiosk" && p.source !== "staff") return null;
  if (p.clientOrderId != null && (typeof p.clientOrderId !== "string" || !p.clientOrderId || p.clientOrderId.length > MAX_ID_LEN)) return null;
  const total = intIn(p.total, 0, MAX_MONEY);
  const t = new Date(p.timestamp).getTime();
  const order = {
    customerNumber,
    timestamp: isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(),
    items,
    total: total === null ? items.reduce((s, i) => s + i.price * i.qty, 0) : total,
    orderStatus: ["pending", "partial", "completed"].includes(p.orderStatus) ? p.orderStatus : "pending",
    payStatus: p.payStatus === "paid" ? "paid" : "unpaid",
  };
  if (p.clientOrderId != null) order.clientOrderId = p.clientOrderId;
  if (p.payMethod != null) order.payMethod = p.payMethod;
  if (p.source != null) order.source = p.source;
  return order;
}

/* update(PATCH) 허용 키 화이트리스트 — 프런트(index.html)가 실제로 쓰는 키만.
   허용 외 키나 형식이 틀린 값이 하나라도 있으면 null */
export function validateUpdateFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const clean = {};
  for (const k in fields) {
    if (k === "orderStatus") {
      if (!["pending", "partial", "completed"].includes(fields[k])) return null;
      clean[k] = fields[k];
    } else if (k === "payStatus") {
      if (fields[k] !== "paid" && fields[k] !== "unpaid") return null;
      clean[k] = fields[k];
    } else if (k === "items") {
      const items = validItems(fields[k]);
      if (!items) return null;
      clean[k] = items;
    } else if (k === "total") {
      const total = intIn(fields[k], 0, MAX_MONEY);
      if (total === null) return null;
      clean[k] = total;
    } else {
      return null;
    }
  }
  return clean;
}
