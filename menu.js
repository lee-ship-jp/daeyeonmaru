/* ─── 대연마루 공유 메뉴 데이터 ───
   index.html(직원용)과 kiosk.html(손님용 키오스크)이 함께 읽는다.
   메뉴 수정은 이 파일에서만 한다.
   img: 키오스크 메뉴 사진(images/menu/NN.webp, NN = id 두 자리 · 원본 jpg 보관).
        파일이 없으면 화면에서는 카테고리 아이콘 플레이스홀더로 대체된다.
        옵션(cat:"option")은 사진이 없다. */
const MENU = [
  /* COFFEE */
  { id:1,  name:"아메리카노",           price:2500, hasTemp:true,  cat:"coffee", img:"images/menu/01.webp" },
  { id:2,  name:"카페라떼",             price:3500, hasTemp:true,  cat:"coffee", img:"images/menu/02.webp" },
  { id:3,  name:"마루라떼",             price:4000, hasTemp:true,  cat:"coffee", tag:"Signature", img:"images/menu/03.webp" },
  { id:4,  name:"바닐라라떼",           price:4000, hasTemp:true,  cat:"coffee", img:"images/menu/04.webp" },
  { id:5,  name:"오트라떼",             price:4000, hasTemp:true,  cat:"coffee", img:"images/menu/05.webp" },
  /* LATTE */
  { id:6,  name:"초코라떼",             price:4000, hasTemp:true,  cat:"latte", img:"images/menu/06.webp" },
  { id:7,  name:"말차라떼",             price:4000, hasTemp:true,  cat:"latte", img:"images/menu/07.webp" },
  { id:8,  name:"딸기라떼",             price:4000, hasTemp:false, cat:"latte", tag:"ICE만", img:"images/menu/08.webp" },
  { id:9,  name:"곡물라떼",             price:3500, hasTemp:true,  cat:"latte", img:"images/menu/09.webp" },
  /* ADE & JUICE */
  { id:10, name:"레몬에이드",           price:3000, hasTemp:false, cat:"ade", img:"images/menu/10.webp" },
  { id:11, name:"자몽에이드",           price:3500, hasTemp:false, cat:"ade", img:"images/menu/11.webp" },
  { id:12, name:"청포도에이드",         price:3500, hasTemp:false, cat:"ade", img:"images/menu/12.webp" },
  { id:13, name:"유자에이드",           price:3500, hasTemp:false, cat:"ade", img:"images/menu/13.webp" },
  /* TEA */
  { id:14, name:"꿀레몬차",             price:3500, hasTemp:true,  cat:"tea", img:"images/menu/14.webp" },
  { id:15, name:"꿀자몽차",             price:3500, hasTemp:true,  cat:"tea", img:"images/menu/15.webp" },
  { id:16, name:"꿀유자차",             price:3500, hasTemp:true,  cat:"tea", img:"images/menu/16.webp" },
  { id:17, name:"꿀생강차",             price:3500, hasTemp:true,  cat:"tea", img:"images/menu/17.webp" },
  { id:18, name:"진저레몬티",           price:4000, hasTemp:true,  cat:"tea", img:"images/menu/18.webp" },
  { id:19, name:"유기농 페퍼민트차",    price:5000, hasTemp:true,  cat:"tea", img:"images/menu/19.webp" },
  { id:20, name:"캐모마일차",           price:3500, hasTemp:true,  cat:"tea", img:"images/menu/20.webp" },
  { id:21, name:"복숭아 아이스티",      price:3000, hasTemp:false, cat:"tea", img:"images/menu/21.webp" },
  { id:22, name:"아망추",               price:4000, hasTemp:false, cat:"tea", img:"images/menu/22.webp" },
  /* SMOOTHIE & SHAKE */
  { id:23, name:"플레인요거트스무디",   price:3500, hasTemp:false, cat:"smoothie", img:"images/menu/23.webp" },
  { id:24, name:"블루베리요거트스무디", price:4000, hasTemp:false, cat:"smoothie", img:"images/menu/24.webp" },
  { id:25, name:"딸기요거트스무디",     price:4000, hasTemp:false, cat:"smoothie", img:"images/menu/25.webp" },
  { id:26, name:"망고요거트스무디",     price:4000, hasTemp:false, cat:"smoothie", img:"images/menu/26.webp" },
  { id:27, name:"유자요거트스무디",     price:4000, hasTemp:false, cat:"smoothie", img:"images/menu/27.webp" },
  { id:28, name:"밀크쉐이크",           price:3500, hasTemp:false, cat:"smoothie", img:"images/menu/28.webp" },
  { id:29, name:"초코쉐이크",           price:4000, hasTemp:false, cat:"smoothie", img:"images/menu/29.webp" },
  { id:30, name:"말차쉐이크",           price:4000, hasTemp:false, cat:"smoothie", img:"images/menu/30.webp" },
  { id:31, name:"바나나쉐이크",         price:4000, hasTemp:false, cat:"smoothie", img:"images/menu/31.webp" },
  { id:32, name:"딸기바나나스무디",     price:4500, hasTemp:false, cat:"smoothie", tag:"Special", img:"images/menu/32.webp" },
  { id:33, name:"초코바나나스무디",     price:4500, hasTemp:false, cat:"smoothie", img:"images/menu/33.webp" },
  /* HEALTHY SMOOTHIE */
  { id:34, name:"케일바나나주스",       price:4500, hasTemp:false, cat:"healthy", img:"images/menu/34.webp" },
  /* DESSERT */
  { id:35, name:"꾸로플",               price:1000, hasTemp:false, cat:"dessert", img:"images/menu/35.webp" },
  /* OPTION */
  { id:36, name:"샷 추가",              price:500,  hasTemp:false, cat:"option" },
  { id:37, name:"오트밀크 변경",        price:500,  hasTemp:false, cat:"option" },
  { id:38, name:"디카페인 변경",        price:500,  hasTemp:false, cat:"option" },
  { id:39, name:"연하게",               price:0,    hasTemp:false, cat:"option" },
];
const CATS = {
  coffee:   { icon:"☕", label:"커피 · Coffee" },
  latte:    { icon:"🥛", label:"라떼 · Latte" },
  ade:      { icon:"🧃", label:"에이드 · 주스" },
  tea:      { icon:"🍵", label:"차 · Tea" },
  smoothie: { icon:"🥤", label:"스무디 · 쉐이크" },
  healthy:  { icon:"🥬", label:"건강 스무디" },
  dessert:  { icon:"🍯", label:"디저트" },
  option:   { icon:"➕", label:"옵션 · 요청사항" },
};

/* Node 검증 스크립트(tests/check-menu.mjs)에서 require로 읽는다. 브라우저에서는 무시된다 */
if (typeof module !== "undefined" && module.exports) module.exports = { MENU, CATS };
