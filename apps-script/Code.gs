/**
 * 대연마루 카페 — Google Apps Script backend (v2)
 * ------------------------------------------------------------------
 * Stores every order as one row in the bound Google Sheet (tab "Orders"):
 *     Column A: id          Column B: json (the full order object)
 * Every add/update/delete/restore is appended to tab "AuditLog"
 * (time · action · id · summary) so mistakes can be traced and undone.
 *
 * The web app exposes (every response carries  version: 2):
 *     GET  ?action=list                 → { ok, version, orders: [...] }   (deleted 제외)
 *     GET  ?action=list&deleted=1       → 삭제된 주문 포함 (복구 확인용)
 *     POST { action:"addOrder", payload:<order> }
 *            → { ok, id, number }                        번호가 비어 있으면 그 번호로 확정
 *            → { ok:false, error:"number_busy", busy:[...] }   희망 번호가 사용 중
 *            → { ok:false, error:"all_busy",   busy:[...] }    1~10 전부 사용 중
 *            → { ok:false, error:"invalid" }                    payload 검증 실패
 *     POST { action:"add",     payload:<order> }        → { ok, id }   (구버전 호환 — 번호 확인 없음)
 *       · add/addOrder 공통: 같은 clientOrderId가 이미 있으면 새로 만들지 않고
 *         { ok, id, duplicate:true, number } 를 돌려준다 (재시도 멱등)
 *     POST { action:"update",  payload:{ id, fields } } → { ok }   (fields는 화이트리스트만)
 *     POST { action:"delete",  payload:{ id } }         → { ok }   (행 삭제 대신 deleted 표시)
 *     POST { action:"restore", payload:{ id } }         → { ok }   (삭제 취소)
 *     POST { action:"clear" }                           → { ok:false, error:"disabled" }
 *
 * DEPLOY (one time):
 *   1. Open your Google Sheet ▸ Extensions ▸ Apps Script.
 *   2. Delete any sample code, paste THIS file, Save.
 *   3. Deploy ▸ New deployment ▸ type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Deploy ▸ authorize ▸ copy the "/exec" URL.
 *   4. Paste that URL into index.html  →  const APPS_SCRIPT_URL = "...";
 *
 * After changing this script, redeploy with: Deploy ▸ Manage deployments
 *   ▸ (edit) ▸ Version: New version ▸ Deploy   (keeps the same URL).
 */

const SERVER_VERSION = 2;
const SHEET_NAME  = 'Orders';
const AUDIT_SHEET = 'AuditLog';

/* 번호·점유 규칙 — 키오스크·직원앱과 동일해야 한다 */
const NUM_MIN = 1, NUM_MAX = 10;
const BUSY_WINDOW_MS = 24 * 60 * 60 * 1000;   // completed가 아니어도 24시간 지나면 번호를 돌려준다

/* 입력 검증 한도 */
const MAX_ITEMS = 50, MAX_NAME_LEN = 100, MAX_ID_LEN = 100, MAX_MONEY = 1e9, MAX_QTY = 1000;

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, 2).setValues([['id', 'json']]);
  }
  return sh;
}

/* 감사 로그 — 실패해도 본 작업을 막지 않는다 */
function audit_(action, id, summary) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(AUDIT_SHEET);
    if (!sh) {
      sh = ss.insertSheet(AUDIT_SHEET);
      sh.getRange(1, 1, 1, 4).setValues([['time', 'action', 'id', 'summary']]);
    }
    sh.appendRow([new Date().toISOString(), action, id || '', String(summary || '').slice(0, 300)]);
  } catch (e) { /* 로그 실패는 무시 */ }
}

/* Orders 탭 전체를 { row, id, order } 로 읽는다 (파싱 불가 행은 건너뜀) */
function rows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, 2).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const id = vals[i][0];
    if (!id) continue;
    try { out.push({ row: i + 2, id: id, order: JSON.parse(vals[i][1]) }); } catch (e) { /* skip bad row */ }
  }
  return out;
}

function json_(obj) {
  const body = Object.assign({ version: SERVER_VERSION }, obj);
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ── 입력 검증 ───────────────────────────────────────────── */
function intIn_(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function validItems_(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) return null;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') return null;
    if (typeof it.name !== 'string' || !it.name || it.name.length > MAX_NAME_LEN) return null;
    const price = intIn_(it.price, 0, MAX_MONEY);
    const qty = intIn_(it.qty, 0, MAX_QTY);
    if (price === null || qty === null) return null;
    out.push({
      itemId: it.itemId == null ? 'i_' + i : String(it.itemId).slice(0, MAX_ID_LEN),
      name: it.name,
      price: price,
      temp: it.temp === 'ice' || it.temp === 'hot' ? it.temp : null,
      qty: qty,
      status: it.status === 'completed' ? 'completed' : 'pending',
    });
  }
  return out;
}

/* 주문 payload를 허용 키만 남겨 정규화한다. 형식이 틀리면 null */
function validateOrder_(p) {
  if (!p || typeof p !== 'object') return null;
  const customerNumber = intIn_(p.customerNumber, NUM_MIN, NUM_MAX);
  if (customerNumber === null) return null;
  const items = validItems_(p.items);
  if (!items) return null;
  if (p.payMethod != null && p.payMethod !== 'transfer' && p.payMethod !== 'cash') return null;
  if (p.source != null && p.source !== 'kiosk' && p.source !== 'staff') return null;
  if (p.clientOrderId != null && (typeof p.clientOrderId !== 'string' || !p.clientOrderId || p.clientOrderId.length > MAX_ID_LEN)) return null;
  const total = intIn_(p.total, 0, MAX_MONEY);
  const t = new Date(p.timestamp).getTime();
  const order = {
    customerNumber: customerNumber,
    timestamp: isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(),
    items: items,
    total: total === null ? items.reduce(function (s, i) { return s + i.price * i.qty; }, 0) : total,
    orderStatus: ['pending', 'partial', 'completed'].indexOf(p.orderStatus) >= 0 ? p.orderStatus : 'pending',
    payStatus: p.payStatus === 'paid' ? 'paid' : 'unpaid',
  };
  if (p.clientOrderId != null) order.clientOrderId = p.clientOrderId;
  if (p.payMethod != null) order.payMethod = p.payMethod;
  if (p.source != null) order.source = p.source;
  return order;
}

/* ── 번호 점유 (프런트 busyNumbers와 같은 기준) ───────────── */
function busyNumbers_(orders, now) {
  const seen = {}, busy = [];
  orders.forEach(function (o) {
    if (!o || o.deleted) return;
    if (o.orderStatus === 'completed') return;
    const t = new Date(o.timestamp || o.createdAt).getTime();
    if (!isFinite(t) || now - t > BUSY_WINDOW_MS) return;
    const n = Number(o.customerNumber);
    if (n >= NUM_MIN && n <= NUM_MAX && !seen[n]) { seen[n] = true; busy.push(n); }
  });
  return busy.sort(function (a, b) { return a - b; });
}

/* ── GET: 목록 (기본은 deleted 제외) ─────────────────────── */
function doGet(e) {
  const withDeleted = !!(e && e.parameter && e.parameter.deleted === '1');
  const orders = rows_(sheet_()).map(function (r) { return r.order; });
  return json_({ ok: true, orders: withDeleted ? orders : orders.filter(function (o) { return !o.deleted; }) });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = req.action;
    const sh = sheet_();

    /* add(구버전 호환)·addOrder(번호 서버 확정) — 둘 다 검증 + clientOrderId 멱등 */
    if (action === 'add' || action === 'addOrder') {
      const order = validateOrder_(req.payload);
      if (!order) return json_({ ok: false, error: 'invalid' });
      const rows = rows_(sh);
      if (order.clientOrderId) {
        for (let i = 0; i < rows.length; i++) {
          const o = rows[i].order;
          if (o && o.clientOrderId === order.clientOrderId) {
            return json_({ ok: true, id: o.id, duplicate: true, number: Number(o.customerNumber) });
          }
        }
      }
      if (action === 'addOrder') {
        const busy = busyNumbers_(rows.map(function (r) { return r.order; }), Date.now());
        if (busy.length >= NUM_MAX - NUM_MIN + 1) return json_({ ok: false, error: 'all_busy', busy: busy });
        if (busy.indexOf(order.customerNumber) >= 0) return json_({ ok: false, error: 'number_busy', busy: busy });
      }
      order.id = 'order_' + new Date().getTime() + '_' + Math.floor(Math.random() * 10000);
      order.createdAt = new Date().toISOString();
      sh.appendRow([order.id, JSON.stringify(order)]);
      audit_(action, order.id,
        '#' + order.customerNumber + ' 합계 ' + order.total + '원 · ' + order.items.length + '줄' +
        (order.source ? ' · ' + order.source : ''));
      return json_({ ok: true, id: order.id, number: order.customerNumber });
    }

    if (action === 'update') {
      const p = req.payload || {};
      const id = p.id, fields = p.fields;
      if (!id || !fields || typeof fields !== 'object') return json_({ ok: false, error: 'invalid' });
      /* 프런트(index.html)가 실제로 쓰는 키만 허용한다 */
      const clean = {};
      for (const k in fields) {
        if (k === 'orderStatus') {
          if (['pending', 'partial', 'completed'].indexOf(fields[k]) < 0) return json_({ ok: false, error: 'invalid' });
          clean[k] = fields[k];
        } else if (k === 'payStatus') {
          if (fields[k] !== 'paid' && fields[k] !== 'unpaid') return json_({ ok: false, error: 'invalid' });
          clean[k] = fields[k];
        } else if (k === 'items') {
          const items = validItems_(fields[k]);
          if (!items) return json_({ ok: false, error: 'invalid' });
          clean[k] = items;
        } else if (k === 'total') {
          const total = intIn_(fields[k], 0, MAX_MONEY);
          if (total === null) return json_({ ok: false, error: 'invalid' });
          clean[k] = total;
        } else {
          return json_({ ok: false, error: 'invalid' });
        }
      }
      const rows = rows_(sh);
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === id && !rows[i].order.deleted) {
          const order = rows[i].order;
          for (const k in clean) order[k] = clean[k];
          sh.getRange(rows[i].row, 2).setValue(JSON.stringify(order));
          audit_('update', id, Object.keys(clean).join(','));
          return json_({ ok: true });
        }
      }
      return json_({ ok: false, error: 'order not found' });
    }

    /* 행을 지우지 않고 deleted 표시만 — restore로 복구할 수 있다 */
    if (action === 'delete') {
      const id = (req.payload || {}).id;
      const rows = rows_(sh);
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === id && !rows[i].order.deleted) {
          const order = rows[i].order;
          order.deleted = true;
          order.deletedAt = new Date().toISOString();
          sh.getRange(rows[i].row, 2).setValue(JSON.stringify(order));
          audit_('delete', id, '#' + order.customerNumber + ' 합계 ' + (order.total || 0) + '원');
          return json_({ ok: true });
        }
      }
      return json_({ ok: false, error: 'order not found' });
    }

    if (action === 'restore') {
      const id = (req.payload || {}).id;
      const rows = rows_(sh);
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === id && rows[i].order.deleted) {
          const order = rows[i].order;
          delete order.deleted;
          delete order.deletedAt;
          sh.getRange(rows[i].row, 2).setValue(JSON.stringify(order));
          audit_('restore', id, '#' + order.customerNumber);
          return json_({ ok: true });
        }
      }
      return json_({ ok: false, error: 'order not found' });
    }

    /* 전체 삭제는 인증이 없는 이상 피해가 너무 커서 제공하지 않는다 */
    if (action === 'clear') {
      return json_({ ok: false, error: 'disabled' });
    }

    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
