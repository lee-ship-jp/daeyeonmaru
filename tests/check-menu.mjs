/* menu.js 무결성 검증 — 실행: node tests/check-menu.mjs */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { MENU, CATS } = require(path.join(root, "menu.js"));

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("menu.js 검증");

check("MENU는 배열", Array.isArray(MENU));
check("MENU 39개", MENU.length === 39, `실제 ${MENU.length}개`);

const ids = MENU.map(m => m.id);
check("id 1~39 중복 없이 모두 존재",
  new Set(ids).size === 39 && ids.every(id => id >= 1 && id <= 39));

const badFields = MENU.filter(m =>
  typeof m.name !== "string" || !m.name ||
  typeof m.price !== "number" || m.price < 0 ||
  typeof m.hasTemp !== "boolean" ||
  typeof m.cat !== "string");
check("모든 항목에 name·price·hasTemp·cat", badFields.length === 0,
  badFields.map(m => m.id).join(","));

const badCat = MENU.filter(m => !CATS[m.cat]);
check("모든 cat이 CATS에 정의됨", badCat.length === 0, badCat.map(m => m.cat).join(","));

const drinks = MENU.filter(m => m.cat !== "option");
const opts   = MENU.filter(m => m.cat === "option");
check("옵션 외 메뉴 35개 / 옵션 4개", drinks.length === 35 && opts.length === 4,
  `메뉴 ${drinks.length} / 옵션 ${opts.length}`);

const badImg = drinks.filter(m => m.img !== `images/menu/${String(m.id).padStart(2, "0")}.jpg`);
check("메뉴(1~35) img = images/menu/NN.jpg (NN=id 두 자리)", badImg.length === 0,
  badImg.map(m => `${m.id}:${m.img}`).join(", "));

const optImg = opts.filter(m => "img" in m);
check("옵션(36~39)에는 img 없음", optImg.length === 0, optImg.map(m => m.id).join(","));

check("CATS 8종(option 포함)", Object.keys(CATS).length === 8,
  Object.keys(CATS).join(","));
check("CATS 각 항목에 icon·label",
  Object.values(CATS).every(c => c.icon && c.label));

if (failed) { console.error(`\n실패 ${failed}건`); process.exit(1); }
console.log("\n모두 통과 ✓");
