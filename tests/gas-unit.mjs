/* Apps Script 백엔드(Code.gs) 단위 테스트 — Node vm에서 SpreadsheetApp/LockService/ContentService를
   목(mock)으로 바꿔 로드한다. 실제 구글 시트·배포 URL에는 아무 요청도 보내지 않는다.
   실행: node tests/gas-unit.mjs */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = fs.readFileSync(path.join(root, "apps-script", "Code.gs"), "utf8");
const codeJs = fs.readFileSync(path.join(root, "gas-src", "Code.js"), "utf8");

/* ── 구글 시트 목 ── */
class MockSheet {
  constructor(name) { this.name = name; this.data = []; }
  getLastRow() { return this.data.length; }
  ensure(row, col) {
    while (this.data.length < row) this.data.push([]);
    const r = this.data[row - 1];
    while (r.length < col) r.push("");
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const src = sheet.data[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(src[col - 1 + c] !== undefined ? src[col - 1 + c] : "");
          out.push(line);
        }
        return out;
      },
      setValues(vals) {
        for (let r = 0; r < vals.length; r++) {
          sheet.ensure(row + r, col + vals[r].length - 1);
          for (let c = 0; c < vals[r].length; c++) sheet.data[row - 1 + r][col - 1 + c] = vals[r][c];
        }
      },
      getValue() { return (sheet.data[row - 1] || [])[col - 1]; },
      setValue(v) { sheet.ensure(row, col); sheet.data[row - 1][col - 1] = v; },
    };
  }
  appendRow(arr) { this.data.push(arr.slice()); }
}

/* Code.gs를 새 샌드박스에 로드해 doGet/doPost 호출기를 돌려준다 */
function makeEnv() {
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new MockSheet(n)),
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: s => ({ _s: s, setMimeType() { return this; } }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: "Code.gs" });
  return {
    sheets,
    post: req => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(req) } })._s),
    get: params => JSON.parse(ctx.doGet({ parameter: params || {} })._s),
  };
}

const mkOrder = (over = {}) => ({
  clientOrderId: "c_" + Math.random().toString(36).slice(2),
  customerNumber: 1,
  timestamp: new Date().toISOString(),
  items: [{ itemId: "i1", name: "아메리카노", price: 2500, temp: "ice", qty: 1, status: "pending" }],
  total: 2500, orderStatus: "pending", source: "kiosk", payMethod: "transfer", payStatus: "unpaid",
  ...over,
});

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("Code.gs 단위 테스트 (목 기반)");

/* 0 · 배포 사본 동기화 */
check("apps-script/Code.gs와 gas-src/Code.js가 동일", code === codeJs);

/* 1 · addOrder: 빈 번호면 그 번호로 확정 + AuditLog 기록 + version:2 */
{
  const env = makeEnv();
  const r = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "cid_1" }) });
  check("addOrder 성공(ok·id·number=1)", r.ok === true && /^order_/.test(r.id) && r.number === 1, JSON.stringify(r));
  check("응답에 version:2", r.version === 2);
  check("Orders 시트에 1행 저장", env.sheets.Orders.data.length === 2);
  const log = env.sheets.AuditLog;
  check("AuditLog에 addOrder 기록", !!log && log.data.length === 2 && log.data[1][1] === "addOrder", log && JSON.stringify(log.data));

  /* 2 · 같은 번호는 number_busy + busy 목록 */
  const busy = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "cid_2" }) });
  check("사용 중 번호는 number_busy", busy.ok === false && busy.error === "number_busy", JSON.stringify(busy));
  check("busy 목록에 1 포함·version 포함", Array.isArray(busy.busy) && busy.busy.includes(1) && busy.version === 2);

  /* 3 · 멱등: 같은 clientOrderId는 기존 주문 반환(새 행 없음) */
  const dup = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "cid_1" }) });
  check("addOrder 멱등(duplicate·같은 id·번호)", dup.ok === true && dup.duplicate === true && dup.id === r.id && dup.number === 1, JSON.stringify(dup));
  check("멱등 재시도에 행이 늘지 않음", env.sheets.Orders.data.length === 2);
  const dupAdd = env.post({ action: "add", payload: mkOrder({ clientOrderId: "cid_1" }) });
  check("구버전 add도 같은 clientOrderId면 멱등", dupAdd.ok === true && dupAdd.duplicate === true && dupAdd.id === r.id);

  /* 4 · 구버전 add는 번호 확인 없이 저장(하위호환 — 클라이언트가 재확인) */
  const legacy = env.post({ action: "add", payload: mkOrder({ clientOrderId: "cid_3" }) });
  check("add는 사용 중 번호여도 저장(하위호환)", legacy.ok === true && /^order_/.test(legacy.id), JSON.stringify(legacy));

  /* 5 · clear는 비활성 */
  const rows = env.sheets.Orders.data.length;
  const cleared = env.post({ action: "clear" });
  check("clear는 disabled 오류", cleared.ok === false && cleared.error === "disabled", JSON.stringify(cleared));
  check("clear 후에도 행 유지", env.sheets.Orders.data.length === rows);

  /* 6 · soft delete: 행은 남고 list에서 빠지며 번호가 풀린다 */
  const del = env.post({ action: "delete", payload: { id: r.id } });
  check("delete 성공", del.ok === true, JSON.stringify(del));
  check("delete 후에도 시트 행 유지(soft delete)", env.sheets.Orders.data.length === rows);
  const list = env.get();
  check("list(doGet)가 삭제 주문 제외 + version:2", list.ok === true && list.version === 2 && !list.orders.some(o => o.id === r.id), JSON.stringify(list.orders.map(o => o.id)));
  const withDel = env.get({ deleted: "1" });
  const delRow = withDel.orders.find(o => o.id === r.id);
  check("deleted=1이면 deleted·deletedAt 표시로 포함", !!delRow && delRow.deleted === true && !!delRow.deletedAt);
  check("AuditLog에 delete 기록", env.sheets.AuditLog.data.some(row => row[1] === "delete" && row[2] === r.id));

  /* 7 · restore로 복구 */
  const rest = env.post({ action: "restore", payload: { id: r.id } });
  check("restore 성공", rest.ok === true, JSON.stringify(rest));
  const after = env.get();
  const restored = after.orders.find(o => o.id === r.id);
  check("restore 후 list에 복귀·deleted 플래그 제거", !!restored && !restored.deleted && !restored.deletedAt);
  const rest2 = env.post({ action: "restore", payload: { id: r.id } });
  check("삭제 상태가 아니면 restore는 not found", rest2.ok === false);
}

/* 8 · 번호 점유 규칙: 삭제·완료·24시간 경과 주문은 번호를 풀어준다 */
{
  const env = makeEnv();
  env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "a", customerNumber: 5 }) });
  const list = env.get();
  const id5 = list.orders[0].id;
  env.post({ action: "delete", payload: { id: id5 } });
  const r = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "b", customerNumber: 5 }) });
  check("삭제된 주문의 번호는 재사용 가능", r.ok === true && r.number === 5, JSON.stringify(r));

  env.post({ action: "add", payload: mkOrder({ clientOrderId: "c", customerNumber: 6, orderStatus: "completed" }) });
  const r6 = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "d", customerNumber: 6 }) });
  check("completed 주문의 번호는 재사용 가능", r6.ok === true && r6.number === 6, JSON.stringify(r6));
}
{
  const env = makeEnv();
  const H = 3600e3;
  env.post({ action: "add", payload: mkOrder({ clientOrderId: "old", customerNumber: 7, timestamp: new Date(Date.now() - 25 * H).toISOString() }) });
  const free = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "new1", customerNumber: 7 }) });
  check("24시간 경계: 25시간 전 미완료 주문은 점유 해제", free.ok === true, JSON.stringify(free));

  const env2 = makeEnv();
  env2.post({ action: "add", payload: mkOrder({ clientOrderId: "old", customerNumber: 7, timestamp: new Date(Date.now() - 23 * H).toISOString() }) });
  const held = env2.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "new1", customerNumber: 7 }) });
  check("24시간 경계: 23시간 전 미완료 주문은 아직 점유", held.ok === false && held.error === "number_busy", JSON.stringify(held));
}

/* 9 · 1~10 전부 사용 중이면 all_busy */
{
  const env = makeEnv();
  for (let n = 1; n <= 10; n++) env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "n" + n, customerNumber: n }) });
  const r = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "over", customerNumber: 5 }) });
  check("전부 사용 중이면 all_busy", r.ok === false && r.error === "all_busy" && r.busy.length === 10, JSON.stringify(r));
}

/* 10 · 입력 검증: 잘못된 payload는 invalid */
{
  const env = makeEnv();
  const bad = [
    ["customerNumber 0", mkOrder({ customerNumber: 0 })],
    ["customerNumber 11", mkOrder({ customerNumber: 11 })],
    ["customerNumber 문자", mkOrder({ customerNumber: "abc" })],
    ["items 없음", mkOrder({ items: undefined })],
    ["items 빈 배열", mkOrder({ items: [] })],
    ["items 51개", mkOrder({ items: Array.from({ length: 51 }, (_, i) => ({ name: "m" + i, price: 100, qty: 1 })) })],
    ["name 101자", mkOrder({ items: [{ name: "가".repeat(101), price: 100, qty: 1 }] })],
    ["price 음수", mkOrder({ items: [{ name: "m", price: -100, qty: 1 }] })],
    ["price 소수", mkOrder({ items: [{ name: "m", price: 100.5, qty: 1 }] })],
    ["qty 음수", mkOrder({ items: [{ name: "m", price: 100, qty: -1 }] })],
    ["payMethod card", mkOrder({ payMethod: "card" })],
    ["source web", mkOrder({ source: "web" })],
  ];
  for (const [name, payload] of bad) {
    const r = env.post({ action: "addOrder", payload });
    check(`invalid 거부: ${name}`, r.ok === false && r.error === "invalid", JSON.stringify(r));
  }
  check("invalid 요청은 아무 행도 만들지 않음", env.sheets.Orders.data.length === 1, String(env.sheets.Orders.data.length));
}

/* 11 · update: 화이트리스트 키만 허용 */
{
  const env = makeEnv();
  const added = env.post({ action: "addOrder", payload: mkOrder({ clientOrderId: "u1" }) });
  const ok1 = env.post({ action: "update", payload: { id: added.id, fields: { payStatus: "paid" } } });
  check("update payStatus=paid 허용", ok1.ok === true, JSON.stringify(ok1));
  const ok2 = env.post({ action: "update", payload: { id: added.id, fields: {
    items: [{ itemId: "i1", name: "아메리카노", price: 2500, temp: "ice", qty: 1, status: "completed" }],
    total: 2500, orderStatus: "completed" } } });
  check("update items·total·orderStatus 허용", ok2.ok === true, JSON.stringify(ok2));
  const cur = env.get().orders.find(o => o.id === added.id);
  check("update 반영 확인(paid·completed)", cur.payStatus === "paid" && cur.orderStatus === "completed" && cur.items[0].status === "completed");

  const badKey = env.post({ action: "update", payload: { id: added.id, fields: { deleted: true } } });
  check("update 허용 외 키(deleted) 거부", badKey.ok === false && badKey.error === "invalid", JSON.stringify(badKey));
  const badVal = env.post({ action: "update", payload: { id: added.id, fields: { orderStatus: "???" } } });
  check("update 잘못된 orderStatus 거부", badVal.ok === false && badVal.error === "invalid");
  const badNum = env.post({ action: "update", payload: { id: added.id, fields: { customerNumber: 9 } } });
  check("update customerNumber 변경 거부", badNum.ok === false && badNum.error === "invalid");

  env.post({ action: "delete", payload: { id: added.id } });
  const onDeleted = env.post({ action: "update", payload: { id: added.id, fields: { payStatus: "unpaid" } } });
  check("삭제된 주문 update는 not found", onDeleted.ok === false, JSON.stringify(onDeleted));
}

/* 12 · 알 수 없는 action에도 version이 실려 구/신 서버를 구분할 수 있다 */
{
  const env = makeEnv();
  const r = env.post({ action: "nope" });
  check("unknown action 응답 + version:2", r.ok === false && /unknown action/.test(r.error) && r.version === 2, JSON.stringify(r));
}

console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과 ✓");
process.exit(failed ? 1 : 0);
