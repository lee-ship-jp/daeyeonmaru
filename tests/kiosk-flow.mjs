/* 키오스크 주문 흐름 E2E 검증 (Playwright) — 기본은 ?local=1 로 열고(서버에 쓰지 않음)
   로컬 서버 밖으로 나가는 요청은 전부 차단한다.
   실행 예:
     PW_DIR=/tmp/dm-pw node tests/kiosk-flow.mjs
   8787 포트가 비어 있으면 자체 정적 서버를 띄웠다가 끝나면 닫는다(이미 떠 있으면 그대로 사용).
   스크린샷은 docs/screens/ 에 저장된다.

   API 모드 — 로컬 wrangler pages dev(D1) 를 상대로 같은 흐름을 검증:
     API_MODE=1 BASE_URL=http://127.0.0.1:8796 PW_DIR=/tmp/dm-pw node tests/kiosk-flow.mjs
   (?local=1 없이 열어 /api 로 저장·조회. 주문이 없는 새 D1 상태에서 실행해야 하며,
    스크린샷은 docs/ 를 더럽히지 않게 .qa/screens-api/ 에 저장된다) */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import http from "node:http";

const root  = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pwDir = process.env.PW_DIR || (fs.existsSync("/tmp/dm-pw/node_modules/playwright") ? "/tmp/dm-pw" : root);
const require = createRequire(path.join(pwDir, "package.json"));
const { chromium } = require("playwright");

const API    = process.env.API_MODE === "1";          // 1 = pages dev(/api) 모드, 기본 = ?local=1
const BASE   = process.env.BASE_URL || "http://localhost:8787";
const PORT   = Number(new URL(BASE).port || 80);
const Q      = API ? "" : "?local=1";
const outDir = API ? path.join(root, ".qa", "screens-api") : path.join(root, "docs", "screens");
fs.mkdirSync(outDir, { recursive: true });

/* ── 자체 정적 서버 (저장소 루트) — 포트가 이미 쓰이고 있으면 기존 서버를 쓴다 ── */
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
const ownServer = await new Promise(resolve => {
  server.once("error", e => {
    if (e.code === "EADDRINUSE") resolve(false);   // 이미 떠 있는 서버 사용
    else throw e;
  });
  server.listen(PORT, () => resolve(true));
});

const browser = await chromium.launch();
const ctx  = await browser.newContext({ viewport: { width: 768, height: 1366 }, locale: "ko-KR" });
/* 로컬 서버 밖(구글 시트 등)으로 나가는 요청은 전부 차단한다 */
await ctx.route("**/*", route =>
  route.request().url().startsWith(BASE) ? route.continue() : route.abort());
const page = await ctx.newPage();
const shot = name => page.screenshot({ path: path.join(outDir, name) });
const fail = msg => { throw new Error(msg); };
/* 저장된 주문 읽기 — 로컬 모드는 localStorage, API 모드는 /api/orders */
const readOrders = p => API
  ? p.evaluate(() => fetch("/api/orders?t=" + Date.now()).then(r => r.json()).then(d => d.orders || []))
  : p.evaluate(() => JSON.parse(localStorage.getItem("maru_orders") || "[]"));

/* ── 키오스크: 대기 → 번호 → 메뉴 담기 → 계좌이체 → 완료 ── */
await page.goto(`${BASE}/kiosk.html${Q}`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector("#screen-idle.active");
await shot("01-대기화면.png");

await page.click("#screen-idle");
await page.waitForSelector("#screen-number.active");
await shot("02-번호선택.png");

await page.click("#num-3");
await page.waitForSelector("#screen-menu.active");
await shot("03-메뉴.png");

await page.click("#kcard-3");            // 마루라떼
await page.waitForSelector("#optModalBg.open");
await page.click("#opt-36");             // 샷 추가
await page.click("#optQtyPlus");         // 수량 2
await shot("04-옵션모달.png");
await page.click("#optAdd");

await page.click("#cat-latte");
await page.click("#kcard-8");            // 딸기라떼
await page.waitForSelector("#optModalBg.open");
await page.click("#optAdd");
await shot("05-장바구니.png");

await page.click("#cartOrderBtn");
await page.waitForSelector("#screen-pay.active");
await shot("06-결제선택.png");

await page.click("#payTransfer");
await page.waitForSelector("#screen-transfer.active");
await shot("07-계좌이체.png");

await page.click("#transferDone");
await page.waitForSelector("#screen-done.active");
await shot("08-완료.png");

/* 저장된 주문 검증: (마루라떼4000+샷500)×2 + 딸기라떼4000 = 13000 */
const saved = await readOrders(page);
if (saved.length !== 1) fail(`저장된 주문이 1건이 아님: ${saved.length}`);
const o = saved[0];
if (o.customerNumber !== 3)       fail("customerNumber ≠ 3");
if (o.source !== "kiosk")         fail("source ≠ kiosk");
if (o.payMethod !== "transfer")   fail("payMethod ≠ transfer");
if (o.payStatus !== "unpaid")     fail("payStatus ≠ unpaid");
if (o.total !== 13000)            fail(`total ≠ 13000 (실제 ${o.total})`);
if (o.items.length !== 3)         fail(`items 3줄이 아님: ${o.items.length}`);
if (o.items[1].name !== "샷 추가" || o.items[1].qty !== 2) fail("샷 추가 줄이 음료 뒤에 수량 2로 없음");

/* 주문 후 같은 번호는 「사용 중」 처리 확인 */
await page.click("#doneHome");
await page.waitForSelector("#screen-idle.active");
await page.click("#screen-idle");
await page.waitForSelector("#screen-number.active");
if (!await page.$eval("#num-3", b => b.disabled)) fail("주문 후 3번이 사용 중으로 표시되지 않음");

/* ── 직원앱(index.html?local=1): 같은 localStorage 공유 확인 ── */
await page.evaluate(() => localStorage.setItem("maru_next_num", "3"));   // 사용 중 번호 건너뛰기 검증용
const staff = await ctx.newPage();
await staff.goto(`${BASE}/index.html${Q}`);
/* 번호 모달: 진행 중 키오스크 주문(3번)이 「사용중」으로 비활성화돼야 한다 */
await staff.waitForSelector("#numModal .num-btn:disabled");
const busyCnt = await staff.$$eval("#numModal .num-btn:disabled", els => els.length);
if (busyCnt !== 1) fail(`직원앱 번호 그리드의 사용중 번호가 1개가 아님: ${busyCnt}`);
/* 다음 번호가 사용 중(3)을 건너뛰고 4가 되어야 한다 */
const nn = (await staff.textContent("#nextNumVal")).trim();
if (nn !== "4") fail(`nextNum이 사용 중 3번을 건너뛰지 않음: ${nn}`);

/* ── 직원앱 직접 주문: 주문하기 → 결제수단 모달 → 현금(=결제완료) ── */
await staff.click("#startBtn");
await staff.click("#mc-1 .add-btn");       // 아메리카노
await staff.click("#orderBtn");
await staff.waitForSelector("#payMethodModal:not(.hidden)");
await staff.screenshot({ path: path.join(outDir, "11-직원앱-결제수단.png") });
await staff.click(".paym-btn.cash");
if (API) await staff.waitForFunction(
  () => fetch("/api/orders?t=" + Date.now()).then(r => r.json()).then(d => (d.orders || []).length === 2),
  null, { polling: 500 });
else await staff.waitForFunction(() => JSON.parse(localStorage.getItem("maru_orders") || "[]").length === 2);
const so = (await readOrders(staff)).find(o => o.source === "staff");
if (so.customerNumber !== 4)   fail(`직원 주문 번호 ≠ 4 (실제 ${so.customerNumber})`);
if (so.payMethod !== "cash")   fail("직원 주문 payMethod ≠ cash");
if (so.payStatus !== "paid")   fail("직원 현금 주문 payStatus ≠ paid");
await staff.waitForTimeout(2500);          // 토스트·번호 모달 복귀 대기

await staff.click('button[data-tab="kitchen"]');
await staff.waitForSelector("#screen-kitchen.active");
const kTxt = await staff.textContent("#kGrid");
if (!kTxt.includes("손님 #3")) fail("직원앱 주방에 키오스크 주문 #3 없음");
if (!kTxt.includes("키오스크")) fail("주방 카드에 「키오스크」 배지 없음");
if (!kTxt.includes("계좌이체")) fail("주방 카드에 결제수단 표시 없음");
if (!kTxt.includes("미결제"))   fail("주방 카드에 「미결제」 표시 없음");
if (!kTxt.includes("손님 #4")) fail("직원앱 주방에 직원 주문 #4 없음");
if (!kTxt.includes("현금"))     fail("주방 카드에 현금 칩 없음");
if (!kTxt.includes("결제완료")) fail("주방 카드에 「결제완료」 표시 없음");
await staff.screenshot({ path: path.join(outDir, "09-직원앱-주방.png") });

await staff.click('button[data-tab="history"]');
await staff.waitForSelector("#screen-history.active");
const sumTxt = await staff.textContent("#summaryRow");
if (!sumTxt.includes("계좌이체")) fail("내역 매출 요약에 계좌이체 합계 없음");
const histTxt = await staff.textContent("#orderList");
if (!histTxt.includes("키오스크")) fail("내역 카드에 「키오스크」 배지 없음");
/* 결제확인 → 결제완료 (주방 탭에도 같은 버튼이 있으므로 내역 화면으로 한정)
   현금 주문은 이미 결제완료이므로, 미결제 칩이 모두 사라질 때까지 기다린다 */
await staff.click("#orderList .pay-confirm-btn");
await staff.waitForFunction(() => !document.querySelector("#orderList .pay-chip.unpaid"));
await staff.screenshot({ path: path.join(outDir, "10-직원앱-내역.png") });

console.log("키오스크 E2E 흐름 통과 ✓ — 스크린샷:", outDir);
await browser.close();
if (ownServer) server.close();
