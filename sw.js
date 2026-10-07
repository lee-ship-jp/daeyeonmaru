/* ─── 대연마루 키오스크 서비스워커 ───
   kiosk.html에서만 등록한다(직원앱 index.html은 등록하지 않음 — scope '/'라
   직원앱 요청도 지나가지만 아래 규칙 밖 요청은 손대지 않는다).
   규칙:
   - /api/* 와 GET이 아닌 요청: 절대 가로채지 않는다(네트워크 그대로).
   - /images/** (webp/jpg/png/svg): cache-first. 설치 시 hero·메뉴 사진 전체·아이콘 precache.
   - kiosk 셸(kiosk.html·menu.js·manifest.json)과 탐색 요청: network-first(3초) → 캐시 폴백.
     그래서 배포 후 다음 실행에 바로 새 화면이 반영된다.
   배포 시 캐시 무효화가 필요하면 CACHE 버전을 올린다(activate에서 이전 버전 삭제). */
const CACHE = "dm-kiosk-v1";

const MENU_IMAGES = Array.from({ length: 35 }, (_, i) =>
  `/images/menu/${String(i + 1).padStart(2, "0")}.webp`);

const PRECACHE = [
  "/images/kiosk/hero.webp",
  "/images/icon-192.png",
  "/images/icon-512.png",
  "/images/icon.svg",
  ...MENU_IMAGES,
  /* 셸 — Cloudflare Pages에선 /kiosk, 로컬 정적 서버에선 /kiosk.html 만 있을 수 있어 둘 다 시도 */
  "/kiosk",
  "/kiosk.html",
  "/menu.js",
  "/manifest.json",
];

/* Cloudflare Pages가 /kiosk.html → /kiosk 로 308 리디렉트하므로, redirected 응답은
   그대로 캐시하지 않고 본문만 새 Response로 재구성한다
   (redirected 응답을 탐색 요청에 재사용하면 브라우저가 거부한다). */
async function cleanResponse(resp) {
  if (!resp.redirected) return resp;
  const body = await resp.clone().blob();
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* addAll 대신 개별 fetch: 일부 실패(예: 로컬 서버에 /kiosk 없음)가 전체를 막지 않게 */
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const resp = await fetch(url, { redirect: "follow", cache: "no-cache" });
        if (resp.ok) await cache.put(url, await cleanResponse(resp));
      } catch (_) { /* 오프라인·404 등은 무시 — 런타임 캐싱이 보충한다 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const IMG_RE = /\.(webp|jpe?g|png|svg)$/i;
const NET_FIRST = new Set(["/kiosk", "/kiosk.html", "/menu.js", "/manifest.json"]);
/* 오프라인 탐색 폴백으로 kiosk 셸을 내줘도 되는 경로 — 직원앱(/ · /index.html)은 제외 */
const KIOSK_PATHS = new Set(["/kiosk", "/kiosk.html"]);

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sw: network timeout")), ms);
    fetch(req).then(
      (r) => { clearTimeout(t); resolve(r); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const resp = await fetch(req);
  if (resp.ok && !resp.redirected) {
    const cache = await caches.open(CACHE);
    cache.put(req, resp.clone());
  }
  return resp;
}

async function networkFirst(req) {
  try {
    const resp = await fetchWithTimeout(req, 3000);
    /* 탐색 요청의 리디렉트(opaqueredirect 등)는 캐시하지 않고 브라우저에 그대로 넘긴다 */
    if (resp.ok) {
      const clean = await cleanResponse(resp);
      const cache = await caches.open(CACHE);
      await cache.put(req, clean.clone());
      return clean;
    }
    return resp;
  } catch (_) {
    const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    if (req.mode === "navigate" && KIOSK_PATHS.has(new URL(req.url).pathname)) {
      const shell = (await caches.match("/kiosk")) || (await caches.match("/kiosk.html"));
      if (shell) return shell;
    }
    return Response.error();
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                    // 비-GET(주문 저장 등)은 절대 가로채지 않음
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // 외부 요청은 손대지 않음
  if (url.pathname.startsWith("/api/")) return;        // API는 절대 가로채지 않음
  if (url.pathname.startsWith("/images/") || IMG_RE.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === "navigate" || NET_FIRST.has(url.pathname)) {
    e.respondWith(networkFirst(req));
    return;
  }
  /* 그 외(직원앱 전용 자원 등)는 기본 네트워크 동작 유지 */
});
