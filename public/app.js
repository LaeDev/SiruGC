const $ = (s) => document.querySelector(s);
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
// randomUUID는 http(비보안) 환경에서 없어서 getRandomValues 사용
const cid = get('cid') || (() => {
  const v = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  set('cid', v); return v;
})();
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
// 이 기기가 PC인지 태블릿인지 모바일인지. 다른 사람의 참가자 목록에 표시된다
const DEVICE_LABEL = { pc: 'PC', tablet: '태블릿', mobile: '모바일' }, DEVICE_ICON = { pc: 'i-monitor', tablet: 'i-tablet', mobile: 'i-smartphone' };
function deviceKind() {
  const ua = navigator.userAgent, touch = navigator.maxTouchPoints > 1;
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (/Macintosh/.test(ua) && touch)) return 'tablet'; // iPadOS는 Mac처럼 보이지만 터치가 된다
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'mobile';
  return 'pc';
}
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<use href="#${id}"/>`; return s; };

let profileEdited = false, wantDm = false, dmOnly = false; // 입장 화면에서 '쪽지함' 버튼을 눌렀는지 / 서버가 그렇게 받아 주었는지
let ws, me, isHost = false, isAdmin = false, canQueue = false, // isHost: 호스트 또는 관리자(호스트의 일을 할 수 있음) / canQueue: 대기열에 영상을 올릴 수 있음
   sharerId = null, users = [], ended = false, joined = false, openUser = null;
// 의미색 버튼: go(초록) / blue(파랑) / stop(빨강) 중 하나만 켠다
const setTone = (b, tone) => ['go', 'blue', 'stop'].forEach((c) => b.classList.toggle(c, c === tone));
const send = (m) => { if (ws?.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };

/* ================= 아바타 만들기 ================= */
const SWATCHES = [['#ff6b8b', '분홍'], ['#ffb84d', '주황'], ['#f7e463', '노랑'], ['#6ee7a8', '초록'], ['#5cd6e0', '하늘'], ['#6fa8ff', '파랑'], ['#a98bff', '보라'], ['#f29ae0', '연분홍']];
const EMOJIS = ['😀', '😎', '🥳', '😴', '🤔', '😍', '😇', '😤', '🤖', '👻', '👽', '🦊', '🐱', '🐶', '🐼', '🐸', '🦁', '🐧', '🐙', '🦄', '🐢', '🐰', '🐻', '🍕', '🍔', '🍣', '🍜', '🍩', '🍓', '🍉', '🌵', '🌈', '⭐', '🔥', '💎', '🎧', '🎮', '🎬', '🎸', '⚽', '🚀', '🛸', '🌙', '☕'];
const FONT_EMOJI = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

let profile = { mode: 'emoji', emoji: '😎', color: SWATCHES[Math.floor(Math.random() * SWATCHES.length)][0], photo: '' };
try { Object.assign(profile, JSON.parse(get('profile') || '{}')); } catch {}
if (!/^#[0-9a-f]{6}$/i.test(profile.color)) profile.color = '#ffb84d';

// 이모티콘 + 배경색을 128px 이미지로 그린다. 사진도 같은 크기로 줄여서 서버엔 같은 형식으로 보낸다.
// 이모티콘은 기기마다 모양이 달라서 우리가 싣고 있는 Twemoji 그림으로 그린다 (모든 사람이 같은 모양으로 본다). 그림을 불러오기 전이거나 없는 이모티콘이면 기기의 글꼴로 그린다.
let avatarCache = { key: '', data: '' };
function emojiAvatar(emoji, color) {
  const key = emoji + '|' + color;
  if (avatarCache.key === key) return avatarCache.data;
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 128, 128);
  g.font = `72px ${FONT_EMOJI}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(emoji, 64, 70);
  return c.toDataURL('image/jpeg', 0.88);
}
function warmAvatar() { // Twemoji 그림으로 아바타를 만들어 두고 미리보기를 다시 그린다
  if (profile.mode === 'photo') return;
  const emoji = profile.emoji, color = profile.color, key = emoji + '|' + color;
  if (avatarCache.key === key) return;
  loadEmojiImg(emoji).then((im) => {
    const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 }), g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, 128, 128); g.drawImage(im, 16, 20, 96, 96);
    avatarCache = { key, data: c.toDataURL('image/jpeg', 0.88) };
    if (profile.emoji === emoji && profile.color === color) refresh();
  }).catch(() => {});
}
function photoAvatar(file) {
  return new Promise((ok, fail) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.width, img.height), c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => fail(new Error('이미지를 읽을 수 없어요. 다른 파일을 골라 주세요.'));
    img.src = url;
  });
}
const currentAvatar = () => (profile.mode === 'photo' && profile.photo ? profile.photo : emojiAvatar(profile.emoji, profile.color));

// 아바타가 없는 사용자(구버전 등)는 이름 첫 글자 + id 기반 색
const fallbackColor = (u) => `hsl(${[...(u.id || u.name || '?')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)} 60% 70%)`;
function paintAvatar(node, u) {
  node.style.setProperty('--c', u.color || fallbackColor(u));
  node.style.backgroundImage = u.avatar ? `url("${u.avatar}")` : '';
  node.textContent = [...(u.name || '?')][0]; // 이미지가 안 뜰 때를 위해 이름 첫 글자를 항상 넣고, 이미지가 있으면 글자는 투명
  node.classList.toggle('has-img', !!u.avatar);
  if (u.avatar && u.avatar[0] === '/') { // 서버에서 받는 그림(/a/번호)은 없을 수 있다 (프사가 없는 사람): 못 불러오면 이름 첫 글자를 보여 준다
    const im = new Image();
    im.onerror = () => { if (node.style.backgroundImage.includes(u.avatar)) { node.style.backgroundImage = ''; node.classList.remove('has-img'); } };
    im.src = u.avatar;
  }
  return node;
}
// 같은 사람의 아바타가 이미 그려진 곳(채팅 말풍선, 음성 바, 참가자 목록)을 모두 새 모습으로 바꾼다
const repaintAvatars = (u) => document.querySelectorAll(`.av[data-id="${u.id}"]`).forEach((n) => paintAvatar(n, u));
const avEl = (u) => { const e = paintAvatar(el('span', { className: 'av' }), u); if (u.id) e.dataset.id = u.id; return e; };

function refresh(pop) {
  const nm = $('#nameIn').value.trim() || '나';
  const pv = $('#preview');
  warmAvatar();
  paintAvatar(pv, { avatar: currentAvatar(), color: profile.color, name: nm });
  const sp = $('#setPreview'); if (sp) paintAvatar(sp, { avatar: currentAvatar(), color: profile.color, name: get('tok') && get('acctName') ? get('acctName') : nm });
  if (pop) { pv.classList.remove('pop'); void pv.offsetWidth; pv.classList.add('pop'); }
  const photo = profile.mode === 'photo';
  $('#tabEmoji').setAttribute('aria-selected', !photo); $('#tabEmoji').tabIndex = photo ? -1 : 0;
  $('#tabPhoto').setAttribute('aria-selected', photo); $('#tabPhoto').tabIndex = photo ? 0 : -1;
  $('#panEmoji').hidden = photo; $('#panPhoto').hidden = !photo;
  $('#photoClear').hidden = !profile.photo;
  document.querySelectorAll('#emojis button').forEach((b) => { b.setAttribute('aria-pressed', b.dataset.e === profile.emoji); b.tabIndex = b.dataset.e === profile.emoji ? 0 : -1; });
  if (!$('#emojis button[tabindex="0"]')) $('#emojis button').tabIndex = 0;
  document.querySelectorAll('#swatches .sw').forEach((b) => b.setAttribute('aria-pressed', b.dataset.c === profile.color));
  $('#colorIn').value = profile.color; $('#colorHex').textContent = profile.color.toUpperCase();
  set('profile', JSON.stringify(profile));
}

for (const e of EMOJIS) {
  const b = el('button', { type: 'button' }, ...emojiNodes(e));
  b.dataset.e = e; b.setAttribute('aria-pressed', 'false');
  b.onclick = () => { profile.mode = 'emoji'; profile.emoji = e; $('#emojiIn').value = ''; refresh(true); };
  $('#emojis').append(b);
}
for (const [c, name] of SWATCHES) {
  const b = el('button', { type: 'button', className: 'sw', title: name }, icon('i-check'));
  b.dataset.c = c; b.style.setProperty('--c', c); b.setAttribute('aria-label', name); b.setAttribute('aria-pressed', 'false');
  b.onclick = () => { profile.color = c; refresh(true); };
  $('#swatches .picker').before(b);
}
$('#colorIn').oninput = (e) => { profile.color = e.target.value; refresh(); };
$('#emojis').setAttribute('role', 'group'); $('#emojis').setAttribute('aria-label', '이모티콘 (방향키로 움직여요)');
$('#emojis').addEventListener('keydown', (e) => {
  const keys = { ArrowLeft: -1, ArrowRight: 1, Home: 'home', End: 'end', ArrowUp: 'up', ArrowDown: 'down' };
  if (!(e.key in keys)) return;
  const btns = [...$('#emojis').querySelectorAll('button')], i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  const cols = btns.filter((b) => b.offsetTop === btns[0].offsetTop).length || 1, k = keys[e.key];
  const n = k === 'home' ? 0 : k === 'end' ? btns.length - 1 : k === 'up' ? i - cols : k === 'down' ? i + cols : i + k;
  if (n < 0 || n >= btns.length) return;
  e.preventDefault(); btns[n].focus(); btns[n].click();
});
$('#emojiIn').oninput = (e) => {
  // 입력창에 이모티콘이 하나라도 있으면 첫 글자(그래핌)만 쓴다
  const chars = Intl.Segmenter ? [...new Intl.Segmenter().segment(e.target.value)].map((s) => s.segment) : [...e.target.value];
  const first = chars.find((s) => /\p{Extended_Pictographic}/u.test(s));
  e.target.value = first || '';
  if (first) { profile.mode = 'emoji'; profile.emoji = first; refresh(true); }
};
$('#nameIn').oninput = () => refresh();

const tabs = [$('#tabEmoji'), $('#tabPhoto')];
tabs.forEach((t, i) => {
  t.onclick = () => { profile.mode = i ? 'photo' : 'emoji'; refresh(true); };
  t.onkeydown = (e) => { // 좌우 방향키로 탭 이동
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const n = tabs[1 - i]; n.click(); n.focus();
  };
});
$('#photoBtn').onclick = () => $('#photoFile').click();
$('#photoClear').onclick = () => { profile.photo = ''; profile.mode = 'emoji'; refresh(true); };
$('#photoFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { profile.photo = await photoAvatar(f); profile.mode = 'photo'; $('#joinMsg').textContent = ''; refresh(true); }
  catch (err) { $('#joinMsg').textContent = err.message; }
};

/* ================= 입장 / 연결 ================= */
$('#nameIn').value = get('name') || '';
$('.skip').setAttribute('href', '#nameIn'); $('.skip').textContent = '닉네임 입력으로 건너뛰기';
refresh();
// 입장 버튼은 둘: '입장하기'(방)와 '쪽지함'(방에 들어가지 않고 쪽지만). 어느 쪽을 눌렀는지는 wantDm에 담는다
const setJoinBusy = (on) => { $('#enter').disabled = $('#inboxBtn').disabled = $('#gDm').disabled = $('#gRoom').disabled = on; $('#gDm').toggleAttribute('aria-busy', on && wantDm); $('#gRoom').toggleAttribute('aria-busy', on && !wantDm); if (!on) { $('#enter').textContent = '입장하기'; $('#inboxBtn').lastChild.textContent = '쪽지함'; } else (wantDm ? $('#inboxBtn').lastChild : $('#enter')).textContent = '들어가는 중'; };
$('#enter').onclick = () => { wantDm = false; };

/* ---------- 입장 화면의 단계: 로그인·가입 → 쪽지/그룹방 → (프로필을 아직 안 정했으면) 프로필 설정 ----------
   주소에 ?step=profile 이 있으면 예전처럼 한 화면(닉네임·프로필·두 입장 버튼)으로 바로 연다 (자동 점검 도구가 쓴다). */
const JOIN_DIRECT = new URLSearchParams(location.search).get('step') === 'profile';
let joinStepName = '', joinDest = 'gc', joinGuest = false; // joinDest: 'gc' | 'dm' | null(프로필만 바꾸는 중)
const profileDone = () => JOIN_DIRECT || (loggedIn() && get('profDone') === get('acctName')); // 이 기기에서 이 계정의 프로필을 이미 정했는가
function joinStep(step, focus) {
  joinStepName = step;
  const f = $('#joinForm'); f.dataset.step = step;
  $('#gateAuth').hidden = step !== 'auth'; $('#gatePick').hidden = step !== 'pick';
  const acct = loggedIn(), direct = JOIN_DIRECT;
  $('#pickWho').textContent = get('acctName') || '';
  // 프로필 단계: 고른 곳에 맞는 버튼만 보인다 (직접 열기에서는 둘 다)
  $('#enter').hidden = !(direct || !acct || joinDest === 'gc');
  $('#inboxBtn').hidden = $('#inboxNote').hidden = !(direct || (acct && joinDest === 'dm')); // (직접 열기에서는 로그인 전에도 쪽지함 버튼이 보이고, 누르면 로그인 창이 열린다)
  $('#profileOk').hidden = !(acct && !direct && joinDest === null);
  $('#joinBack').hidden = direct;
  if (step === 'profile' && !direct) $('#makeWrap').open = true; // 프로필 설정 단계에서는 폰에서도 꾸미기 칸을 펼쳐 둔다
  $('#acctBox').hidden = !direct; // 로그인·로그아웃은 앞 단계에서 한다
  $('#meLede').textContent = joinDest === null ? '프로필을 바꿔 보세요.' : acct ? '처음 한 번만 정하면 돼요. 먼저 나를 꾸며 보세요.' : '닉네임을 정하고 나를 꾸며 보세요.';
  const skip = { auth: ['#gLogin', '로그인 버튼으로 건너뛰기'], pick: ['#gDm', '쪽지·그룹방 선택으로 건너뛰기'], profile: ['#nameIn', '닉네임 입력으로 건너뛰기'] }[step];
  $('.skip').setAttribute('href', skip[0]); $('.skip').textContent = skip[1];
  if (focus) $(skip[0] === '#nameIn' && acct ? '#enter:not([hidden]), #inboxBtn:not([hidden]), #profileOk:not([hidden])' : skip[0])?.focus();
}
// 로그인 상태에 맞는 단계로 (로그인하면 선택 화면, 로그아웃하면 처음). 프로필 단계를 보는 중이면 그대로 둔다
function joinAuto(focus) {
  if (JOIN_DIRECT) return joinStep('profile');
  if (loggedIn()) return joinStep(joinStepName === 'profile' ? 'profile' : 'pick', focus);
  joinStep(joinStepName === 'profile' && joinGuest ? 'profile' : 'auth', focus);
}
// 쪽지/그룹방을 골랐을 때: 프로필을 아직 안 정했으면 먼저 정하고, 정했으면 바로 들어간다
function joinGo(dest) {
  joinDest = dest; wantDm = dest === 'dm';
  if (profileDone()) return $('#joinForm').requestSubmit();
  $('#joinMsg').textContent = ''; joinStep('profile', true);
}
$('#gLogin').onclick = () => openAuth('login');
$('#gSignup').onclick = () => openAuth('signup');
$('#gGuest').onclick = () => { joinGuest = true; joinDest = 'gc'; $('#joinMsg').textContent = ''; joinStep('profile', true); };
$('#gDm').onclick = () => joinGo('dm');
$('#gRoom').onclick = () => joinGo('gc');
$('#gProfile').onclick = () => { joinDest = null; $('#joinMsg').textContent = ''; joinStep('profile', true); };
$('#gLogout').onclick = () => logout(false);
$('#profileOk').onclick = () => { set('profDone', get('acctName')); joinDest = 'gc'; joinStep('pick', true); };
$('#joinBack').onclick = () => { joinGuest = false; $('#joinMsg').textContent = ''; joinStepName = ''; joinAuto(true); };
$('#inboxBtn').onclick = () => {
  if (!loggedIn()) return openAuth('login', '쪽지함은 로그인한 사람만 쓸 수 있어요.'); // 쪽지는 로그인한 계정끼리만
  wantDm = true; $('#joinForm').requestSubmit();
};
// 프로필 꾸미기: 넓은 화면에서는 펼쳐 두고, 폰에서는 접어 둔다. 직접 고쳤을 때만 계정의 프로필을 바꾼다
$('#makeWrap').open = matchMedia('(min-width:901px)').matches;
for (const ev of ['click', 'input']) $('#makeWrap .make').addEventListener(ev, () => { profileEdited = true; });

// 서버의 닉네임 규칙과 같다 (서버가 최종 판단)
const NICK_RE = /^[\uAC00-\uD7A3\u3131-\u3163\u3165-\u318EA-Za-z0-9 _.\-]+$/, NICK_LETTER = /[\uAC00-\uD7A3\u3131-\u3163\u3165-\u318EA-Za-z0-9]/;
const NAME_HELP = '닉네임에는 한글, 영문, 숫자, 공백, _ - . 만 쓸 수 있어요.';
$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const name = loggedIn() ? get('acctName') : $('#nameIn').value.replace(/\s+/g, ' ').trim();
  if (!name) { $('#joinMsg').textContent = '닉네임을 입력해 주세요.'; return $('#nameIn').focus(); }
  if (!loggedIn() && (!NICK_RE.test(name) || !NICK_LETTER.test(name))) { $('#joinMsg').textContent = NAME_HELP; return $('#nameIn').focus(); }
  $('#joinMsg').textContent = '';
  if (loggedIn() && joinStepName === 'profile') set('profDone', name); // 프로필 단계를 거쳤으면 다음부터는 묻지 않는다
  if (!loggedIn()) set('name', name);
  setJoinBusy(true);
  connect(name);
};
// 쪽지함에서 방에 들어가기: 화면을 새로 열고 같은 닉네임으로 바로 입장한다
$('#toRoom').onclick = () => { try { sessionStorage.setItem('autoJoin', '1'); } catch {} location.reload(); };

// 서버의 도배 방지(채팅 0.3초, 쪽지 0.4초 간격)에 걸리면 메시지가 말없이 사라진다. 연달아 보내는 글(첨부 포함)은 간격을 두고 차례로 보낸다.
const paceAt = { chat: 0, dm: 0 };
function sendPaced(kind, msg) {
  if (ws?.readyState !== 1) return false;
  const gap = kind === 'dm' ? 450 : 350, now = Date.now(), at = Math.max(now, paceAt[kind] + gap);
  if (at - now > 5000) return false; // 너무 많이 밀렸으면 받지 않는다
  paceAt[kind] = at;
  if (at === now) return send(msg);
  setTimeout(() => send(msg), at - now);
  return true;
}
// 연결이 끊겨도 서버가 살아 있으면 화면을 그대로 두고 조용히 다시 연결한다. 서버가 응답하지 않을 때만 '서버가 꺼졌습니다'를 보여 준다.
let joinNote = '', nameTaken = '', nameBad = false, joinName = '', resumeInfo = null, reconnecting = false, firstJoined = false, downSince = 0, probeFails = 0, retryN = 0, attemptTimer = 0, hbTimer = 0, lastHeard = 0, pingAt = 0, tickAt = 0, netTimer = 0;
const BUILD = document.querySelector('meta[name=build]')?.content || ''; // 이 화면이 받은 파일의 버전 (서버가 index.html에 심어 준다)
{ const v = $('#verNote'); if (v) v.textContent = '화면 버전 ' + (BUILD || '알 수 없음') + ' · 기능이 안 보이면 새로고침(앱이면 완전히 닫았다 다시 열기)'; }
// 끊김·새 버전 띠는 헤더 아래에 뜬다 (폰에서는 헤더가 두 줄이라 높이를 재서 정한다)
const setTopH = () => { const h = $('.top')?.offsetHeight; document.documentElement.style.setProperty('--top-h', (h ? h + 8 : 12) + 'px'); };
const showNet = (t) => { const n = $('#net'); setTopH(); n.textContent = t; n.hidden = false; };
const hideNet = () => { clearTimeout(netTimer); $('#net').hidden = true; };
// 서버가 새 버전이라고 알려 오면(열어 둔 탭·설치한 앱이 옛 화면일 때) 새로고침 버튼을 보여 준다. 음성·공유를 쓰는 중에 멋대로 새로고침하지는 않는다.
function offerUpdate(latest) {
  if ($('#upd')) return;
  try { if (latest && sessionStorage.getItem('updHide') === latest) return; } catch {} // "나중에"를 누른 같은 버전이면 다시 띄우지 않는다
  setTopH();
  document.body.append(el('div', { id: 'upd', role: 'status' }, '새 버전이 나왔어요.',
    el('button', { className: 'btn primary', type: 'button', textContent: '새로고침', onclick: () => forceRefresh() }),
    el('button', { className: 'btn link', type: 'button', id: 'updLater', textContent: '나중에', onclick: () => { try { sessionStorage.setItem('updHide', latest || '1'); } catch {} $('#upd')?.remove(); } })));
}

function connect(name) {
  joinName = name;
  const prev = ws; // 아직 연결 중이던 옛 소켓이 나중에 열려서 새 연결을 가로채지 못하게 먼저 닫는다
  if (prev) { prev.onopen = prev.onmessage = prev.onclose = null; try { prev.close(4000, 'replaced'); } catch {} }
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws = sock;
  sock.onopen = () => send({ t: 'join', name, avatar: currentAvatar(), color: profile.color, device: deviceKind(), dmOnly: wantDm || undefined, cid, token: get('tok') || undefined, profileEdited: profileEdited || undefined, resume: resumeInfo, lastSeq: chatSeq || undefined });
  sock.onmessage = (e) => { lastHeard = Date.now(); handle(JSON.parse(e.data)); };
  sock.onclose = () => {
    if (ws !== sock || ended) return; // 이미 새 연결로 바뀐 옛 소켓의 이벤트는 무시
    clearInterval(hbTimer);
    if (joined && nameTaken) return location.reload(); // 끊긴 사이에 내 닉네임을 다른 사람이 가져갔다: 입장 화면으로 돌아가 다시 정한다
    if (joined) return reconnectSoon();
    setJoinBusy(false);
    $('#joinMsg').textContent = joinNote || (nameBad ? NAME_HELP : nameTaken ? `"${nameTaken}" 닉네임은 지금 방에 있는 다른 사람이 쓰고 있어요. 다른 닉네임으로 들어와 주세요.` : '서버에 연결하지 못했어요. 잠시 뒤 다시 눌러 주세요.');
    if ((nameTaken || nameBad) && !joinNote) $('#nameIn').focus();
    joinNote = ''; nameTaken = ''; nameBad = false;
  };
}

// 앱이 직접 15초마다 신호를 보낸다: 프록시나 폰 절전 때문에 소리 없이 죽은 연결을 일찍 알아내고, 중간에서 연결이 끊기는 것도 막는다.
// '마지막으로 소식 들은 지 오래됨'이 아니라 '보낸 신호에 답이 45초 넘게 없음'으로 판단한다.
// (백그라운드 탭·절전으로 타이머가 몰아서 늦게 돌면, 멀쩡한 연결인데도 소식이 오래돼 보여서 스스로 끊는 일이 있었다)
// 폰·태블릿은 와이파이↔데이터를 갈아타거나 터널을 지날 때 연결이 소리 없이 죽는 일이 잦고 iPhone 은 네트워크 변경 신호도 없어서, 신호를 더 자주 보내고 답이 없으면 더 빨리 버린다.
// 또 폰은 서버에 한참 못 닿아도(신호가 다시 잡히는 동안) "서버가 꺼졌습니다"로 포기하지 않고 계속 시도한다 (PC 는 12초).
const MOBILE_NET = deviceKind() !== 'pc';
const HB_MS = MOBILE_NET ? 8000 : 15000, HB_DEAD_MS = MOBILE_NET ? 22000 : 45000, GIVE_UP_MS = MOBILE_NET ? 90000 : 12000;
function startHeartbeat() {
  clearInterval(hbTimer); lastHeard = tickAt = Date.now(); pingAt = 0;
  hbTimer = setInterval(hbCheck, HB_MS);
}
function hbCheck() {
  if (ended || reconnecting) return;
  const now = Date.now(), slept = now - tickAt > HB_MS * 2.3; tickAt = now; // 타이머가 한참 늦게 돌았다 = 백그라운드·절전이었다
  const waiting = pingAt > lastHeard; // 지난 신호에 아직 답이 없음
  if (waiting && !slept) { if (now - pingAt > HB_DEAD_MS) return dropSocket('hb-silent ' + Math.round((now - pingAt) / 1000) + 's'); return; }
  pingAt = now;
  if (!send({ t: 'ping' })) dropSocket('hb-send');
}
// 지금 연결이 살아 있는지 짧게 확인한다 (폰이 깨어났을 때, 인터넷이 바뀌었을 때)
function probe(why, waitMs = 6000) { // waitMs: 답을 기다리는 시간. 네트워크가 바뀐 직후에는 옛 연결이 이미 죽었을 가능성이 커서 짧게 기다린다
  if (!joined || ended) return;
  if (reconnecting) return scheduleAttempt(0);
  if (!send({ t: 'ping' })) return dropSocket(why + '-send');
  const before = lastHeard;
  setTimeout(() => { if (!ended && !reconnecting && lastHeard === before) dropSocket(why + '-noreply'); }, waitMs);
}
function dropSocket(why = 'drop') { // 죽은 소켓은 close()를 불러도 한참 뒤에야 끝나므로 기다리지 않고 버린다. 사유는 서버 로그에 남는다
  const old = ws;
  if (old) { old.onclose = old.onmessage = null; try { old.close(4001, String(why).slice(0, 80)); } catch {} }
  reconnectSoon();
}
function scheduleAttempt(ms) { clearTimeout(attemptTimer); attemptTimer = setTimeout(attempt, ms); }
function reconnectSoon() {
  if (ended) return;
  if (!reconnecting) { // 잠깐 끊겼다 바로 돌아오는 건 알리지 않는다 (2.5초가 넘을 때만 안내)
    reconnecting = true; downSince = Date.now(); probeFails = 0; retryN = 0;
    clearTimeout(netTimer); netTimer = setTimeout(() => reconnecting && showNet('연결이 끊겼어요. 다시 연결하는 중…'), 2500);
  }
  scheduleAttempt(retryN === 0 ? 0 : Math.min(500 * 2 ** retryN, 4000));
}
async function attempt() {
  if (ended) return;
  retryN++;
  if (navigator.onLine === false) { showNet('인터넷 연결이 끊겼어요. 연결되면 자동으로 다시 시도해요…'); return scheduleAttempt(1500); }
  if (Date.now() - downSince > 2500) showNet('연결이 끊겼어요. 다시 연결하는 중…');
  // 서버가 살아 있는지 먼저 본다. 12초 넘게 계속 응답이 없을 때만 서버가 꺼진 것으로 본다 (폰이 터널·엘리베이터에서 잠깐 끊긴 것까지 '서버가 꺼졌다'고 하지 않도록)
  const alive = await fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
  if (ended) return;
  if (!alive) { if (++probeFails >= 3 && Date.now() - downSince > GIVE_UP_MS) return showServerDown(); return scheduleAttempt(Math.min(1000 * Math.ceil(probeFails / 3), 4000)); } // 계속 안 되면 간격을 조금씩 늘려 배터리를 아낀다
  probeFails = 0;
  connect(joinName);
  scheduleAttempt(MOBILE_NET ? 5000 : 8000); // 입장 응답(joined)이 안 오면 다시 시도. joined가 오면 이 타이머를 지운다 (새 네트워크에서 연결이 멈춰 버리는 일이 있어 폰은 더 짧게)
}
// 탭을 정말 닫을 때는 '나갑니다'를 알려 유예(끊긴 사람을 잠깐 남겨 두는 시간) 없이 바로 나간다. 폰이 백그라운드로 가는 것(persisted)은 제외
// 폰·태블릿은 제외: 화면을 끄거나 앱을 바꿀 때도 이 이벤트가 오는데, 그때는 서버가 유예 시간 동안 자리를 남겨 두어야 알림을 확인하고 돌아올 수 있다
addEventListener('pagehide', (e) => { if (!e.persisted && joined && !ended && deviceKind() === 'pc') send({ t: 'bye' }); });
// 폰이 절전에서 깨어나거나 인터넷이 돌아오면 기다리지 않고 바로 확인한다
addEventListener('online', () => probe('online', 2500));
addEventListener('pageshow', (e) => e.persisted && probe('pageshow'));
navigator.connection?.addEventListener?.('change', () => probe('netchange', 2500)); // 와이파이↔데이터 전환
document.addEventListener('visibilitychange', () => { if (!document.hidden) probe('wake'); }); // 깨어났는데 6초 안에 답이 없으면 죽은 연결

/* ================= 서버가 꺼졌을 때 ================= */
// 서버가 꺼지거나 연결이 끊기면 음성·화면 공유·영상을 모두 멈추고 안내 페이지를 바로 보여 준다.
// 서버가 정상 종료하면 'shutdown' 메시지가 먼저 오고, 갑자기 죽으면 연결 끊김으로 알게 된다.
let serverDown = false;
function stopEverything() {
  stopLocal();            // 내 화면 공유(화면 캡처 중지)
  leaveVoice();           // 마이크 끄기 + 음성 연결 정리
  [...pcs.keys()].forEach(closePc); // 다른 사람의 공유 화면 연결
  screenEl.srcObject = null;
  if (player) { try { player.stopVideo(); player.destroy(); } catch {} player = null; playerReady = false; }
}
// 끊겼다가 같은 세션으로 돌아왔을 때: 방 상태만 새로 맞추고 열려 있는 것(음성, 공유, 대화창)은 건드리지 않는다
function applyResume(m, wasReconnecting) {
  uploadToken = m.upload || uploadToken;
  isHost = !!(m.me.host || m.me.admin); isAdmin = !!m.me.admin; canQueue = !!m.me.canQueue; me = m.me.id; users = m.users.concat(m.me);
  document.body.classList.toggle('is-host', isHost);
  $('#banBox').hidden = !isHost; renderBans(m.bans); renderUsers();
  voiceList = m.voice || []; syncVoicePeers(); renderVoice();
  queue = m.queue || []; renderQueue();
  if (m.yt) applyYt(m.yt);
  sharerId = m.sharer || null;
  // 오래 끊겨 있는 동안 서버가 내 음성·공유를 정리했으면 이쪽도 맞춘다 (마이크가 켜진 채 방에는 없는 상태가 되지 않게)
  if (inVoice() && !voiceList.some((v) => v.id === me)) { leaveVoice(); sys('오래 끊겨 있어서 음성에서 나갔어요. 필요하면 다시 참가해 주세요.'); }
  if (localStream && sharerId !== me) { stopLocal(); sys('오래 끊겨 있어서 화면 공유가 멈췄어요.'); }
  if (sharerId && sharerId !== me && pcs.has(sharerId) && !['connected', 'connecting', 'new'].includes(pcs.get(sharerId).connectionState)) { closePc(sharerId); shareTry = 0; shareStatus = ''; } // 네트워크가 바뀌며 죽은 공유 화면 연결은 새로 맺는다
  if (sharerId && sharerId !== me && !pcs.has(sharerId)) requestShare();
  for (const [id, v] of [...vpcs]) if (!['connected', 'connecting', 'new'].includes(v.pc.connectionState)) retryPeer(id, v.pc); // 죽은 음성 연결도 새로
  renderStage(); dmResync(m);
  send({ t: 'vis', v: !document.hidden });
  const got = m.backlog ? showBacklog(m.backlog) : 0;
  if (wasReconnecting && Date.now() - downSince > 3000 && !m.backlog) sys('다시 연결됐어요. 끊겨 있던 동안의 채팅은 볼 수 없어요.');
  else if (wasReconnecting && Date.now() - downSince > 3000 && !got) sys('다시 연결됐어요.');
}
function showServerDown() {
  if (serverDown) return;
  serverDown = ended = true;
  clearTimeout(attemptTimer); clearInterval(hbTimer); hideNet();
  try { stopEverything(); } catch (e) { console.warn(e); }
  const offline = navigator.onLine === false; // 내 인터넷이 끊긴 경우는 서버 탓이 아니니 다르게 안내
  const sub = el('p', { className: 'sub', role: 'status', textContent: '연결이 끊겨서 음성, 화면 공유, 영상을 모두 멈췄어요.' });
  const retry = el('button', { className: 'btn primary', type: 'button', textContent: '다시 연결해 보기', onclick: () => location.reload() });
  document.title = offline ? '인터넷 연결이 끊겼어요' : '서버가 꺼졌습니다';
  document.body.replaceChildren(el('main', { className: 'end' },
    el('h1', { textContent: offline ? '인터넷 연결이 끊겼어요' : '서버가 꺼졌습니다' }),
    el('p', { textContent: offline ? '연결이 돌아오면 아래 버튼을 눌러 주세요.' : '다음에 다시 돌아와주세요!' }),
    sub, retry));
  // 서버가 다시 켜지면 알려 준다 (자동으로 새로고침하지는 않는다)
  const timer = setInterval(() => fetch('/healthz', { cache: 'no-store' }).then((r) => {
    if (!r.ok) return;
    clearInterval(timer);
    sub.textContent = '서버가 다시 켜졌어요. 아래 버튼을 눌러 다시 들어오세요.';
    retry.focus();
  }).catch(() => {}), 5000);
}

// 서버 메시지 처리기. 기능별 파일이 handlers['타입'] 에 자기 처리기를 등록한다.
const handlers = {};
const handle = (m) => handlers[m.t]?.(m);

Object.assign(handlers, {
  joined(m) {
    clearTimeout(attemptTimer);
    resumeInfo = { id: m.me.id, secret: m.resume }; uploadToken = m.upload || '';
    if (m.token) set('tok', m.token); // 서버가 3일마다 바꿔 주는 새 로그인 토큰
    if (m.me.acct) { set('acctName', m.me.name); myPrev = m.me.prev || ''; acctUi(); }
    const wasReconnecting = reconnecting;
    reconnecting = false; hideNet(); startHeartbeat();
    if (m.build && BUILD && m.build !== BUILD) offerUpdate(m.build);
    if (m.resumed) return applyResume(m, wasReconnecting); // 끊기기 전 세션을 그대로 이어받음: 음성·공유·화면 상태 유지
    if (firstJoined) { // 오래 끊겼거나 서버가 다시 켜져서 새로 입장함: 서버가 음성·공유 상태를 잊었으니 이쪽도 정리
      try { stopEverything(); } catch (e) { console.warn(e); }
      sys('연결이 오래 끊겨서 음성과 화면 공유를 껐어요. 필요하면 다시 켜 주세요.');
    }
    firstJoined = true;
    joined = true;
    me = m.me.id; isHost = !!(m.me.host || m.me.admin); isAdmin = !!m.me.admin; canQueue = !!m.me.canQueue; users = m.users.concat(m.me);
    document.body.classList.toggle('is-host', isHost);
    dmOnly = !!m.dmOnly; // 서버가 쪽지만 쓰는 연결로 받아 줬을 때만 (옛 서버라면 방으로 들어온 것이니 방 화면 그대로)
    document.body.classList.toggle('dm-only', dmOnly); $('#toRoom').hidden = !dmOnly;
    $('.skip').setAttribute('href', dmOnly ? '#dmNew' : '#chatIn'); $('.skip').textContent = dmOnly ? '새 쪽지 버튼으로 건너뛰기' : '채팅 입력으로 건너뛰기';
    $('#join').hidden = true; $('#app').hidden = false;
    $('#banBox').hidden = !isHost;
    renderBans(m.bans); renderUsers();
    rtcConfig.iceServers = m.ice || rtcConfig.iceServers; voiceList = m.voice || [];
    queue = m.queue || []; renderQueue();
    dmInit(m); notifyInit(m);
    if (m.yt) applyYt(m.yt);
    if (m.sharer) { sharerId = m.sharer; requestShare(); }
    renderStage();
    if (dmOnly) { if (!logoNow()) $('.logo .t').textContent = '쪽지함'; showTab('dm'); tourMaybe('dm'); notifAskSoon(); return; } // 방 안내와 채팅 입력 칸은 쓰지 않는다
    if (m.backlog) showBacklog(m.backlog); else showBacklog([]);
    sys(isHost ? '이 방의 호스트예요. 참가자 탭에서 사람을 누르면 대기열 허락·호스트 넘기기·강퇴·밴 메뉴가 열려요.' : m.me.acct ? '입장했어요. 참가자 탭에서 사람을 누르면 쪽지를 보낼 수 있어요.' : '입장했어요. 쪽지는 로그인한 사람끼리만 주고받을 수 있어요. (설정 → 계정)');
    if (matchMedia('(pointer:fine)').matches) $('#chatIn').focus();
    tourMaybe('room'); // 처음이면 그룹방 안내
    notifAskSoon(); // 로그인한 사람에게는 쪽지 알림 권한도 (안내가 끝난 뒤) // 터치 기기에선 키보드가 갑자기 올라오지 않게
  },
  'name-invalid'() { nameBad = true; }, // 서버가 닉네임 규칙에 안 맞다고 거절 (곧 연결을 닫는다)
  'name-taken'(m) { nameTaken = m.name; }, // 곧 서버가 연결을 닫는다. 닫힘 처리에서 안내를 보여 준다
  queue(m) { queue = m.queue; renderQueue(); },
  'user-join'(m) {
    const at = users.findIndex((x) => x.id === m.user.id); // 끊겨 있던 자리로 돌아온 경우: 새 사람이 아니라 갱신
    if (at >= 0) users[at] = m.user; else users.push(m.user);
    renderUsers(); dmRefresh();
    if (at < 0 && !(m.user.uid && users.some((x) => x.id !== m.user.id && x.uid === m.user.uid))) sys(m.user.name + ' 님이 들어왔어요.'); // 같은 계정의 다른 기기가 더 들어온 것은 알리지 않는다
  },
  'user-update'(m) { // 호스트가 바뀌었거나 대기열 추가 권한이 바뀌었다
    const at = users.findIndex((x) => x.id === m.user.id);
    if (at < 0) return;
    users[at] = m.user;
    repaintAvatars(m.user);
    if (m.user.id === me) { isHost = !!(m.user.host || m.user.admin); isAdmin = !!m.user.admin; canQueue = !!m.user.canQueue; document.body.classList.toggle('is-host', isHost); $('#banBox').hidden = !isHost; renderQueue(); }
    renderUsers();
  },
  host(m) { sys(m.id === me ? '이제 내가 이 방의 호스트예요.' : m.name + ' 님이 호스트가 됐어요.'); },
  'queue-denied'() { $('#qMsg').textContent = '대기열에 올리려면 호스트의 허락이 필요해요. 호스트에게 부탁해 보세요.'; },
  'user-away'(m) { const u = users.find((x) => x.id === m.id); if (u) { u.away = m.away; renderUsers(); } },
  'user-leave'(m) {
    const u = users.find((x) => x.id === m.id);
    users = users.filter((x) => x.id !== m.id); closePc(m.id); closeVpc(m.id);
    if (openUser === m.id) openUser = null;
    renderUsers(); dmRefresh();
    if (u && !m.quiet && !(u.uid && users.some((x) => x.uid === u.uid))) sys(u.name + ' 님이 나갔어요.'); // 시간이 지나 자동으로 정리된 사람, 같은 계정의 다른 기기가 남아 있는 경우는 알리지 않는다
  },
  chat: (m) => chatMsg(m),
  replaced() { // 같은 기기의 다른 탭(또는 새로 연 화면)이 이 자리를 가져갔다
    ended = true; stopEverything();
    document.title = '다른 곳에서 접속했어요';
    document.body.replaceChildren(el('main', { className: 'end' },
      el('h1', { textContent: '다른 곳에서 접속했어요' }),
      el('p', { textContent: '같은 기기의 다른 탭에서 이 방에 들어와서, 이 화면은 닫혔어요.' }),
      el('button', { className: 'btn primary', type: 'button', textContent: '여기서 다시 들어오기', onclick: () => location.reload() })));
  },
  yt: (m) => applyYt(m),
  'share-start'(m) {
    sharerId = m.id; renderUsers(); renderStage();
    if (m.id !== me) requestShare();
  },
  'share-stop'() { sharerId = null; remoteShareEnded(); renderUsers(); renderStage(); },
  'share-denied'() { stopLocal(); sys('이미 다른 사람이 화면을 공유하고 있어요.'); },
  // 신호는 한 줄로 차례대로 처리한다. 한 건이 영영 안 끝나도(닫힌 연결에서 생김) 뒤의 신호가 모두 막히지 않게 10초가 넘으면 넘어간다
  rtc(m) { chain = chain.then(() => Promise.race([onRtc(m.from, m.data), new Promise((_, no) => setTimeout(no, 10000, new Error('rtc 신호 처리 시간 초과')))])).catch(console.warn); },
  bans: (m) => renderBans(m.bans),
  shutdown: () => showServerDown(),
  banned(m) {
    ended = true; stopEverything();
    document.body.replaceChildren(el('main', { className: 'end' },
      el('h1', { textContent: m.kick ? '방에서 나가게 됐어요' : '이 방에 들어올 수 없어요' }),
      el('p', { textContent: m.kick ? '호스트가 내보냈어요.' : '호스트가 이 방에서 차단했어요.' })));
  },
});

document.addEventListener('focusout', (e) => { if (e.target.classList?.contains('vol') && usersPending) renderUsers(); });
/* ================= 참가자 / 밴 ================= */
const tag = (t, soft) => el('span', { className: 'tag' + (soft ? ' soft' : ''), textContent: t });
let usersPending = false;
// 같은 계정으로 들어온 여러 기기(폰·태블릿·PC)는 한 사람으로 합쳐서 보여 준다. 게스트는 기기마다 따로다.
function userGroups() {
  const out = [], byUid = new Map();
  for (const u of users) {
    const g = u.uid && byUid.get(u.uid);
    if (g) { g.all.push(u); continue; }
    const g2 = { all: [u] }; out.push(g2); if (u.uid) byUid.set(u.uid, g2);
  }
  for (const g of out) g.primary = g.all.find((x) => x.id === me) || g.all.find((x) => voiceList.some((v) => v.id === x.id)) || g.all.find((x) => x.host) || g.all[0];
  return out;
}
function renderUsers() {
  renderVoiceBar();
  if (document.activeElement?.classList?.contains('vol')) { usersPending = true; return; } // 슬라이더를 끄는 중에는 다시 그리지 않는다
  usersPending = false;
  const groups = userGroups();
  $('#dot-users').textContent = groups.length;
  const ul = $('#users'); ul.replaceChildren();
  for (const g of groups) {
    const u = g.primary, isMe = g.all.some((x) => x.id === me);
    const li = el('li');
    const canOpen = !isMe;                                    // 나를 뺀 모두에게 메뉴 (쪽지는 로그인한 사람끼리만)
    const canBan = isHost && !u.host && !u.admin;             // 호스트(와 관리자)만 강퇴·밴. 호스트·관리자는 대상이 아님
    const row = el(canOpen ? 'button' : 'div', { className: 'urow' });
    // 첫 줄은 닉네임, 그 아래 줄에 상태 꼬리표를 모은다 (여러 개여도 닉네임이 줄어들지 않고, 넘치면 다음 줄로)
    const tags = el('span', { className: 'tags' });
    if (g.all.every((x) => x.away)) { row.classList.add('away'); tags.append(el('span', { className: 'tag soft', title: '연결이 끊겼어요. 돌아오면 그대로 이어져요', textContent: '자리 비움' })); }
    if (u.host) tags.append(tag('호스트')); else if (u.admin) tags.append(tag('관리자')); else if (u.canQueue) tags.append(tag('대기열 가능', true));
    if (u.acct && !u.admin) tags.append(tag('계정', true));
    if (u.id === sharerId) tags.append(tag('공유 중', true));
    for (const x of g.all) if (DEVICE_LABEL[x.device]) tags.append(el('span', { className: 'tag soft dev', title: DEVICE_LABEL[x.device] }, icon(DEVICE_ICON[x.device]), el('span', { className: 'sr', textContent: DEVICE_LABEL[x.device] })));
    if (g.all.length > 1) tags.append(el('span', { className: 'tag soft', title: '같은 계정으로 접속한 기기', textContent: `기기 ${g.all.length}대` }));
    row.append(avEl(u), el('span', { className: 'nm' }, el('span', { textContent: u.name + (isMe ? ' (나)' : '') }), u.prev ? el('small', { className: 'prev', textContent: '이전: ' + u.prev }) : '', tags.children.length ? tags : ''));
    const vo = g.all.map((x) => voiceList.find((v) => v.id === x.id)).find(Boolean);
    if (vo) { const vi = icon(vo.muted ? 'i-mic-off' : 'i-mic'); vi.setAttribute('class', 'i vi'); vi.setAttribute('role', 'img'); vi.setAttribute('aria-label', vo.muted ? '음성 참가 중, 마이크 꺼짐' : '음성 참가 중'); row.append(vi); }
    if (canOpen) {
      row.type = 'button'; row.dataset.uid = u.id;
      row.setAttribute('aria-expanded', openUser === u.id);
      row.setAttribute('aria-label', `${u.name}${u.host ? ', 호스트' : u.admin ? ', 관리자' : ''}${u.acct ? ', 계정' : ''}${g.all.every((x) => x.away) ? ', 자리 비움' : ''}${DEVICE_LABEL[u.device] ? ', ' + DEVICE_LABEL[u.device] : ''}${g.all.length > 1 ? ', 기기 ' + g.all.length + '대' : ''}${vo ? ', 음성 참가 중' : ''}, 메뉴`);
      const chev = icon('i-down'); chev.setAttribute('class', 'i chev');
      row.append(chev);
      row.onclick = () => { openUser = openUser === u.id ? null : u.id; renderUsers(); $(`[data-uid="${u.id}"]`)?.focus(); };
    }
    li.append(row);
    if (canOpen && openUser === u.id) {
      const acts = el('div', { className: 'acts' });
      if (meUid && u.uid && u.uid !== meUid) acts.append(el('button', { type: 'button', className: 'btn sm', textContent: '쪽지 보내기', onclick: () => openDm(u.uid, u) }));
      else if (u.uid !== meUid || !u.uid) acts.append(el('small', { className: 'prev', textContent: !meUid ? '쪽지는 로그인하면 보낼 수 있어요.' : '게스트는 쪽지를 받을 수 없어요.' }));
      if (vo) acts.append(volumeControl(g.all.find((x) => x.id === vo.id) || u));
      if (isHost && !u.host && !u.admin) {
        acts.append(
          el('button', { type: 'button', className: 'btn sm', textContent: u.canQueue ? '대기열 추가 회수' : '대기열 추가 허용', onclick: () => send({ t: 'queue-grant', id: u.id, on: !u.canQueue }) }),
          el('button', { type: 'button', className: 'btn sm', textContent: '호스트 넘기기', onclick: () => confirm(`${u.name} 님에게 호스트를 넘길까요?`) && send({ t: 'host-give', id: u.id }) }));
      }
      if (canBan) acts.append(banBtn('강퇴', g.all, 'kick'), banBtn('사용자 밴', g.all, 'user'), banBtn('IP 밴', g.all, 'ip'));
      li.append(acts);
    }
    ul.append(li);
  }
}
function banBtn(label, all, mode) { // all: 이 사람의 모든 기기 (같은 계정이면 여러 개)
  const b = el('button', { type: 'button', className: 'btn sm danger', textContent: label });
  b.onclick = () => confirm(`${all[0].name} 님을 ${label}할까요?`) && all.forEach((x) => send({ t: 'ban', id: x.id, mode }));
  return b;
}
function renderBans(bans = []) {
  const ul = $('#bans'); ul.replaceChildren();
  if (!bans.length) ul.append(el('li', { className: 'none', textContent: '차단한 사람이 없어요.' }));
  for (const b of bans) {
    const un = el('button', { type: 'button', className: 'btn sm', textContent: '해제' });
    un.setAttribute('aria-label', `${b.label} 차단 해제`);
    un.onclick = () => send({ t: 'unban', id: b.id });
    ul.append(el('li', {}, el('span', { className: 'nm', textContent: b.label }), tag(b.type === 'ip' ? 'IP' : b.type === 'acct' ? '계정' : '사용자', true), un));
  }
}

/* ================= 채팅 ================= */
function addLine(node) {
  const c = $('#chat'), atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
  c.append(node); if (atEnd) c.scrollTop = c.scrollHeight;
}
// 채팅은 번호(seq)를 달고 와서, 이 기기가 어디까지 봤는지 기억한다. 폰이 탭을 버렸다 다시 열어도 서버가 놓친 만큼 다시 보내 준다.
// 기기 안 보관: 최근 대화를 24시간 동안 이 기기(localStorage)에 남겨 두고, 화면이 새로 열리면 먼저 보여 준다 (서버 기록이 없어졌을 때를 대비한 복사본).
const CHAT_KEEP = 24 * 3600e3, CHAT_LOCAL_MAX = 300;
let chatSeq = 0, chatLocal = [], chatLocalTimer = 0;
try {
  chatLocal = JSON.parse(get('chatLog') || '[]').filter((e) => e && e.seq && e.ts > Date.now() - CHAT_KEEP).slice(-CHAT_LOCAL_MAX);
  chatSeq = chatLocal.reduce((a, e) => Math.max(a, e.seq), 0);
} catch { chatLocal = []; }
function keepChat(m, mine) {
  chatLocal.push({ seq: m.seq, id: m.id, name: m.name, uid: m.uid, color: m.color, text: m.text, media: m.media, ts: m.ts, mine: mine || undefined });
  if (chatLocal.length > CHAT_LOCAL_MAX) chatLocal.shift();
  clearTimeout(chatLocalTimer); chatLocalTimer = setTimeout(() => set('chatLog', JSON.stringify(chatLocal)), 1000);
}
// 입장 직후: 이 기기에 남은 이전 대화를 보여 주고, 이어서 서버가 알려 준 놓친 대화를 보여 준다
function showBacklog(backlog) {
  const old = chatLocal.filter((e) => !backlog.some((b) => b.seq === e.seq));
  const shown = new Set([...$('#chat').querySelectorAll('.m[data-seq]')].map((n) => +n.dataset.seq));
  const fresh = (list) => list.filter((e) => !shown.has(e.seq));
  for (const e of fresh(old)) chatMsg(e, true);
  const miss = fresh(backlog);
  if (miss.length) sys(`자리를 비운 동안 올라온 채팅 ${miss.length}개를 불러왔어요.`);
  for (const e of miss) chatMsg(e, true);
  return miss.length;
}
function chatMsg(m, quiet) {
  if (m.seq) { if (quiet !== true && m.seq <= chatSeq) return; chatSeq = Math.max(chatSeq, m.seq); }
  const u = users.find((x) => x.id === m.id) || { id: m.id, name: m.name, color: m.color, avatar: m.uid ? '/a/' + m.uid : undefined };
  const time = new Date(m.ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const urls = [], body = m.text ? (typeof richNodes === 'function' ? richNodes(m.text, { urls }) : [el('p', { textContent: m.text })]) : [];
  const bubble = el('div', { className: 'bubble' },
    el('header', {}, el('b', { textContent: m.name }), el('time', { textContent: time })),
    ...body, ...(typeof embedNodes === 'function' ? embedNodes(urls) : []));
  if (m.media) bubble.append(mediaNode(m.media));
  bubble.style.setProperty('--c', u.color || 'var(--line)');
  const mine = m.id === me || !!m.mine;
  const row = el('div', { className: 'm' + (mine ? ' mine' : '') }, avEl(u), bubble);
  row.dataset.sid = m.id; if (m.seq) row.dataset.seq = m.seq; addLine(row);
  if (m.seq && !chatLocal.some((e) => e.seq === m.seq)) keepChat(m, mine);
  if (quiet !== true && activeTab !== 'chat' && !mine) setDot('chat', ++unread);
}
const sys = (t) => addLine(el('div', { className: 'sys', textContent: t }));
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatIn').value.trim();
  if (text && !sendPaced('chat', { t: 'chat', text })) return sys('연결이 끊겨서 보내지 못했어요. 다시 연결되면 보내 주세요.'); // 글은 그대로 남겨 둔다
  $('#chatIn').value = '';
};
// 호스트가 방 열림 소식을 카카오톡 같은 곳에 직접 공유한다 (오픈채팅방에 자동으로 보내는 공식 방법이 없어서, 공유 창에서 보낼 곳을 사람이 고른다)
$('#shareKakao').onclick = async () => {
  const data = { title: '시루 그룹챗', text: '시루 그룹챗 방이 열렸어요! 같이 들어와요.', url: location.origin };
  if (navigator.share) { try { await navigator.share(data); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(data.text + '\n' + data.url); sys('방 열림 문구와 주소를 복사했어요. 카카오톡 오픈채팅방에 붙여 넣어 주세요.'); }
  catch { sys('복사하지 못했어요. 이 주소를 직접 보내 주세요: ' + data.url); }
};
$('#copy').onclick = () => navigator.clipboard?.writeText(location.origin).then(() => sys('링크를 복사했어요.'), () => sys('링크를 복사하지 못했어요.'));

/* ================= 오른쪽 패널 탭 (채팅 / 대기열 / 참가자) ================= */
const TABS = ['chat', 'queue', 'users', 'dm'];
let activeTab = 'chat', unread = 0;
function setDot(name, n) { const d = $('#dot-' + name); d.textContent = n > 99 ? '99+' : n; d.hidden = !n; }
function showTab(name) {
  activeTab = name;
  for (const n of TABS) {
    $('#tab-' + n).setAttribute('aria-selected', n === name);
    $('#tab-' + n).tabIndex = n === name ? 0 : -1;
    $('#p-' + n).hidden = n !== name;
  }
  if (name === 'dm') { dmShown(); tourMaybe('dm'); } // 쪽지 탭을 처음 열면 쪽지 안내
  if (name === 'chat') { unread = 0; setDot('chat', 0); const c = $('#chat'); c.scrollTop = c.scrollHeight; }
}
TABS.forEach((n, i) => {
  $('#tab-' + n).onclick = () => showTab(n);
  $('#tab-' + n).onkeydown = (e) => { // 좌우 방향키로 탭 이동
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d || dmOnly) return;
    const next = TABS[(i + d + TABS.length) % TABS.length];
    showTab(next); $('#tab-' + next).focus();
  };
});

// 앱이 뜰 때 서버가 살아 있는지 확인: 꺼져 있으면(5xx, 연결 실패) 서비스 워커가 보여 준 앱 껍데기 위에 안내 페이지를 띄운다
// 쪽지함에서 '방에 들어가기'로 새로 열린 화면이면 바로 입장한다 (모든 스크립트가 올라온 뒤에)
addEventListener('load', () => { try { if (sessionStorage.getItem('autoJoin') && (get('name') || loggedIn())) { sessionStorage.removeItem('autoJoin'); $('#joinForm').requestSubmit(); } } catch {} });
fetch('/healthz', { cache: 'no-store' }).then((r) => { if (!r.ok) showServerDown(); }).catch(() => showServerDown());
// (처음 화면의 단계는 auth.js 맨 끝의 authUi() 가 joinAuto() 로 정한다. 로그인 상태 함수가 auth.js 에 있어서 여기서는 부를 수 없다)
if (JOIN_DIRECT) $('#nameIn').focus();
