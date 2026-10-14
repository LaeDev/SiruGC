// 링크 카드: 채팅·쪽지에 올라온 X(트위터) 글 주소를 서버가 대신 가져와서, 로그인 없이 바로 보이는 카드 내용(JSON)으로 돌려준다 (디스코드의 임베드와 같은 방식).
//
// X 는 공식 임베드가 쓰는 공개 주소(cdn.syndication.twimg.com)를 쓴다. 비공식이라 X 가 막으면 카드가 안 뜨고 링크만 보인다.
// 인스타그램은 서버에서 가져오는 것을 인스타그램이 막고 있다(로그인 화면만 돌아옴. 특정 회사의 크롤러인 척해야 내용을 주는데, 그렇게 하지 않는다).
//   그래서 인스타그램은 이 파일을 거치지 않고, 화면에서 공식 임베드(iframe)를 "눌러서 보기"로 보여 준다.
// 안전: 사용자가 보낸 주소로 서버가 아무 곳이나 접속하지 않는다. 주소에서 글 번호(숫자)만 뽑아 고정된 주소로만 접속하고,
//       돌아온 내용은 글자 길이를 자르고 그림·영상 주소는 twimg.com 의 https 만 허용한다.
const X_HOST = /^(?:www\.|mobile\.)?(?:twitter\.com|x\.com)$/i;
const OK_MEDIA = /^https:\/\/(?:[\w-]+\.)?twimg\.com\//;
const TTL_OK = 10 * 60e3, TTL_BAD = 60e3, MAX_CACHE = 300, RATE = 40; // 이 주소로 10분 기억, 실패는 1분, 사람(IP)마다 1분에 40번까지

const token = (id) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''); // 공식 임베드가 쓰는 주소 값 계산식
const cut = (s, n) => Array.from(String(s ?? '')).slice(0, n).join('');
const media = (u) => (typeof u === 'string' && OK_MEDIA.test(u) ? u : null);

// 주소 → X 글 번호 (아니면 null)
function xId(u) {
  try {
    const p = new URL(u);
    if (!/^https?:$/.test(p.protocol) || !X_HOST.test(p.hostname)) return null;
    return p.pathname.match(/^\/(?:i\/web|\w{1,15})\/status(?:es)?\/(\d{1,20})(?:\/|$)/)?.[1] || null;
  } catch { return null; }
}

// 글 본문: 보이는 범위만 자르고, t.co 줄임 주소는 원래 주소로 바꾼다 (끝에 붙는 사진·영상 주소는 범위 밖이라 빠진다)
function bodyOf(t) {
  const range = Array.isArray(t.display_text_range) ? t.display_text_range : [0, Infinity];
  let text = Array.from(String(t.text || '')).slice(range[0], range[1]).join('');
  for (const e of t.entities?.urls || []) if (e.url && e.expanded_url) text = text.split(e.url).join(e.expanded_url);
  return cut(text, 600);
}

function card(t, id) {
  const u = t.user || {}, photos = [];
  for (const m of t.mediaDetails || []) {
    if (m.type !== 'photo') continue;
    const src = media(m.media_url_https);
    if (src) photos.push({ src, w: Number(m.original_info?.width) || 0, h: Number(m.original_info?.height) || 0, alt: cut(m.ext_alt_text, 200) });
  }
  let video = null;
  const v = t.video;
  if (v) {
    const src = (v.variants || []).find((x) => x.type === 'video/mp4' && media(x.src))?.src; // 동영상은 여러 화질이 있고 보통 첫 번째가 가장 좋다
    if (src) video = { src, poster: media(v.poster), gif: v.contentType === 'gif', w: Number(v.aspectRatio?.[0]) || 16, h: Number(v.aspectRatio?.[1]) || 9 };
  }
  const q = t.quoted_tweet;
  return {
    kind: 'x', id, url: `https://x.com/${encodeURIComponent(u.screen_name || 'i')}/status/${id}`,
    author: { name: cut(u.name, 50), handle: cut(u.screen_name, 20), avatar: media(u.profile_image_url_https), verified: !!u.is_blue_verified },
    text: bodyOf(t), created: t.created_at || null, likes: Number(t.favorite_count) || 0, replies: Number(t.conversation_count) || 0,
    photos: photos.slice(0, 4), video,
    quoted: q?.user ? { name: cut(q.user.name, 50), handle: cut(q.user.screen_name, 20), text: bodyOf(q), url: `https://x.com/${encodeURIComponent(q.user.screen_name)}/status/${q.id_str}` } : null,
  };
}

module.exports = function createUnfurl() {
  const cache = new Map(), hits = new Map();
  const limited = (ip) => { // 사람(IP)마다 1분에 RATE 번
    const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 60e3);
    list.push(now); hits.set(ip, list);
    if (hits.size > 2000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60e3)) hits.delete(k);
    return list.length > RATE;
  };
  async function fetchX(id) {
    const hit = cache.get(id);
    if (hit && Date.now() < hit.until) return hit.data;
    let data;
    try {
      const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=ko&token=${token(id)}`, { headers: { 'User-Agent': 'SiruGC-LinkPreview/1.0' }, signal: AbortSignal.timeout(6000) });
      const t = await r.json().catch(() => null);
      data = r.ok && t?.__typename === 'Tweet' ? card(t, id) : { kind: 'x', id, unavailable: true, note: cut(t?.tombstone?.text?.text, 120) || '이 글은 볼 수 없어요 (삭제됐거나 비공개예요)' };
    } catch { data = { kind: 'x', id, unavailable: true, note: '글을 불러오지 못했어요' }; }
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(id, { data, until: Date.now() + (data.unavailable && data.note === '글을 불러오지 못했어요' ? TTL_BAD : TTL_OK) });
    return data;
  }
  // GET /unfurl?u=<주소> → 카드 내용(JSON). 처리했으면 true
  function handle(req, res, ip) {
    if (!req.url.startsWith('/unfurl?')) return false;
    const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(obj));
    if (req.method !== 'GET') { json(405, { error: 'method' }); return true; }
    if (limited(ip)) { json(429, { error: 'rate' }); return true; }
    let u = '';
    try { u = new URL(req.url, 'http://x').searchParams.get('u') || ''; } catch {}
    const id = u.length <= 300 ? xId(u) : null;
    if (!id) { json(200, { kind: 'none' }); return true; }
    fetchX(id).then((d) => json(200, d)).catch(() => json(200, { kind: 'none' }));
    return true;
  }
  return { handle, xId, card };
};
