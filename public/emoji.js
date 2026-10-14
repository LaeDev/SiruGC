/* ================= 이모티콘 ================= */
// 기기마다 이모티콘 모양이 다르고, 못 그리는 기기(오래된 폰 등)는 네모로 보인다. 그래서 글 속 이모티콘은 우리가 싣고 있는
// Twemoji 그림(/emoji/*.svg)으로 바꿔 그려서 어디서나 같은 모양으로 보이게 한다. 그림이 없는 것은 원래 글자 그대로 둔다.
// (이 파일은 app.js 보다 먼저 올라오므로 app.js 의 도우미(el 등)를 쓰지 않는다)
const EMOJI_EL = '(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)\\p{Emoji_Modifier}?';
let EMOJI_RE = null;
try { EMOJI_RE = new RegExp(`\\p{RI}\\p{RI}|[#*0-9]\\uFE0F?\\u20E3|${EMOJI_EL}(?:\\u200D(?:${EMOJI_EL}|\\p{Extended_Pictographic}\\uFE0F?))*[\\u{E0020}-\\u{E007F}]*`, 'gu'); } catch {} // (정규식을 못 만드는 아주 오래된 브라우저: 이모티콘은 기기 글자 그대로 보인다)
// 그림 파일 이름: 코드 포인트를 16진수 소문자로 이어 붙인다. ZWJ(‍)가 없으면 ️ 는 뺀다 (Twemoji 규칙)
const emojiFile = (s) => {
  let cps = [...s].map((c) => c.codePointAt(0));
  if (!cps.includes(0x200d)) cps = cps.filter((c) => c !== 0xfe0f);
  return '/emoji/' + cps.map((c) => c.toString(16)).join('-') + '.svg';
};
function emojiImg(s) {
  const img = document.createElement('img');
  img.className = 'emoji'; img.alt = s; img.draggable = false; img.loading = 'lazy'; img.decoding = 'async'; img.src = emojiFile(s);
  img.onerror = () => img.replaceWith(document.createTextNode(s)); // 그림이 없으면 기기의 글자 그대로
  return img;
}
// 글 → 글 조각과 이모티콘 그림이 섞인 노드 목록
function emojiNodes(text) {
  if (!EMOJI_RE) return [document.createTextNode(String(text))];
  const out = []; let last = 0;
  for (const m of String(text).matchAll(EMOJI_RE)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(emojiImg(m[0])); last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
const emojiImgCache = new Map();
// 아바타 그림을 그릴 때: 이모티콘 그림을 이미지로 불러온다 (없으면 거절)
function loadEmojiImg(s) {
  if (!emojiImgCache.has(s)) emojiImgCache.set(s, new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => { emojiImgCache.delete(s); no(new Error('no emoji')); }; im.src = emojiFile(s); }));
  return emojiImgCache.get(s);
}
