/* QA 1단계 회귀 테스트 (QA-01·03·04·05·06·07) — Playwright, ?local=1 전용.
   실제 구글 시트에는 어떤 요청도 보내지 않는다(로컬 origin 외 전부 차단).
   실행:
     PW_DIR=/tmp/dm-pw node tests/qa-stage1.mjs
   자체 정적 서버(기본 127.0.0.1:8899)를 띄웠다가 끝나면 닫는다. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const root  = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pwDir = process.env.PW_DIR || (fs.existsSync("/tmp/dm-pw/node_modules/playwright") ? "/tmp/dm-pw" : root);
const require = createRequire(path.join(pwDir, "package.json"));
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;

/* ── 자체 정적 서버 (저장소 루트) ── */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, BASE).pathname);
  const f = path.normalize(path.join(root, p === "/" ? "index.html" : p));
  if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch();
const results = [];

/* 공통: 시나리오마다 새 컨텍스트(저장소 격리) + 외부 네트워크 차단 */
async function newCtx(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 768, height: 1366 }, locale: "ko-KR", timezoneId: "Asia/Seoul", ...opts,
  });
  await ctx.route("**/*", route =>
    route.request().url().startsWith(BASE) ? route.continue() : route.abort());
  return ctx;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const readOrders = p => p.evaluate(() => JSON.parse(localStorage.getItem("maru_orders") || "[]"));
const seedScript = orders => [`localStorage.clear(); localStorage.setItem("maru_orders", ${JSON.stringify(JSON.stringify(orders))});`].join("");

function mkOrder(over = {}) {
  return {
    id: "seed_" + Math.random().toString(36).slice(2),
    customerNumber: 1,
    timestamp: new Date().toISOString(),
    items: [{ itemId: "it1", name: "아메리카노", price: 2500, temp: "ice", qty: 1, status: "pending" }],
    total: 2500, orderStatus: "pending", source: "kiosk", payMethod: "transfer", payStatus: "unpaid",
    ...over,
  };
}

async function test(name, fn) {
  let ctx;
  try {
    ctx = await newCtx();
    await fn(ctx);
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: String(e && e.message || e).split("\n")[0] });
    console.error(`  ✗ ${name} — ${String(e && e.message || e).split("\n")[0]}`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

console.log(`QA 1단계 회귀 테스트 — ${BASE} (?local=1)`);

/* ══ QA-01 A · 직원앱: 저장 직전 번호 점유 재확인 ══ */
await test("QA-01A 직원앱 저장 직전 재확인(중복 차단·장바구니 유지·번호 모달 재표시)", async ctx => {
  await ctx.addInitScript(`localStorage.clear(); localStorage.setItem("maru_next_num", "1");`);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html?local=1`);
  await p.click("#startBtn");                        // 손님 #1 로 시작
  await p.click("#mc-1 .add-btn");                   // 아메리카노 담기
  // 그 사이 키오스크가 같은 1번으로 접수한 상황을 저장소에 직접 주입
  await p.evaluate(o => localStorage.setItem("maru_orders", JSON.stringify([o])), mkOrder({ customerNumber: 1 }));
  await p.click("#orderBtn");
  await p.waitForSelector("#payMethodModal:not(.hidden)");
  await p.click(".paym-btn.cash");
  await p.waitForFunction(() => document.getElementById("orderBtn").textContent === "주문하기", null, { timeout: 10000 });
  const orders = await readOrders(p);
  assert(orders.length === 1, `중복 저장됨: 주문 ${orders.length}건 (기대 1건)`);
  assert(orders[0].source === "kiosk", "직원 주문이 저장되어 버림");
  const cartCnt = await p.textContent("#cartCnt");
  assert(cartCnt.trim() === "1", `장바구니가 유지되지 않음 (cartCnt=${cartCnt})`);
  const modalHidden = await p.$eval("#numModal", el => el.classList.contains("hidden"));
  assert(!modalHidden, "번호 모달이 다시 표시되지 않음");
});

/* ══ QA-01 B · 직원앱: 1~10 전부 사용 중이면 주문 시작 차단 ══ */
await test("QA-01B 직원앱 전번호 사용 중 → 주문 시작 차단", async ctx => {
  const ten = Array.from({ length: 10 }, (_, i) =>
    mkOrder({ customerNumber: i + 1, timestamp: new Date(Date.now() - 10 * 60e3).toISOString() }));
  await ctx.addInitScript(seedScript(ten));
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html?local=1`);
  await p.waitForSelector("#numModal:not(.hidden)");
  await p.click("#startBtn");
  await p.waitForTimeout(400);
  const hidden = await p.$eval("#numModal", el => el.classList.contains("hidden"));
  assert(!hidden, "전부 사용 중인데 주문이 시작됨(모달 닫힘)");
  const badge = await p.textContent("#customerBadge");
  assert(badge.includes("미선택"), `손님 번호가 배정됨: ${badge}`);
});

/* ══ QA-03 · 저장형 XSS: 주방·내역·PDF HTML 이스케이프 ══ */
await test("QA-03 주문명 XSS 미실행·이스케이프(주방·내역·PDF)", async ctx => {
  const payload = `<img src="data:," onerror="window.__qaXss=(window.__qaXss||0)+1">QA`;
  const evil = mkOrder({ customerNumber: "7" });
  evil.items[0].name = payload;
  await ctx.addInitScript(seedScript([evil]));
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(String(e)));
  await p.goto(`${BASE}/index.html?local=1`);
  await p.click('button[data-tab="kitchen"]');
  await p.waitForTimeout(400);
  let xss = await p.evaluate(() => window.__qaXss);
  assert(!xss, `주방에서 스크립트 실행됨 (__qaXss=${xss})`);
  const kTxt = await p.textContent("#kGrid");
  assert(kTxt.includes("<img"), "주방에서 주문명이 문자열로 표시되지 않음(이스케이프 안 됨)");
  assert(kTxt.includes("손님 #7"), "customerNumber가 숫자로 강제되어 표시되지 않음");
  await p.click('button[data-tab="history"]');
  await p.waitForTimeout(400);
  xss = await p.evaluate(() => window.__qaXss);
  assert(!xss, `내역에서 스크립트 실행됨 (__qaXss=${xss})`);
  const pdfHtml = await p.evaluate(() => buildMonthReport(monthKey(new Date().toISOString())));
  assert(!pdfHtml.includes("<img"), "PDF HTML에 주문명이 이스케이프 없이 들어감");
  assert(errs.length === 0, `pageerror 발생: ${errs[0]}`);
});

/* ══ QA-04 a · 키오스크: 저장 중 무입력 만료 금지 + 저장 타임아웃(장바구니 유지) ══ */
await test("QA-04a 저장 지연 70초: 초기화 금지·타임아웃 실패 안내·장바구니 유지", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date() });
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.click("#screen-idle");
  await p.click("#num-3");
  await p.click("#kcard-3");
  await p.waitForSelector("#optModalBg.open");
  await p.click("#optAdd");
  await p.click("#cartOrderBtn");
  await p.click("#payCash");
  await p.evaluate(() => {               // 저장 응답을 보류시킨다 (느린 서버 재현)
    window.__pending = null;
    Backend.add = () => new Promise((res, rej) => { window.__pending = { res, rej }; });
  });
  await p.click("#cashDone");
  await p.waitForFunction(() => !!window.__pending, null, { timeout: 5000 });
  await p.clock.fastForward("01:10");    // 70초 경과
  await p.waitForTimeout(500);
  const screen = await p.evaluate(() => screen);
  assert(screen === "cash", `저장 중 70초 경과 후 화면이 초기화됨 (screen=${screen})`);
  const cartLen = await p.evaluate(() => cart.length);
  assert(cartLen === 1, `장바구니가 지워짐 (cart=${cartLen})`);
  const dlgOpen = await p.$eval("#dlgBg", el => el.classList.contains("open"));
  const dlgTxt  = dlgOpen ? await p.textContent("#dlgBox") : "";
  assert(dlgOpen && dlgTxt.includes("주문 저장에 실패"), `저장 타임아웃 실패 안내가 없음 (dlg="${dlgTxt.slice(0, 40)}")`);
});

/* ══ QA-04 b · 키오스크: 늦게 끝난 저장이 다음 손님 장바구니를 건드리지 않음 ══ */
await test("QA-04b 세션 토큰: 이전 저장 응답이 다음 손님 화면·장바구니를 변경하지 않음", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.click("#screen-idle");
  await p.click("#num-3");
  await p.click("#kcard-3");
  await p.waitForSelector("#optModalBg.open");
  await p.click("#optAdd");
  await p.click("#cartOrderBtn");
  await p.click("#payCash");
  await p.evaluate(() => {
    window.__pending = null;
    Backend.add = () => new Promise((res, rej) => { window.__pending = { res, rej }; });
  });
  await p.click("#cashDone");
  await p.waitForFunction(() => !!window.__pending, null, { timeout: 5000 });
  // 저장이 안 끝난 사이 손님이 떠나고(처음으로) 다음 손님이 4번으로 주문을 시작
  await p.click("#screen-cash .back");
  await p.click("#screen-pay .back");
  await p.click('#screen-menu button:has-text("처음으로")');
  await p.click('#dlgBox button:has-text("처음으로")');
  await p.waitForSelector("#screen-idle.active");
  await p.click("#screen-idle");
  await p.click("#num-4");
  await p.click("#kcard-1");
  await p.waitForSelector("#optModalBg.open");
  await p.click("#optAdd");
  // 이제 이전 손님의 저장 응답이 도착
  await p.evaluate(() => window.__pending.res({}));
  await p.waitForTimeout(400);
  const st = await p.evaluate(() => ({ screen, cart: cart.length, custNum }));
  assert(st.screen === "menu", `이전 저장 응답이 화면을 바꿈 (screen=${st.screen})`);
  assert(st.cart === 1, `다음 손님 장바구니가 지워짐 (cart=${st.cart})`);
  assert(st.custNum === 4, `손님 번호가 바뀜 (custNum=${st.custNum})`);
});

/* ══ QA-05 · 어제 미완료 주문: 24시간 내 점유 + 주방 「어제」 배지 ══ */
await test("QA-05 어제 미완료 번호 점유(24h)·주방 어제 배지", async ctx => {
  const mockNow = new Date(); mockNow.setHours(12, 0, 0, 0);   // 오늘 정오로 고정해 날짜 경계를 결정적으로
  const o20h = mkOrder({ customerNumber: 1, timestamp: new Date(mockNow.getTime() - 20 * 3600e3).toISOString() });
  const o30h = mkOrder({ customerNumber: 2, timestamp: new Date(mockNow.getTime() - 30 * 3600e3).toISOString() });
  await ctx.addInitScript(seedScript([o20h, o30h]));

  const kiosk = await ctx.newPage();
  await kiosk.clock.setFixedTime(mockNow);
  await kiosk.goto(`${BASE}/kiosk.html?local=1`);
  await kiosk.click("#screen-idle");
  assert(await kiosk.$eval("#num-1", b => b.disabled), "키오스크: 어제(20h 전) 미완료 1번이 사용 중이 아님");
  assert(!(await kiosk.$eval("#num-2", b => b.disabled)), "키오스크: 24시간 지난 2번이 아직 사용 중으로 묶여 있음");

  const staff = await ctx.newPage();
  await staff.clock.setFixedTime(mockNow);
  await staff.goto(`${BASE}/index.html?local=1`);
  await staff.waitForSelector("#numModal .num-btn:disabled");
  const nn = (await staff.textContent("#nextNumVal")).trim();
  assert(nn === "2", `직원앱 다음 번호가 사용 중 1번을 건너뛰지 않음 (nextNum=${nn})`);
  await staff.click('button[data-tab="kitchen"]');
  const kTxt = await staff.textContent("#kGrid");
  assert(kTxt.includes("어제"), "주방 카드에 「어제」 날짜 배지가 없음");
});

/* ══ QA-06 · 보조 키(maru_update) 쓰기 실패: 허위 실패·중복 접수 방지 ══ */
await test("QA-06 보조 키 쓰기 실패에도 저장 성공 처리 + clientOrderId 중복 무시", async ctx => {
  await ctx.addInitScript(`
    localStorage.clear();
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "maru_update" && window.__failUpdateKey) throw new DOMException("quota", "QuotaExceededError");
      return orig.call(this, k, v);
    };`);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html?local=1`);
  await p.click("#startBtn");
  await p.click("#mc-1 .add-btn");
  await p.evaluate(() => { window.__failUpdateKey = true; });
  await p.click("#orderBtn");
  await p.waitForSelector("#payMethodModal:not(.hidden)");
  await p.click(".paym-btn.cash");
  await p.waitForFunction(() => JSON.parse(localStorage.getItem("maru_orders") || "[]").length === 1, null, { timeout: 10000 });
  await p.waitForFunction(() => document.getElementById("orderBtn").textContent === "주문하기", null, { timeout: 10000 });
  const cartCnt = await p.textContent("#cartCnt");
  assert(cartCnt.trim() === "0", `실제로 저장됐는데 실패로 처리됨(장바구니 유지, cartCnt=${cartCnt})`);
  await p.evaluate(() => { window.__failUpdateKey = false; });
  // 같은 clientOrderId 재시도는 중복 저장되지 않아야 한다
  const dupCnt = await p.evaluate(async () => {
    const o = { clientOrderId: "dup_1", customerNumber: 9, timestamp: new Date().toISOString(),
                items: [{ itemId: "x", name: "테스트", price: 1000, temp: null, qty: 1, status: "pending" }],
                total: 1000, orderStatus: "pending" };
    await Backend.add(o);
    await Backend.add(JSON.parse(JSON.stringify(o)));
    return JSON.parse(localStorage.getItem("maru_orders")).filter(x => x.clientOrderId === "dup_1").length;
  });
  assert(dupCnt === 1, `같은 clientOrderId 주문이 중복 저장됨 (${dupCnt}건)`);
});

/* ══ QA-07 · 잘못된 주문 1건이 직원앱을 깨뜨리지 않음 ══ */
await test("QA-07 불량 주문 건너뛰기(주방·내역 정상, pageerror 없음)", async ctx => {
  const good = mkOrder({ customerNumber: 5 });
  const bad1 = { id: "bad1", customerNumber: 3, timestamp: new Date().toISOString(), orderStatus: "pending", total: 0 };  // items 없음
  const bad2 = { id: "bad2", customerNumber: "abc", timestamp: "garbage", items: "nope", orderStatus: "???" };
  await ctx.addInitScript(seedScript([good, bad1, bad2]));
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(String(e)));
  await p.goto(`${BASE}/index.html?local=1`);
  await p.click('button[data-tab="kitchen"]');
  await p.waitForTimeout(300);
  const kTxt = await p.textContent("#kGrid");
  assert(kTxt.includes("손님 #5"), "정상 주문이 주방에 표시되지 않음");
  await p.click('button[data-tab="history"]');
  await p.waitForTimeout(300);
  const hTxt = await p.textContent("#orderList");
  assert(hTxt.includes("손님 #5"), "정상 주문이 내역에 표시되지 않음");
  assert(errs.length === 0, `pageerror 발생: ${errs[0]}`);
});

await browser.close();
server.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length}개 중 통과 ${results.length - failed.length} · 실패 ${failed.length}`);
if (failed.length) process.exit(1);
