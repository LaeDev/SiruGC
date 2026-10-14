/* ================= 링크 카드: 채팅·쪽지에 올라온 링크 밑에 붙는 카드 ================= */
// 유튜브: 썸네일 + "대기열에 추가" 버튼(호스트·관리자에게만 보인다. 서버도 권한을 다시 확인한다).
// X(트위터): 서버가 글을 대신 가져와서(로그인 없이) 글·사진·영상을 그 자리에서 바로 보여 준다 (디스코드의 임베드처럼).
// 인스타그램: 서버에서 가져오는 것을 인스타그램이 막아서, 공식 임베드를 "눌러서 보기"로 보여 준다 (누르기 전에는 인스타그램에 접속하지 않는다).
let embedPrefs = { chat: true, dm: true }; // chat: 채팅의 X·인스타 카드, dm: 쪽지의 카드 (켜면 쪽지 속 X 링크 주소가 서버에 전달된다. 쪽지 내용은 전달되지 않는다)
try { Object.assign(embedPrefs, JSON.parse(get('embedPrefs') || '{}')); } catch {}

const YT_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/;
function ytIdOfUrl(u) {
  try { return YT_HOST.test(new URL(u).hostname) ? ytId(u) : null; } catch { return null; }
}
const urlHost = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const xIdOfUrl = (u) => (/^(?:www\.|mobile\.)?(?:twitter\.com|x\.com)$/i.test(urlHost(u)) ? new URL(u).pathname.match(/^\/(?:i\/web|\w{1,15})\/status(?:es)?\/(\d{1,20})(?:\/|$)/)?.[1] || null : null);
const igOfUrl = (u) => {
  if (!/^(?:www\.)?instagram\.com$/i.test(urlHost(u))) return null;
  const m = new URL(u).pathname.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]{5,20})(?:\/|$)/);
  return m ? { type: m[1] === 'reels' ? 'reel' : m[1], code: m[2] } : null;
};

function ytCard(id, url, ctx) {
  const btn = ctx.dm ? '' : el('button', { type: 'button', className: 'btn sm ytadd', textContent: '대기열에 추가' });
  if (btn) btn.onclick = () => {
    if (!send({ t: 'queue-add', videoId: id })) return;
    btn.disabled = true; btn.textContent = '추가했어요';
    setTimeout(() => { btn.disabled = false; btn.textContent = '대기열에 추가'; }, 3000);
  };
  const a = el('a', { className: 'eb-th', href: url, target: '_blank', rel: 'noopener noreferrer nofollow ugc', title: '유튜브에서 열기' },
    el('img', { src: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, alt: '', width: 96, height: 54, loading: 'lazy' }));
  return el('div', { className: 'embed yt' }, a, el('div', { className: 'eb-b' }, el('b', { textContent: '유튜브 영상' }), btn));
}

/* ---------- X(트위터) ---------- */
const unfurlCache = new Map(); // 글 번호 → 약속(같은 글이 여러 번 올라와도 한 번만 물어본다)
function unfurl(url) {
  const id = xIdOfUrl(url);
  if (!unfurlCache.has(id)) unfurlCache.set(id, fetch('/unfurl?u=' + encodeURIComponent(url)).then((r) => r.json()).catch(() => ({ kind: 'none' })));
  return unfurlCache.get(id);
}
// 글 속 주소는 눌러서 열 수 있게, 나머지는 글자·이모티콘으로 (마크다운으로는 풀지 않는다: 글쓴이가 쓴 * 나 _ 가 그대로 보여야 한다)
function plainLinked(text) {
  const out = []; let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = rtCleanUrl(m[0]), a = rtLink(url, {});
    if (!a) continue;
    if (m.index > last) out.push(...emojiNodes(text.slice(last, m.index)));
    out.push(a); last = m.index + url.length;
  }
  if (last < text.length) out.push(...emojiNodes(text.slice(last)));
  return out;
}
const xDate = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }); };
function paintX(root, d, url) {
  const open = (label) => el('a', { className: 'xo', href: d.url || url, target: '_blank', rel: 'noopener noreferrer nofollow ugc', textContent: label });
  if (d.unavailable) return root.replaceChildren(el('small', { className: 'eb-load', textContent: d.note }), open('X에서 열기'));
  const kids = [el('div', { className: 'xh' },
    d.author.avatar ? el('img', { className: 'xa', src: d.author.avatar, alt: '', width: 36, height: 36, loading: 'lazy', referrerPolicy: 'no-referrer' }) : '',
    el('div', { className: 'xn' }, el('b', { textContent: d.author.name }), el('small', { textContent: '@' + d.author.handle })))];
  if (d.text) kids.push(el('p', { className: 'xt' }, ...plainLinked(d.text)));
  if (d.photos.length) {
    const grid = el('div', { className: 'xm n' + d.photos.length });
    for (const p of d.photos) grid.append(el('a', { href: p.src, target: '_blank', rel: 'noopener noreferrer' }, el('img', { src: p.src + (p.src.includes('?') ? '' : '?name=medium'), alt: p.alt || '첨부한 사진', loading: 'lazy', referrerPolicy: 'no-referrer', width: p.w || undefined, height: p.h || undefined })));
    kids.push(grid);
  }
  if (d.video) {
    const v = el('video', { className: 'xv', src: d.video.src, poster: d.video.poster || '', playsInline: true, loop: !!d.video.gif, controls: !d.video.gif, preload: d.video.gif ? 'auto' : 'none', referrerPolicy: 'no-referrer' });
    v.style.aspectRatio = `${d.video.w} / ${d.video.h}`;
    if (d.video.gif) { v.autoplay = true; v.muted = true; } else v.muted = soundOff; // (소리 끄기·패닉 중이면 동영상도 소리 없이)
    kids.push(el('div', { className: 'xvw' }, v));
  }
  if (d.quoted) kids.push(el('a', { className: 'xq', href: d.quoted.url, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, el('b', { textContent: d.quoted.name }), el('small', { textContent: ' @' + d.quoted.handle }), el('span', { textContent: d.quoted.text })));
  kids.push(el('div', { className: 'xf' }, el('small', { textContent: [xDate(d.created), d.likes ? `좋아요 ${d.likes.toLocaleString('ko-KR')}` : ''].filter(Boolean).join(' · ') }), open('X에서 보기')));
  root.replaceChildren(...kids);
}
function xCard(url) {
  const root = el('div', { className: 'embed x' }, el('small', { className: 'eb-load', textContent: 'X 글을 불러오는 중…' }));
  unfurl(url).then((d) => (d.kind === 'x' ? paintX(root, d, url) : root.remove())).catch(() => root.remove());
  return root;
}

/* ---------- 인스타그램: 눌러야 공식 임베드를 불러온다 ---------- */
function igCard(ig, url) {
  const root = el('div', { className: 'embed ig' });
  const btn = el('button', { type: 'button', className: 'btn sm', textContent: '눌러서 보기' });
  btn.onclick = () => {
    const f = el('iframe', { className: 'igf', src: `https://www.instagram.com/${ig.type}/${ig.code}/embed/`, loading: 'lazy', title: '인스타그램 게시물', referrerPolicy: 'no-referrer' });
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('allowtransparency', 'true');
    root.classList.add('on'); root.replaceChildren(f);
  };
  root.append(el('div', { className: 'eb-b' }, el('b', { textContent: '인스타그램 게시물' }),
    el('small', { textContent: '누르면 인스타그램에서 게시물을 불러와요. 그러면 인스타그램도 내가 본 것을 알 수 있어요.' }),
    el('div', { className: 'row' }, btn, el('a', { className: 'btn sm', href: url, target: '_blank', rel: 'noopener noreferrer nofollow ugc', textContent: '인스타그램에서 열기' }))));
  return root;
}

// 글에서 찾은 링크들 → 붙일 카드들 (한 글에 최대 3개). ctx.dm: 쪽지
function embedNodes(urls, ctx = {}) {
  const out = [], seen = new Set(), on = ctx.dm ? embedPrefs.dm : embedPrefs.chat;
  for (const u of urls || []) {
    if (seen.has(u) || seen.size >= 3) continue;
    seen.add(u);
    const yt = ytIdOfUrl(u);
    if (yt) { out.push(ytCard(yt, u, ctx)); continue; }
    if (!on) continue;
    if (xIdOfUrl(u)) out.push(xCard(u));
    else { const ig = igOfUrl(u); if (ig) out.push(igCard(ig, u)); }
  }
  return out;
}

/* ---------- 설정: 링크 카드 켜고 끄기 ---------- */
$('#embChat').checked = embedPrefs.chat; $('#embDm').checked = embedPrefs.dm;
$('#embChat').onchange = (e) => { embedPrefs.chat = e.target.checked; set('embedPrefs', JSON.stringify(embedPrefs)); };
$('#embDm').onchange = (e) => { embedPrefs.dm = e.target.checked; set('embedPrefs', JSON.stringify(embedPrefs)); };
