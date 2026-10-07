# ☕ 대연마루 주문 앱

기쁜소식부산대연교회 **CAFE 대연마루**의 주문·주방·매출 관리 웹앱입니다.
설치 없이 링크만 열면 되고, 모든 기기가 같은 주문 데이터를 공유합니다.

👉 **https://daeyeonmaru.pages.dev/** (Cloudflare Pages)

> 옛 주소(lee-ship-jp.github.io/daeyeonmaru)로 열면 안내 배너가 뜨고
> 5초 후 새 주소로 자동 이동합니다. 옛 주소에서는 주문이 등록되지 않습니다.

## 화면 구성
| 탭 | 하는 일 |
|---|---|
| 📱 주문 | 손님 번호(1~30) 선택 → 메뉴 담기 → 주문 등록 |
| 🍳 주방 | 대기 중인 주문 확인 → 선택 → 완료 처리 |
| 📋 내역 | 날짜·상태·손님별 조회, 메뉴별 판매 집계, 매출 요약 |

## 메뉴
커피 / 라떼 / 에이드·주스 / 차 / 스무디·쉐이크 / 건강 스무디 / 디저트 / 옵션
— 총 39종. 메뉴 수정은 공유 파일 `menu.js`의 `MENU` 배열에서 합니다
(직원앱 `index.html`과 키오스크 `kiosk.html`이 함께 사용).
메뉴 사진은 `images/menu/NN.jpg`(NN = 메뉴 id 두 자리, 01~35).

## 🖥 손님용 키오스크 (`/kiosk.html`)
안드로이드 태블릿 세로형으로 손님이 직접 주문하는 화면입니다.

👉 **https://daeyeonmaru.pages.dev/kiosk.html**

- 흐름: 대기 화면 터치 → 번호 선택(**1~10**, 직원앱과 공용 — 진행 중 주문이 쓰는 번호는 「사용 중」으로 비활성, 전부 사용 중이면 안내문 표시) → 메뉴 담기(사진·옵션·수량) → 결제 방법 선택 → 완료 화면(주문번호 크게 안내).
- 결제: **계좌이체**(NH농협 301-0383-6883-11, 예금주 기쁜소식부산대연교회 — 입금자명에 주문번호) 또는 **카운터 현금**. 카드 결제는 없습니다.
- 키오스크 주문은 직원앱 주방·내역에 「키오스크」 배지 + 결제수단 + 미결제/결제완료 표시로 나타나고, 새 주문이 오면 알림음이 울립니다. 결제를 받으면 「결제확인」을 눌러 주세요.
- 60초 동안 입력이 없으면 확인 후 대기 화면으로 돌아갑니다(장바구니 초기화).

### 안드로이드 태블릿 설치
1. Chrome에서 위 키오스크 주소 열기
2. 메뉴(⋮) → **「홈 화면에 추가」**(설치) → 홈 화면 아이콘으로 실행하면 전체화면·세로 고정으로 열립니다
3. 손님이 다른 앱으로 나가지 못하게 **화면 고정**(설정 → 보안 → 앱 고정)이나 **Fully Kiosk Browser** 같은 키오스크 앱 사용을 권장합니다

### 검증(개발용)
- `node tests/check-menu.mjs` — 메뉴 데이터 무결성
- `node tests/api.mjs` — 서버 API 검증(로컬 D1 전용 상태에 pages dev 를 띄워 생성·번호 점유·멱등·화이트리스트·soft delete/restore·Origin·24h 정리 확인)
- `PW_DIR=/tmp/dm-pw node tests/kiosk-flow.mjs` — Playwright 전체 주문 흐름(스크린샷 `docs/screens/`)
  - API 모드(로컬 pages dev + 빈 D1 상대): `API_MODE=1 BASE_URL=http://127.0.0.1:8796 PW_DIR=/tmp/dm-pw node tests/kiosk-flow.mjs`
- `tests/qa-stage1.mjs` · `tests/qa-stage3.mjs` — QA 회귀(둘 다 `?local=1`)
- `kiosk.html?local=1`, `index.html?local=1` — 서버에 쓰지 않는 로컬 체험 모드

## 데이터 저장 (Cloudflare Pages + D1)
주문은 같은 출처의 **Pages Functions API(`/api`)** 를 거쳐 **Cloudflare D1**(SQLite, DB 이름 `daeyeonmaru`)에 저장됩니다.
각 기기는 화면이 켜져 있는 동안 약 2초마다 갱신합니다(기본 목록은 최근 60일, 매출 PDF는 `?all=1` 전체 조회).
주문번호 1~10 중복 방지는 서버의 `active_numbers` 점유 테이블이 원자적으로 보장하고,
완료·삭제 시 번호가 풀리며 24시간 지난 점유는 자동 정리됩니다.
삭제는 soft delete(복구 가능, `POST /api/orders/:id/restore`)이고 전체 삭제 API는 없습니다.
모든 추가·수정·삭제·복구는 `audit_log`에 남습니다.

### API 요약 (응답마다 `version: 3`)
| 메서드·경로 | 내용 |
|---|---|
| `GET /api/health` | 상태 확인 |
| `GET /api/orders` | 목록(삭제 제외, 최근 60일 · `?since=<ISO>` · `?all=1`) |
| `POST /api/orders` | 주문 생성 — 번호 확정 / `number_busy`(busy 목록) / `all_busy` / `clientOrderId` 멱등(`duplicate:true`) |
| `PATCH /api/orders/:id` | `{fields}` 중 `orderStatus`·`payStatus`·`items`·`total`만 허용 |
| `DELETE /api/orders/:id` | soft delete + 번호 해제 |
| `POST /api/orders/:id/restore` | 삭제 취소 |

쓰기는 같은 출처(또는 Origin 헤더 없음)만 허용합니다.

## 배포 (Cloudflare)
```bash
# 0) 최초 1회 — D1 생성 후 wrangler.toml 의 database_id(__DB_ID__) 를 발급받은 값으로 교체
npx wrangler d1 create daeyeonmaru

# 1) 마이그레이션 적용 순서 (원격)
npx wrangler d1 execute daeyeonmaru --remote --file=migrations/0001_init.sql
npx wrangler d1 execute daeyeonmaru --remote --file=migrations/seed/import_sheet.sql   # 구글 시트 기록 이전(최초 1회, 재실행 안전)

# 2) 정적 파일 모아 배포
scripts/build-cf.sh && npx wrangler pages deploy dist --project-name daeyeonmaru --branch main
```
로컬 개발·검증(원격에 쓰지 않음):
```bash
npx wrangler d1 execute daeyeonmaru --local --file=migrations/0001_init.sql
npx wrangler d1 execute daeyeonmaru --local --file=migrations/seed/import_sheet.sql
scripts/build-cf.sh && npx wrangler pages dev --port 8796   # dist·DB 바인딩은 wrangler.toml 에서 읽는다
```
(`--d1 DB=...` CLI 플래그는 wrangler.toml 과 다른 로컬 DB를 만들므로 쓰지 않습니다.
이 Mac 에서는 8790 포트를 다른 프로젝트가 쓰고 있어 8796 을 기본으로 합니다.)

## 파일
- `index.html` — 직원앱 전체 (단일 파일) / `kiosk.html` — 손님용 키오스크
- `menu.js` · `images/menu/` — 공유 메뉴 데이터·사진
- `functions/api/[[route]].js` — Pages Functions API(서버 v3) / `lib/validate.js` — 입력 검증(공용)
- `migrations/` — D1 스키마·시트 기록 이전 SQL / `wrangler.toml` — Pages·D1 설정
- `scripts/build-cf.sh` — 배포용 `dist/` 생성(화이트리스트 복사) / `scripts/import-sheet.mjs` — 이전 SQL 생성기
- `apps-script/Code.gs` — (기록용) 옛 Google Apps Script 백엔드 v2 — 더 이상 사용하지 않음
