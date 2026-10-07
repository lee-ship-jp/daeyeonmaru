/* Cloudflare Pages Functions + D1 API 검증 — 로컬 전용(원격에 어떤 요청도 보내지 않는다).
   전용 상태 폴더(.wrangler/test-state)에 스키마를 새로 깔고 wrangler pages dev 를 띄워
   생성·번호 점유·멱등·화이트리스트·soft delete/restore·Origin·24h 정리를 확인한다.
   실행:
     node tests/api.mjs            (기본 포트 8796 — 이 Mac의 8790은 다른 프로젝트가 사용 중)
     PORT=8791 node tests/api.mjs
   사전 조건: dist/ (scripts/build-cf.sh). 끝나면 서버를 스스로 내린다. */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = ".wrangler/test-state";   // 본 상태(.wrangler/state — 시트 이전분)와 분리

if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("dist/ 가 없습니다 — 먼저 scripts/build-cf.sh 를 실행하세요");
  process.exit(1);
}

const d1 = (...args) =>
  execFileSync("npx", ["wrangler", "d1", "execute", "daeyeonmaru", "--local", "--persist-to", STATE, ...args],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/* ── 새 상태 준비: 스키마 + 24h 지난 점유(9번) 시드 ── */
fs.rmSync(path.join(root, STATE), { recursive: true, force: true });
d1("--file", "migrations/0001_init.sql");
const staleIso = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
const staleOrder = {
  id: "order_stale_9", customerNumber: 9, timestamp: staleIso, createdAt: staleIso,
  items: [{ itemId: "i0", name: "아메리카노", price: 2500, temp: "ice", qty: 1, status: "pending" }],
  total: 2500, orderStatus: "pending", payStatus: "unpaid", source: "staff",
};
d1("--command",
  `INSERT INTO orders (id, customer_number, source, pay_status, order_status, total, created_at, updated_at, deleted, json)
   VALUES ('order_stale_9', 9, 'staff', 'unpaid', 'pending', 2500, '${staleIso}', '${staleIso}', 0, '${JSON.stringify(staleOrder)}');
   INSERT INTO active_numbers (number, order_id, since) VALUES (9, 'order_stale_9', '${staleIso}');`);

/* ── pages dev 기동 (wrangler.toml 의 dist·DB 바인딩 사용 — --d1 플래그 금지) ── */
const server = spawn("npx", ["wrangler", "pages", "dev", "--port", String(PORT), "--persist-to", STATE],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
let serverLog = "";
server.stdout.on("data", d => { serverLog += d; });
server.stderr.on("data", d => { serverLog += d; });
const stopServer = () => { try { process.kill(-server.pid, "SIGTERM"); } catch (e) {} };
process.on("exit", stopServer);

const until = Date.now() + 60000;
for (;;) {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (e) {}
  if (Date.now() > until) { console.error("서버 기동 실패\n" + serverLog.slice(-2000)); process.exit(1); }
  await new Promise(r => setTimeout(r, 500));
}

/* ── 테스트 도우미 ── */
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const api = async (method, p, body, headers = {}) => {
  const res = await fetch(`${BASE}/api/${p}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
};
const mkOrder = (num, coid, over = {}) => ({
  clientOrderId: coid, customerNumber: num, timestamp: new Date().toISOString(),
  items: [{ itemId: "i0", name: "아메리카노", price: 2500, temp: "ice", qty: 1, status: "pending" }],
  total: 2500, orderStatus: "pending", payStatus: "unpaid", source: "staff", payMethod: "cash", ...over,
});
const listOrders = async (q = "") => (await api("GET", `orders${q}`)).data.orders;

console.log("API 검증 (" + BASE + ")");

/* 1 · health */
{
  const { data } = await api("GET", "health");
  check("health: ok + version 3", data.ok === true && data.version === 3);
}

/* 2 · invalid 거부 — Code.gs v2와 같은 규칙 */
{
  const bad = [
    ["번호 범위 밖(11)", mkOrder(11, "c_bad1")],
    ["번호 없음", { ...mkOrder(1, "c_bad2"), customerNumber: undefined }],
    ["items 빈 배열", { ...mkOrder(1, "c_bad3"), items: [] }],
    ["item qty 소수", mkOrder(1, "c_bad4", { items: [{ name: "a", price: 100, qty: 1.5 }] })],
    ["item price 음수", mkOrder(1, "c_bad5", { items: [{ name: "a", price: -1, qty: 1 }] })],
    ["payMethod=card", mkOrder(1, "c_bad6", { payMethod: "card" })],
    ["source=hacker", mkOrder(1, "c_bad7", { source: "hacker" })],
    ["본문이 JSON 아님", undefined],
  ];
  for (const [name, payload] of bad) {
    const { data } = payload === undefined
      ? await fetch(`${BASE}/api/orders`, { method: "POST", body: "not-json" }).then(async r => ({ data: await r.json() }))
      : await api("POST", "orders", payload);
    check(`invalid 거부: ${name}`, data.ok === false && data.error === "invalid", JSON.stringify(data));
  }
}

/* 3 · 생성 + 멱등 + number_busy */
let id1;
{
  /* Code.gs v2 규칙: total 형식 오류는 거부가 아니라 items 합으로 대체 저장 */
  const tFix = (await api("POST", "orders", mkOrder(1, "c_totalfix", { total: -5 }))).data;
  const tRow = (await listOrders()).find(o => o.id === tFix.id);
  check("total 형식 오류 → items 합(2500)으로 대체", tFix.ok === true && tRow && tRow.total === 2500, JSON.stringify(tFix));
  await api("DELETE", `orders/${tFix.id}`);   // 번호 1 반납 후 본 생성 테스트 진행
  const { data } = await api("POST", "orders", mkOrder(1, "c1"));
  id1 = data.id;
  check("생성: ok + number 1 + id", data.ok === true && data.number === 1 && !!data.id);
  const dup = (await api("POST", "orders", mkOrder(1, "c1"))).data;
  check("멱등: 같은 clientOrderId → duplicate + 같은 id", dup.ok === true && dup.duplicate === true && dup.id === id1 && dup.number === 1);
  const busy = (await api("POST", "orders", mkOrder(1, "c2"))).data;
  check("number_busy: busy 목록에 1 + version", busy.ok === false && busy.error === "number_busy" && busy.busy.includes(1) && busy.version === 3);
  const cnt = (await listOrders()).length;
  check("number_busy 때 주문이 생기지 않음", cnt === 2, `주문 ${cnt}건(시드 포함 2건이어야 함)`);
}

/* 4 · Origin 검사 — 쓰기는 같은 출처·Origin 없음만 */
{
  const evil = await api("POST", "orders", mkOrder(2, "c_evil"), { Origin: "https://evil.example" });
  check("다른 출처 Origin 쓰기 → 403", evil.status === 403 && evil.data.ok === false);
  const same = await api("POST", "orders", mkOrder(2, "c_same"), { Origin: BASE });
  check("같은 출처 Origin 쓰기 → 허용", same.status === 200 && same.data.ok === true && same.data.number === 2);
  const read = await api("GET", "orders", undefined, { Origin: "https://evil.example" });
  check("다른 출처라도 읽기는 허용", read.status === 200 && read.data.ok === true);
}

/* 5 · 24h 정리 — 25시간 전 점유(9번)는 생성 시 풀린다 */
let id9;
{
  const { data } = await api("POST", "orders", mkOrder(9, "c9"));
  id9 = data.id;
  check("24h 지난 점유 번호(9) 재사용 가능", data.ok === true && data.number === 9, JSON.stringify(data));
}

/* 6 · PATCH 화이트리스트 */
{
  const okPay = (await api("PATCH", `orders/${id1}`, { fields: { payStatus: "paid" } })).data;
  check("PATCH payStatus=paid 허용", okPay.ok === true);
  const after = (await listOrders()).find(o => o.id === id1);
  check("PATCH 결과가 목록(json)에 반영", after && after.payStatus === "paid");

  const newItems = [{ itemId: "i0", name: "바닐라라떼", price: 4000, temp: "hot", qty: 2, status: "pending" }];
  const okItems = (await api("PATCH", `orders/${id1}`, { fields: { items: newItems, total: 8000 } })).data;
  const after2 = (await listOrders()).find(o => o.id === id1);
  check("PATCH items+total 허용·반영", okItems.ok === true && after2.total === 8000 && after2.items[0].name === "바닐라라떼");

  for (const [name, fields] of [
    ["허용 외 키 customerNumber", { customerNumber: 5 }],
    ["허용 외 키 deleted", { deleted: true }],
    ["orderStatus 값 오류", { orderStatus: "done" }],
    ["items 형식 오류", { items: [{ name: "", price: 1, qty: 1 }] }],
    ["fields 없음", undefined],
  ]) {
    const { data } = await api("PATCH", `orders/${id1}`, fields === undefined ? {} : { fields });
    check(`PATCH invalid 거부: ${name}`, data.ok === false && data.error === "invalid", JSON.stringify(data));
  }
  const nf = (await api("PATCH", "orders/order_없는것", { fields: { payStatus: "paid" } })).data;
  check("PATCH 없는 주문 → order not found", nf.ok === false && nf.error === "order not found");
}

/* 7 · 완료 시 번호 해제 */
{
  const done = (await api("PATCH", `orders/${id1}`, { fields: { orderStatus: "completed" } })).data;
  check("PATCH orderStatus=completed", done.ok === true);
  const re1 = (await api("POST", "orders", mkOrder(1, "c3"))).data;
  check("완료된 주문의 번호(1) 즉시 재사용 가능", re1.ok === true && re1.number === 1, JSON.stringify(re1));
}

/* 8 · soft delete → 목록 제외·번호 해제 → restore → 복귀·번호 재점유 */
{
  const del = (await api("DELETE", `orders/${id9}`)).data;
  check("DELETE(soft) ok", del.ok === true);
  check("삭제 주문은 기본 목록에서 제외", !(await listOrders()).some(o => o.id === id9));
  check("삭제 주문은 ?all=1 에서도 제외", !(await listOrders("?all=1")).some(o => o.id === id9));

  const re9 = (await api("POST", "orders", mkOrder(9, "c4"))).data;   // 삭제로 번호 9 해제 확인
  check("삭제된 주문의 번호(9) 재사용 가능", re9.ok === true && re9.number === 9);
  const del2 = (await api("DELETE", `orders/${re9.id}`)).data;        // 다시 비워서 restore 재점유 확인
  check("재사용 주문 삭제 ok", del2.ok === true);
  const delAgain = (await api("DELETE", `orders/${id9}`)).data;
  check("이미 삭제된 주문 DELETE → order not found", delAgain.ok === false && delAgain.error === "order not found");

  const rs = (await api("POST", `orders/${id9}/restore`)).data;
  check("restore ok", rs.ok === true);
  const back = (await listOrders()).find(o => o.id === id9);
  check("restore 후 목록 복귀 + deleted 표시 제거", !!back && !back.deleted && !back.deletedAt);
  const busy9 = (await api("POST", "orders", mkOrder(9, "c5"))).data;
  check("restore 가 번호(9)를 다시 점유", busy9.ok === false && busy9.error === "number_busy" && busy9.busy.includes(9), JSON.stringify(busy9));
  const rsAgain = (await api("POST", `orders/${id1}/restore`)).data;
  check("삭제 안 된 주문 restore → order not found", rsAgain.ok === false && rsAgain.error === "order not found");
}

/* 9 · all_busy — 1~10 전부 점유되면 생성 불가 */
{
  for (const n of [3, 4, 5, 6, 7, 8, 10]) {
    const { data } = await api("POST", "orders", mkOrder(n, `c_fill_${n}`));
    if (!data.ok) { check(`번호 ${n} 채우기`, false, JSON.stringify(data)); break; }
  }
  const full = (await api("POST", "orders", mkOrder(5, "c_full"))).data;
  check("all_busy: busy 10개", full.ok === false && full.error === "all_busy" && full.busy.length === 10, JSON.stringify(full));
}

/* 10 · since / all / 전체 삭제 없음 / 미지원 경로 */
{
  const future = await listOrders(`?since=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}`);
  check("since=미래 → 0건", future.length === 0);
  const past = await listOrders(`?since=${encodeURIComponent("2020-01-01T00:00:00.000Z")}`);
  const all = await listOrders("?all=1");
  check("since=과거 = 전체(all=1)와 같음", past.length === all.length && all.length > 0);
  const clear = await api("POST", "clear", {});
  check("전체 삭제류 경로 없음(404)", clear.status === 404);
  const delAll = await fetch(`${BASE}/api/orders`, { method: "DELETE" });
  check("DELETE /api/orders(전체) 없음(404)", delAll.status === 404);
}

/* ── 서버 내리고 감사 로그 확인 ── */
stopServer();
await new Promise(r => setTimeout(r, 1500));
{
  const out = d1("--command", "SELECT action, COUNT(*) c FROM audit_log GROUP BY action ORDER BY action", "--json");
  const rows = JSON.parse(out)[0].results;
  const by = Object.fromEntries(rows.map(r => [r.action, r.c]));
  check("audit_log: addOrder·update·delete·restore 기록",
    by.addOrder >= 10 && by.update >= 3 && by.delete >= 2 && by.restore >= 1, JSON.stringify(by));
}

console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
