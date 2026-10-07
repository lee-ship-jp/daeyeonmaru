/* QA 3단계 회귀 테스트 (QA-08~13 · S-03 · S-04 · S-05) — Playwright, ?local=1 전용.
   실제 구글 시트에는 어떤 요청도 보내지 않는다(로컬 origin 외 전부 차단).
   실행:
     PW_DIR=/tmp/dm-pw node tests/qa-stage3.mjs
   자체 정적 서버(기본 127.0.0.1:8891)를 띄웠다가 끝나면 닫는다. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const root  = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pwDir = process.env.PW_DIR || (fs.existsSync("/tmp/dm-pw/node_modules/playwright") ? "/tmp/dm-pw" : root);
const require = createRequire(path.join(pwDir, "package.json"));
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8891);
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

/* 키오스크 기본 흐름: 대기 → 번호 n → 메뉴 (장바구니 담기까지 옵션) */
async function kioskToMenu(p, n = 3) {
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.click("#screen-idle");
  await p.waitForSelector("#screen-number.active");
  await p.click(`#num-${n}`);
  await p.waitForSelector("#screen-menu.active");
}
async function kioskAddItem(p, card = 1) {
  await p.click(`#kcard-${card}`);
  await p.waitForSelector("#optModalBg.open");
  await p.click("#optAdd");
}
const rectOf = (p, sel) => p.$eval(sel, el => {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
});

console.log(`QA 3단계 회귀 테스트 — ${BASE} (?local=1)`);

/* ══ QA-08 a · 키오스크 768×1366: 조작부 64px 이상 ══ */
await test("QA-08a 키오스크 768×1366 터치 조작부 ≥64px", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.click("#screen-idle");
  const num = await rectOf(p, "#num-1");
  assert(num.w >= 64 && num.h >= 64, `번호 버튼 ${num.w}×${num.h} < 64`);
  await p.click("#num-3");
  for (const sel of ["#screen-menu .ktop-btn", ".cat-tab", ".kcart-head"]) {
    const r = await rectOf(p, sel);
    assert(r.h >= 64, `${sel} 높이 ${r.h}px < 64`);
  }
  await p.click("#kcard-3");               // 마루라떼 — 온도·옵션 있음
  await p.waitForSelector("#optModalBg.open");
  for (const sel of [".opt-temp button", "#optQtyPlus", ".opt-extra button", "#optCancel"]) {
    const r = await rectOf(p, sel);
    assert(r.h >= 64, `${sel} 높이 ${r.h}px < 64`);
  }
  await p.click("#optAdd");                // 담기 → 장바구니 자동 열림
  for (const sel of [".kline-qty button", ".kline-del"]) {
    const r = await rectOf(p, sel);
    assert(r.w >= 64 && r.h >= 64, `${sel} ${r.w}×${r.h} < 64×64`);
  }
});

/* ══ QA-08 b · 키오스크 375×812 폰: 번호 4열·장바구니 버튼도 64px 이상 ══ */
await test("QA-08b 키오스크 375×812 번호·장바구니 조작부 ≥64px", async ctx2 => {
  await ctx2.close();   // 기본 뷰포트 대신 폰 크기 컨텍스트 사용
  const ctx = await newCtx({ viewport: { width: 375, height: 812 } });
  try {
    await ctx.addInitScript(`localStorage.clear();`);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/kiosk.html?local=1`);
    await p.click("#screen-idle");
    const num = await rectOf(p, "#num-1");
    assert(num.w >= 64 && num.h >= 64, `폰 번호 버튼 ${num.w}×${num.h} < 64`);
    await p.click("#num-3");
    const top = await rectOf(p, "#screen-menu .ktop-btn");
    assert(top.h >= 64, `폰 상단 버튼 높이 ${top.h}px < 64`);
    await kioskAddItem(p, 1);
    for (const sel of [".kline-qty button", ".kline-del"]) {
      const r = await rectOf(p, sel);
      assert(r.w >= 64 && r.h >= 64, `폰 ${sel} ${r.w}×${r.h} < 64×64`);
    }
  } finally { await ctx.close().catch(() => {}); }
});

/* ══ QA-08 c · 직원앱 375×812: 보고서 지적 조작부 48px 이상 ══ */
await test("QA-08c 직원앱 수량±·담기·삭제·결제확인 ≥48px", async ctx2 => {
  await ctx2.close();
  const ctx = await newCtx({ viewport: { width: 375, height: 812 } });
  try {
    await ctx.addInitScript(seedScript([mkOrder()]));   // 미결제 주문 → 결제확인 버튼 노출
    const p = await ctx.newPage();
    await p.goto(`${BASE}/index.html?local=1`);
    for (const sel of ["#mc-1 .qty-btn", "#mc-1 .add-btn", "#mc-1 .temp-btn"]) {
      const r = await rectOf(p, sel);
      assert(r.h >= 48, `${sel} 높이 ${r.h}px < 48`);
    }
    const qb = await rectOf(p, "#mc-1 .qty-btn");
    assert(qb.w >= 48, `수량 버튼 폭 ${qb.w}px < 48`);
    await p.click('button[data-tab="kitchen"]');
    await p.waitForSelector(".k-card");
    for (const sel of [".k-del-order", ".k-del-item"]) {
      const r = await rectOf(p, sel);
      assert(r.w >= 48 && r.h >= 48, `${sel} ${r.w}×${r.h} < 48×48`);
    }
    const pc = await rectOf(p, ".pay-confirm-btn");
    assert(pc.h >= 48, `결제확인 버튼 높이 ${pc.h}px < 48`);
  } finally { await ctx.close().catch(() => {}); }
});

/* ══ QA-09 a · 대기 화면 키보드 시작 (Tab → Enter/Space) ══ */
await test("QA-09a 대기 화면 Tab 포커스·Enter/Space 시작", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.keyboard.press("Tab");
  const act = await p.evaluate(() => document.activeElement && document.activeElement.id);
  assert(act === "screen-idle", `Tab 포커스가 대기 화면이 아님 (${act})`);
  await p.keyboard.press("Enter");
  await p.waitForSelector("#screen-number.active");
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.keyboard.press("Tab");
  await p.keyboard.press(" ");
  await p.waitForSelector("#screen-number.active");
});

/* ══ QA-09 b · 옵션 모달: role·포커스 이동·배경 inert·Tab 가두기·Esc 복귀 ══ */
await test("QA-09b 옵션 모달 dialog·포커스 가두기·Esc·포커스 복귀", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await kioskToMenu(p, 3);
  await p.click("#kcard-3");
  await p.waitForSelector("#optModalBg.open");
  const a = await p.evaluate(() => ({
    role: document.getElementById("optModal").getAttribute("role"),
    modal: document.getElementById("optModal").getAttribute("aria-modal"),
    inside: document.getElementById("optModal").contains(document.activeElement),
    bgInert: document.getElementById("screen-menu").inert === true,
  }));
  assert(a.role === "dialog" && a.modal === "true", `role/aria-modal 없음 (${a.role}/${a.modal})`);
  assert(a.inside, "모달이 열렸는데 포커스가 안으로 이동하지 않음");
  assert(a.bgInert, "모달이 열렸는데 배경이 inert가 아님");
  for (let i = 0; i < 14; i++) {
    await p.keyboard.press("Tab");
    const inside = await p.evaluate(() => document.getElementById("optModalBg").contains(document.activeElement));
    assert(inside, `Tab ${i + 1}회 후 포커스가 모달 밖으로 나감`);
  }
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => !document.getElementById("optModalBg").classList.contains("open"));
  const b = await p.evaluate(() => ({
    act: document.activeElement && document.activeElement.id,
    bgInert: document.getElementById("screen-menu").inert === true,
  }));
  assert(b.act === "kcard-3", `닫은 뒤 포커스가 원래 요소로 돌아오지 않음 (${b.act})`);
  assert(!b.bgInert, "모달을 닫았는데 배경 inert가 남음");
});

/* ══ QA-09 c · 키오스크 확인 다이얼로그: role·포커스·Esc=취소 ══ */
await test("QA-09c 확인 다이얼로그 dialog·Esc 취소·장바구니 유지", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await kioskToMenu(p, 3);
  await kioskAddItem(p, 1);
  await p.click('#screen-menu button:has-text("처음으로")');
  await p.waitForSelector("#dlgBg.open");
  const a = await p.evaluate(() => ({
    role: document.getElementById("dlgBox").getAttribute("role"),
    inside: document.getElementById("dlgBox").contains(document.activeElement),
  }));
  assert(a.role === "dialog", "다이얼로그 role 없음");
  assert(a.inside, "다이얼로그 포커스가 안으로 이동하지 않음");
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => !document.getElementById("dlgBg").classList.contains("open"));
  const st = await p.evaluate(() => ({ screen, cart: cart.length }));
  assert(st.screen === "menu" && st.cart === 1, `Esc가 취소로 동작하지 않음 (screen=${st.screen}, cart=${st.cart})`);
});

/* ══ QA-09 d · 직원앱 결제수단 모달: 포커스·Tab 가두기·Esc·복귀·배경 inert ══ */
await test("QA-09d 직원앱 결제수단 모달 접근성", async ctx => {
  await ctx.addInitScript(`localStorage.clear(); localStorage.setItem("maru_next_num", "1");`);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html?local=1`);
  await p.click("#startBtn");
  await p.click("#mc-1 .add-btn");
  await p.click("#orderBtn");
  await p.waitForSelector("#payMethodModal:not(.hidden)");
  const a = await p.evaluate(() => ({
    role: document.querySelector("#payMethodModal .paym-box").getAttribute("role"),
    modal: document.querySelector("#payMethodModal .paym-box").getAttribute("aria-modal"),
    inside: document.getElementById("payMethodModal").contains(document.activeElement),
    bgInert: document.querySelector(".app-header").inert === true,
  }));
  assert(a.role === "dialog" && a.modal === "true", "결제수단 모달 role/aria-modal 없음");
  assert(a.inside, "결제수단 모달 포커스가 안으로 이동하지 않음");
  assert(a.bgInert, "결제수단 모달이 열렸는데 배경이 inert가 아님");
  for (let i = 0; i < 6; i++) {
    await p.keyboard.press("Tab");
    const inside = await p.evaluate(() => document.getElementById("payMethodModal").contains(document.activeElement));
    assert(inside, `Tab ${i + 1}회 후 포커스가 결제수단 모달 밖으로 나감`);
  }
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => document.getElementById("payMethodModal").classList.contains("hidden"));
  const b = await p.evaluate(() => ({
    act: document.activeElement && document.activeElement.id,
    bgInert: document.querySelector(".app-header").inert === true,
  }));
  assert(b.act === "orderBtn", `닫은 뒤 포커스가 주문하기로 돌아오지 않음 (${b.act})`);
  assert(!b.bgInert, "모달을 닫았는데 배경 inert가 남음");
});

/* ══ QA-10 · PDF 「총 판매 수량 …잔」은 음료만, 디저트는 별도 ══ */
await test("QA-10 PDF 잔 수 음료만 집계·디저트 별도 표시", async ctx => {
  const o = mkOrder({
    items: [
      { itemId: "a", name: "마루라떼",  price: 4000, temp: "ice", qty: 2, status: "pending" },
      { itemId: "b", name: "샷 추가",   price: 500,  temp: null,  qty: 2, status: "pending" },
      { itemId: "c", name: "연하게",    price: 0,    temp: null,  qty: 2, status: "pending" },
      { itemId: "d", name: "딸기라떼",  price: 4000, temp: null,  qty: 1, status: "pending" },
      { itemId: "e", name: "꾸로플",    price: 1000, temp: null,  qty: 1, status: "pending" },
    ],
    total: 14000,
  });
  await ctx.addInitScript(seedScript([o]));
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html?local=1`);
  const html = await p.evaluate(() => buildMonthReport(monthKey(new Date().toISOString())));
  assert(html.includes("3잔"), "음료 3잔이 아님 (옵션·디저트 포함 의심)");
  assert(!html.includes("8잔"), "옵션·디저트까지 센 8잔이 그대로 표시됨");
  assert(html.includes("디저트 1개"), "「디저트 1개」 별도 표시가 없음");
});

/* ══ QA-11 · 375px 폰: 상단 버튼 한 줄 유지·주방 시간 nowrap ══ */
await test("QA-11 폰 상단 버튼 줄바꿈 없음·주방 시간 nowrap", async ctx2 => {
  await ctx2.close();
  const ctx = await newCtx({ viewport: { width: 375, height: 812 } });
  try {
    await ctx.addInitScript(seedScript([mkOrder()]));
    const p = await ctx.newPage();
    await p.goto(`${BASE}/kiosk.html?local=1`);
    await p.click("#screen-idle");
    await p.click("#num-10");   // 두 자리 번호로 가장 넓은 경우 확인
    await p.waitForSelector("#screen-menu.active");
    const m = await p.evaluate(() => {
      const top = document.querySelector("#screen-menu .ktop");
      const btns = [...document.querySelectorAll("#screen-menu .ktop-btn")]
        .map(b => ({ txt: b.textContent.trim(), h: b.getBoundingClientRect().height }));
      return { btns, overflow: top.scrollWidth - top.clientWidth, topH: top.getBoundingClientRect().height };
    });
    m.btns.forEach(b => assert(b.h <= 72, `「${b.txt}」 버튼이 세로로 줄바꿈됨 (높이 ${b.h}px)`));
    assert(m.overflow <= 1, `상단 바 가로 넘침 ${m.overflow}px`);
    assert(m.topH <= 100, `메뉴 상단 바가 너무 커짐 (${m.topH}px)`);

    const staff = await ctx.newPage();
    await staff.goto(`${BASE}/index.html?local=1`);
    await staff.click('button[data-tab="kitchen"]');
    await staff.waitForSelector(".k-card");
    const ws = await staff.$eval(".k-time", el => getComputedStyle(el).whiteSpace);
    assert(ws === "nowrap", `주방 카드 시간이 nowrap이 아님 (${ws})`);
  } finally { await ctx.close().catch(() => {}); }
});

/* ══ QA-12 · 직원앱 알림음: 첫 조작 시 AudioContext 활성화 + 상태 버튼 ══ */
await test("QA-12 알림음 켜기 버튼·첫 클릭 AudioContext 활성화", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html?local=1`);
  const before = await p.textContent("#soundBtn");
  assert(before.includes("알림음"), `초기 버튼 문구가 다름 (${before})`);
  await p.click("#soundBtn");
  await p.waitForTimeout(400);
  const st = await p.evaluate(() => ({
    has: !!chimeCtx, state: chimeCtx && chimeCtx.state,
    txt: document.getElementById("soundBtn").textContent.trim(),
  }));
  assert(st.has, "첫 클릭에 AudioContext가 만들어지지 않음");
  if (st.state === "running") assert(st.txt.includes("✓"), `켜졌는데 ✓ 표시가 없음 (${st.txt})`);
  else assert(st.txt.includes("알림음"), `꺼짐 상태 표기가 사라짐 (${st.txt})`);
});

/* ══ QA-13 · 문구 통일: 「사용 중」·「…해 주세요」·손님 화면 「주문번호」 ══ */
await test("QA-13 문구 통일(소스 grep)", async () => {
  const kioskSrc = fs.readFileSync(path.join(root, "kiosk.html"), "utf8");
  const staffSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert(!/해주세요/.test(kioskSrc), "kiosk.html에 「…해주세요」(붙여쓰기)가 남아 있음");
  assert(!/해주세요/.test(staffSrc), "index.html에 「…해주세요」(붙여쓰기)가 남아 있음");
  assert(!/사용중/.test(kioskSrc), "kiosk.html에 「사용중」(붙여쓰기)이 남아 있음");
  assert(!/사용중/.test(staffSrc), "index.html에 「사용중」(붙여쓰기)이 남아 있음");
  assert(!/선택 번호/.test(kioskSrc), "키오스크 손님 화면에 「선택 번호」가 남아 있음");
  assert(/주문번호/.test(kioskSrc), "키오스크에 「주문번호」 표기가 없음");
});

/* ══ S-03 a · 계좌이체 화면: 60초가 아닌 180초 + 「이체했어요」 30초 추가 확인 ══ */
await test("S-03a 계좌이체 180초·이체했어요 확인으로 주문 완료", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date() });
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.click("#screen-idle");
  await p.click("#num-3");
  await kioskAddItem(p, 1);
  await p.click("#cartOrderBtn");
  await p.click("#payTransfer");
  await p.waitForSelector("#screen-transfer.active");
  await p.clock.fastForward("01:10");   // 70초 — 기본 60초 타임아웃이 적용되면 안 된다
  await p.waitForTimeout(200);
  let dlgOpen = await p.$eval("#dlgBg", el => el.classList.contains("open"));
  assert(!dlgOpen, "계좌이체 화면이 60초 기준으로 타임아웃됨 (180초여야 함)");
  await p.clock.fastForward("01:55");   // 총 185초 — 180초 만료 후 확인 다이얼로그
  await p.waitForSelector("#dlgBg.open");
  const txt = await p.textContent("#dlgBox");
  assert(txt.includes("이체했어요"), `확인 다이얼로그에 「이체했어요」 안내가 없음 (${txt.slice(0, 40)})`);
  assert(await p.$("#dlgCount"), "추가 확인 카운트다운이 없음");
  await p.click('#dlgBox button:has-text("이체했어요")');
  await p.waitForSelector("#screen-done.active");
  const orders = await readOrders(p);
  assert(orders.length === 1 && orders[0].payMethod === "transfer",
    `이체했어요로 주문이 저장되지 않음 (${orders.length}건)`);
});

/* ══ S-03 b · 추가 확인 30초 무응답이면 그때 처음 화면으로 ══ */
await test("S-03b 이체 확인 30초 무응답 → 초기화", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date() });
  await p.goto(`${BASE}/kiosk.html?local=1`);
  await p.click("#screen-idle");
  await p.click("#num-3");
  await kioskAddItem(p, 1);
  await p.click("#cartOrderBtn");
  await p.click("#payTransfer");
  await p.waitForSelector("#screen-transfer.active");
  await p.clock.fastForward("03:05");   // 185초 — 확인 다이얼로그 표시 중
  await p.waitForSelector("#dlgBg.open");
  await p.clock.fastForward("00:40");   // 남은 카운트다운 소진
  await p.waitForSelector("#screen-idle.active");
  const orders = await readOrders(p);
  assert(orders.length === 0, "무응답 초기화인데 주문이 저장됨");
});

/* ══ S-05 · 브라우저(안드로이드) 뒤로가기: 앱 이탈 대신 이전 단계 ══ */
await test("S-05 뒤로가기 가드: 단계별 복귀·대기 화면 무시·이탈 없음", async ctx => {
  await ctx.addInitScript(`localStorage.clear();`);
  const p = await ctx.newPage();
  await kioskToMenu(p, 3);
  await kioskAddItem(p, 1);
  await p.click("#cartOrderBtn");
  await p.click("#payTransfer");
  await p.waitForSelector("#screen-transfer.active");
  await p.evaluate(() => history.back());
  await p.waitForFunction(() => screen === "pay");
  await p.evaluate(() => history.back());
  await p.waitForFunction(() => screen === "menu");
  const cartLen = await p.evaluate(() => cart.length);
  assert(cartLen === 1, `뒤로가기 중 장바구니가 지워짐 (${cartLen})`);
  await p.evaluate(() => history.back());
  await p.waitForFunction(() => screen === "number");
  await p.evaluate(() => history.back());            // 번호 → 처음으로 확인 다이얼로그
  await p.waitForSelector("#dlgBg.open");
  await p.click('#dlgBox button:has-text("처음으로")');
  await p.waitForSelector("#screen-idle.active");
  await p.evaluate(() => history.back());            // 대기 화면: 무시
  await p.waitForTimeout(300);
  assert(p.url().includes("kiosk.html"), `뒤로가기로 앱을 이탈함 (${p.url()})`);
  const sc = await p.evaluate(() => screen);
  assert(sc === "idle", `대기 화면에서 뒤로가기가 무시되지 않음 (${sc})`);
});

/* ══ S-04 · 결제수단 합계 「주문 기준」 라벨 + payStatus 수납 분리 ══ */
await test("S-04 주문 기준 라벨·결제확인 완료/미결제 금액 분리", async ctx => {
  const paidOrder   = mkOrder({ customerNumber: 2, payMethod: "cash", payStatus: "paid",
    items: [{ itemId: "x", name: "마루라떼", price: 4000, temp: "ice", qty: 1, status: "pending" }], total: 4000 });
  const unpaidOrder = mkOrder({ customerNumber: 1 });   // transfer·unpaid 2,500원
  await ctx.addInitScript(seedScript([unpaidOrder, paidOrder]));
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html?local=1`);
  const t = await p.evaluate(() => payStatusTotals(getOrders()));
  assert(t.paid === 4000 && t.unpaid === 2500, `payStatus 집계 오류 (paid=${t.paid}, unpaid=${t.unpaid})`);
  await p.click('button[data-tab="history"]');
  await p.waitForSelector("#summaryRow .sum-card");
  const sum = await p.textContent("#summaryRow");
  assert(sum.includes("주문 기준"), "매출 요약에 「주문 기준」 라벨이 없음");
  assert(sum.includes("결제확인 완료 금액"), "「결제확인 완료 금액」 카드가 없음");
  assert(sum.includes("미결제 금액"), "「미결제 금액」 카드가 없음");
  const pdf = await p.evaluate(() => buildMonthReport(monthKey(new Date().toISOString())));
  assert(pdf.includes("주문 기준") && pdf.includes("결제확인 완료 금액") && pdf.includes("미결제 금액"),
    "PDF에 주문 기준/수납 분리 표기가 없음");
});

await browser.close();
server.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length}개 중 통과 ${results.length - failed.length} · 실패 ${failed.length}`);
if (failed.length) process.exit(1);
