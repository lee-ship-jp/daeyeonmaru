/**
 * 구글 시트 기록 이전 — dm-sheet-export.json → migrations/seed/import_sheet.sql
 * ------------------------------------------------------------------
 * 원본(읽기 전용): ~/.hermes/cache/scratch/dm-sheet-export.json (시트 Orders 탭 전체)
 * 생성: INSERT OR IGNORE 문 — 원래 id·timestamp·createdAt 을 그대로 유지한다.
 *   · 필드 없는 옛 주문: source='staff', pay_method 는 NULL
 *   · 과거 기록이므로 active_numbers(번호 점유)에는 넣지 않는다
 *     (완료되지 않은 옛 주문도 24시간이 지나 점유 대상이 아니다)
 *
 * 실행:  node scripts/import-sheet.mjs [원본경로]
 * 적용:  npx wrangler d1 execute daeyeonmaru --local --file=migrations/seed/import_sheet.sql
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = process.argv[2] || path.join(os.homedir(), ".hermes/cache/scratch/dm-sheet-export.json");
const outFile = path.join(root, "migrations", "seed", "import_sheet.sql");

const orders = JSON.parse(fs.readFileSync(src, "utf8"));
if (!Array.isArray(orders)) throw new Error("원본이 주문 배열이 아닙니다: " + src);

const q = v => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const lines = [
  "-- 구글 시트(Orders 탭) 기록 이전 — scripts/import-sheet.mjs 가 생성",
  `-- 원본: ${path.basename(src)} · ${orders.length}건 · 생성 ${new Date().toISOString()}`,
  "-- 재실행해도 안전(INSERT OR IGNORE). active_numbers 에는 넣지 않는다(과거 기록).",
  "",
];

let total = 0;
const seenIds = new Set();
for (const o of orders) {
  if (!o || typeof o !== "object" || !o.id) throw new Error("id 없는 주문: " + JSON.stringify(o).slice(0, 120));
  if (seenIds.has(o.id)) throw new Error("중복 id: " + o.id);
  seenIds.add(o.id);
  if (!Number.isFinite(Number(o.total))) throw new Error("total 없는 주문: " + o.id);
  if (o.deleted) throw new Error("원본에 deleted 주문이 있음(예상 밖): " + o.id);

  const createdAt = o.createdAt || o.timestamp;
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error("시각 없는 주문: " + o.id);
  total += Number(o.total);

  /* 옛 주문의 빈 필드 기본값 — json 에도 같은 값을 반영해 화면·DB 컬럼을 일치시킨다 */
  const order = { ...o };
  if (order.source == null) order.source = "staff";

  lines.push(
    "INSERT OR IGNORE INTO orders " +
    "(id, client_order_id, customer_number, source, pay_method, pay_status, order_status, total, created_at, updated_at, deleted, deleted_at, json) VALUES (" +
    [
      q(order.id),
      q(order.clientOrderId ?? null),
      Number(order.customerNumber),
      q(order.source),
      q(order.payMethod ?? null),
      q(order.payStatus ?? null),
      q(order.orderStatus ?? "pending"),
      Number(order.total),
      q(createdAt),
      q(createdAt),
      0,
      "NULL",
      q(JSON.stringify(order)),
    ].join(", ") + ");"
  );
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, lines.join("\n") + "\n");
console.log(`생성 완료: ${path.relative(root, outFile)}`);
console.log(`주문 ${orders.length}건 · total 합계 ${total.toLocaleString("ko-KR")}원`);
