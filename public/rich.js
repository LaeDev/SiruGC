/* ================= 채팅·쪽지 글 꾸미기: 이모티콘 + 링크 + 간단한 마크다운(디스코드 비슷하게) ================= */
// 글은 화면에서만 바꿔 그린다 (서버로 가는 원문은 그대로라서 암호화한 쪽지에도 영향이 없다). HTML 로 만들지 않고 노드로만 만든다.
// 지원: **굵게**  *기울임* _기울임_  ~~취소선~~  `코드`  ```코드 블록```  > 인용  ||스포일러||  주소 자동 링크  \* 처럼 앞에 \ 를 붙이면 그대로 보임
// (이 파일은 app.js 보다 먼저 올라오므로 app.js 의 도우미(el 등)를 쓰지 않는다)
const RT_MAX_DEPTH = 4;
const rtEl = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };
const rtText = (s) => emojiNodes(s);

// 주소: http(s)로 시작하는 덩어리에서 끝의 문장 부호는 뺀다 (괄호는 짝이 안 맞을 때만)
function rtCleanUrl(raw) {
  let u = raw;
  for (;;) {
    const last = u.at(-1);
    if (/[.,!?;:'"\]}>*_~|]/.test(last)) u = u.slice(0, -1);
    else if (last === ')' && (u.match(/\)/g) || []).length > (u.match(/\(/g) || []).length) u = u.slice(0, -1);
    else break;
  }
  return u;
}
function rtLink(url, ctx) {
  let ok = false;
  try { const p = new URL(url); ok = (p.protocol === 'http:' || p.protocol === 'https:') && !!p.hostname; } catch {}
  if (!ok) return null;
  const a = rtEl('a', 'lnk');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow ugc'; a.textContent = url;
  ctx.urls?.push(url);
  return a;
}
// 한 줄 안의 꾸밈: 가장 앞에서 시작하는 표시부터 차례로 찾는다. 코드 안은 더 풀지 않는다
// (정규식의 '뒤돌아보기'(lookbehind)는 iOS Safari 16.4 부터라서 쓰지 않는다: 오래된 아이폰에서는 이 파일이 통째로 안 읽혀 채팅이 안 뜬다. 앞 글자 검사는 코드에서 한다)
const RT_INLINE = /\\([\\*_~`|>])|`([^`\n]+?)`|(https?:\/\/[^\s<>"'`]+)|\*\*(\S|\S[\s\S]*?\S)\*\*|~~(\S|\S[\s\S]*?\S)~~|\|\|(\S|\S[\s\S]*?\S)\|\||\*([^\s*]|[^\s*][\s\S]*?[^\s*])\*|_([^\s_]|[^\s_][\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu;
function rtInline(text, ctx, depth = 0) {
  const out = []; let last = 0;
  RT_INLINE.lastIndex = 0;
  const re = new RegExp(RT_INLINE.source, RT_INLINE.flags); // (재귀 호출이 서로의 lastIndex 를 건드리지 않게 매번 새로 만든다)
  let m;
  while ((m = re.exec(text))) {
    const [all, esc, code, url, bold, strike, spoiler, it1, it2] = m;
    if (it2 && m.index > 0 && /[\p{L}\p{N}_]/u.test(Array.from(text.slice(Math.max(0, m.index - 2), m.index)).at(-1))) { re.lastIndex = m.index + 1; continue; } // 낱말 한가운데의 _ (snake_case)는 기울임이 아니다
    const push = (n) => { if (m.index > last) out.push(...rtText(text.slice(last, m.index))); out.push(n); last = m.index + all.length; };
    if (esc) push(document.createTextNode(esc));
    else if (code) push(rtEl('code', 'ic', code));
    else if (url) {
      const clean = rtCleanUrl(url), a = rtLink(clean, ctx);
      if (!a) continue;
      if (m.index > last) out.push(...rtText(text.slice(last, m.index)));
      out.push(a); last = m.index + clean.length; re.lastIndex = last;
    }
    else if (depth < RT_MAX_DEPTH && (bold || strike || spoiler || it1 || it2)) {
      const inner = bold ?? strike ?? spoiler ?? it1 ?? it2;
      const kids = rtInline(inner, ctx, depth + 1);
      if (bold) push(rtEl('strong', '', ...kids));
      else if (strike) push(rtEl('s', '', ...kids));
      else if (spoiler) push(rtSpoiler(kids));
      else push(rtEl('em', '', ...kids));
    }
  }
  if (last < text.length) out.push(...rtText(text.slice(last)));
  return out;
}
function rtSpoiler(kids) {
  const s = rtEl('span', 'spoiler', ...kids);
  s.tabIndex = 0; s.setAttribute('role', 'button'); s.setAttribute('aria-label', '스포일러 (누르면 보여요)');
  const show = () => { s.classList.add('shown'); s.removeAttribute('role'); s.removeAttribute('aria-label'); s.tabIndex = -1; };
  s.addEventListener('click', (e) => { if (!s.classList.contains('shown')) { e.preventDefault(); e.stopPropagation(); show(); } }, true);
  s.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });
  return s;
}
// 글 전체 → 노드 목록(문단 <p>, 인용 <blockquote>, 코드 블록 <pre>). ctx.urls 에 글 속 링크가 모인다 (코드 안의 주소는 빠진다)
function richNodes(text, ctx = {}) {
  const out = [];
  const plain = (s) => { // 코드 블록이 아닌 부분: 줄마다 인용(> )인지 보고, 나머지는 한 문단으로
    let para = [], quote = [];
    const flushP = () => { if (para.length) { const s2 = para.join('\n'); if (s2.trim()) out.push(rtEl('p', '', ...rtInline(s2, ctx))); para = []; } };
    const flushQ = () => { if (quote.length) { out.push(rtEl('blockquote', '', ...rtInline(quote.join('\n'), ctx))); quote = []; } };
    for (const line of s.split('\n')) {
      const q = line.match(/^> ?(.*)$/);
      if (q) { flushP(); quote.push(q[1]); } else { flushQ(); para.push(line); }
    }
    flushP(); flushQ();
  };
  const FENCE = /```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = FENCE.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index));
    const code = rtEl('code', '', m[2].replace(/^\n|\n$/g, ''));
    const pre = rtEl('pre', 'cb', code); if (m[1]) pre.dataset.lang = m[1];
    out.push(pre); last = m.index + m[0].length;
  }
  if (last < text.length) plain(text.slice(last));
  if (!out.length && text) out.push(rtEl('p', '', ...rtText(text)));
  return out;
}

/* ---------- 문서(개인정보처리방침·이용약관): 제목·표·목록·굵게만 있는 마크다운 ---------- */
function mdDoc(text) {
  const out = [], lines = text.replace(/\r/g, '').split('\n');
  const inl = (s) => rtInline(s, {});
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(rtEl('h' + (h[1].length + 1), 'md-h', ...inl(h[2]))); continue; }
    if (/^\|/.test(l) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) { // 표
      const cells = (row) => row.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim());
      const t = rtEl('table', 'md-t'), head = rtEl('tr'), body = [];
      cells(l).forEach((c) => head.append(rtEl('th', '', ...inl(c))));
      i += 2;
      for (; i < lines.length && /^\|/.test(lines[i]); i++) { const tr = rtEl('tr'); cells(lines[i]).forEach((c) => tr.append(rtEl('td', '', ...inl(c)))); body.push(tr); }
      i--; t.append(rtEl('thead', '', head), rtEl('tbody', '', ...body));
      out.push(rtEl('div', 'md-tw', t)); continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) { // 목록
      const ordered = /^\s*\d+\./.test(l), ul = rtEl(ordered ? 'ol' : 'ul', 'md-l');
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) ul.append(rtEl('li', '', ...inl(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))));
      i--; out.push(ul); continue;
    }
    if (/^>\s?/.test(l)) { out.push(rtEl('blockquote', '', ...inl(l.replace(/^>\s?/, '')))); continue; }
    const para = [l]; while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,4}\s|\||\s*([-*]|\d+\.)\s|>)/.test(lines[i + 1])) para.push(lines[++i]);
    out.push(rtEl('p', '', ...inl(para.join(' '))));
  }
  return out;
}
