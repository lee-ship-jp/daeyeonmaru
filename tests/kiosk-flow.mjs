/* 키오스크 주문 흐름 E2E 검증 (Playwright) — 실제 구글 시트에 쓰지 않도록 ?local=1 로 연다.
   실행 예:
     python3 -m http.server 8787 &            # 저장소 루트에서
     PW_DIR=<playwright가 설치된 폴더> node tests/kiosk-flow.mjs
   스크린샷은 docs/screens/ 에 저장된다. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root  = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pwDir = process.env.PW_DIR || root;
const require = createRequire(path.join(pwDir, "package.json"));
const { chromium } = require("playwright");

const BASE   = process.env.BASE_URL || "http://localhost:8787";
const outDir = path.join(root, "docs", "screens");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx  = await browser.newContext({ viewport: { width: 768, height: 1366 }, locale: "ko-KR" });
const page = await ctx.newPage();
const shot = name => page.screenshot({ path: path.join(outDir, name) });
const fail = msg => { throw new Error(msg); };

/* ── 키오스크: 대기 → 번호 → 메뉴 담기 → 계좌이체 → 완료 ── */
await page.goto(`${BASE}/kiosk.html?local=1`);
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
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("maru_orders") || "[]"));
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
await staff.goto(`${BASE}/index.html?local=1`);
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
await staff.waitForFunction(() => JSON.parse(localStorage.getItem("maru_orders") || "[]").length === 2);
const so = await staff.evaluate(() => JSON.parse(localStorage.getItem("maru_orders"))[1]);
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
