const $ = (s) => document.querySelector(s);
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
// randomUUID는 http(비보안) 환경에서 없어서 getRandomValues 사용
const cid = get('cid') || (() => {
  const v = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  set('cid', v); return v;
})();
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<use href="#${id}"/>`; return s; };

let ws, me, isHost = false, sharerId = null, users = [], ended = false, joined = false, openUser = null;
// 의미색 버튼: go(초록) / blue(파랑) / stop(빨강) 중 하나만 켠다
const setTone = (b, tone) => ['go', 'blue', 'stop'].forEach((c) => b.classList.toggle(c, c === tone));
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

/* ================= 아바타 만들기 ================= */
const SWATCHES = [['#ff6b8b', '분홍'], ['#ffb84d', '주황'], ['#f7e463', '노랑'], ['#6ee7a8', '초록'], ['#5cd6e0', '하늘'], ['#6fa8ff', '파랑'], ['#a98bff', '보라'], ['#f29ae0', '연분홍']];
const EMOJIS = ['😀', '😎', '🥳', '😴', '🤔', '😍', '😇', '😤', '🤖', '👻', '👽', '🦊', '🐱', '🐶', '🐼', '🐸', '🦁', '🐧', '🐙', '🦄', '🐢', '🐰', '🐻', '🍕', '🍔', '🍣', '🍜', '🍩', '🍓', '🍉', '🌵', '🌈', '⭐', '🔥', '💎', '🎧', '🎮', '🎬', '🎸', '⚽', '🚀', '🛸', '🌙', '☕'];
const FONT_EMOJI = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

let profile = { mode: 'emoji', emoji: '😎', color: SWATCHES[Math.floor(Math.random() * SWATCHES.length)][0], photo: '' };
try { Object.assign(profile, JSON.parse(get('profile') || '{}')); } catch {}
if (!/^#[0-9a-f]{6}$/i.test(profile.color)) profile.color = '#ffb84d';

// 이모티콘 + 배경색을 128px 이미지로 그린다. 사진도 같은 크기로 줄여서 서버엔 같은 형식으로 보낸다.
function emojiAvatar(emoji, color) {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 128, 128);
  g.font = `72px ${FONT_EMOJI}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(emoji, 64, 70);
  return c.toDataURL('image/jpeg', 0.88);
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
  return node;
}
const avEl = (u) => { const e = paintAvatar(el('span', { className: 'av' }), u); if (u.id) e.dataset.id = u.id; return e; };

function refresh(pop) {
  const nm = $('#nameIn').value.trim() || '나';
  const pv = $('#preview');
  paintAvatar(pv, { avatar: currentAvatar(), color: profile.color, name: nm });
  if (pop) { pv.classList.remove('pop'); void pv.offsetWidth; pv.classList.add('pop'); }
  const photo = profile.mode === 'photo';
  $('#tabEmoji').setAttribute('aria-selected', !photo); $('#tabEmoji').tabIndex = photo ? -1 : 0;
  $('#tabPhoto').setAttribute('aria-selected', photo); $('#tabPhoto').tabIndex = photo ? 0 : -1;
  $('#panEmoji').hidden = photo; $('#panPhoto').hidden = !photo;
  $('#photoClear').hidden = !profile.photo;
  document.querySelectorAll('#emojis button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.e === profile.emoji));
  document.querySelectorAll('#swatches .sw').forEach((b) => b.setAttribute('aria-pressed', b.dataset.c === profile.color));
  $('#colorIn').value = profile.color; $('#colorHex').textContent = profile.color.toUpperCase();
  set('profile', JSON.stringify(profile));
}

for (const e of EMOJIS) {
  const b = el('button', { type: 'button', textContent: e });
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
refresh();

$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const name = $('#nameIn').value.trim();
  if (!name) { $('#joinMsg').textContent = '닉네임을 입력해 주세요.'; return $('#nameIn').focus(); }
  $('#joinMsg').textContent = '';
  set('name', name);
  $('#enter').disabled = true; $('#enter').textContent = '들어가는 중';
  connect(name);
};

function connect(name) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => send({ t: 'join', name, avatar: currentAvatar(), color: profile.color, cid, hostKey: get('hostKey') });
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (ended) return;
    if (joined) return showServerDown(); // 방에 있다가 끊김 = 서버가 꺼진 것으로 보고 바로 멈춘다
    $('#enter').disabled = false; $('#enter').textContent = '입장하기';
    $('#joinMsg').textContent = '서버에 연결하지 못했어요. 잠시 뒤 다시 눌러 주세요.';
  };
}

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
function showServerDown() {
  if (serverDown) return;
  serverDown = ended = true;
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
    joined = true;
    me = m.me.id; isHost = m.me.host; users = m.users.concat(m.me);
    if (m.hostKey) set('hostKey', m.hostKey);
    $('#join').hidden = true; $('#app').hidden = false;
    $('#banBox').hidden = !isHost;
    renderBans(m.bans); renderUsers();
    rtcConfig.iceServers = m.ice || rtcConfig.iceServers; voiceList = m.voice || [];
    queue = m.queue || []; renderQueue();
    dmInit(m); notifyInit(m);
    if (m.yt) applyYt(m.yt);
    if (m.sharer) { sharerId = m.sharer; requestShare(); }
    renderStage();
    sys(isHost ? '이 방의 호스트예요. 참가자 탭에서 사람을 누르면 쪽지·강퇴·밴 메뉴가 열려요.' : '입장했어요. 참가자 탭에서 사람을 누르면 쪽지를 보낼 수 있어요.');
    if (matchMedia('(pointer:fine)').matches) $('#chatIn').focus(); // 터치 기기에선 키보드가 갑자기 올라오지 않게
  },
  queue(m) { queue = m.queue; renderQueue(); },
  'user-join'(m) { users.push(m.user); renderUsers(); dmRefresh(); sys(m.user.name + ' 님이 들어왔어요.'); },
  'user-leave'(m) {
    const u = users.find((x) => x.id === m.id);
    users = users.filter((x) => x.id !== m.id); closePc(m.id); closeVpc(m.id);
    if (openUser === m.id) openUser = null;
    renderUsers(); dmRefresh();
    if (u) sys(u.name + ' 님이 나갔어요.');
  },
  chat: (m) => chatMsg(m),
  yt: (m) => applyYt(m),
  'share-start'(m) {
    sharerId = m.id; renderUsers(); renderStage();
    if (m.id !== me) requestShare();
  },
  'share-stop'() { sharerId = null; remoteShareEnded(); renderUsers(); renderStage(); },
  'share-denied'() { stopLocal(); sys('이미 다른 사람이 화면을 공유하고 있어요.'); },
  rtc(m) { chain = chain.then(() => onRtc(m.from, m.data)).catch(console.warn); },
  bans: (m) => renderBans(m.bans),
  shutdown: () => showServerDown(),
  banned(m) {
    ended = true; stopEverything();
    document.body.replaceChildren(el('main', { className: 'end' },
      el('h1', { textContent: m.kick ? '방에서 나가게 됐어요' : '이 방에 들어올 수 없어요' }),
      el('p', { textContent: m.kick ? '호스트가 내보냈어요.' : '호스트가 이 방에서 차단했어요.' })));
  },
});

/* ================= 참가자 / 밴 ================= */
const tag = (t, soft) => el('span', { className: 'tag' + (soft ? ' soft' : ''), textContent: t });
function renderUsers() {
  $('#dot-users').textContent = users.length;
  const ul = $('#users'); ul.replaceChildren();
  for (const u of users) {
    const li = el('li');
    const canOpen = u.id !== me && u.uid !== meUid;          // 나를 뺀 모두에게 쪽지 메뉴
    const canBan = isHost && !u.host;                         // 호스트만 강퇴·밴
    const row = el(canOpen ? 'button' : 'div', { className: 'urow' });
    row.append(avEl(u), el('span', { className: 'nm', textContent: u.name + (u.id === me ? ' (나)' : '') }));
    if (u.host) row.append(tag('호스트'));
    if (u.id === sharerId) row.append(tag('공유 중', true));
    const vo = voiceList.find((x) => x.id === u.id);
    if (vo) { const vi = icon(vo.muted ? 'i-mic-off' : 'i-mic'); vi.setAttribute('class', 'i vi'); vi.setAttribute('role', 'img'); vi.setAttribute('aria-label', vo.muted ? '음성 참가 중, 마이크 꺼짐' : '음성 참가 중'); row.append(vi); }
    if (canOpen) {
      row.type = 'button'; row.dataset.uid = u.id;
      row.setAttribute('aria-expanded', openUser === u.id);
      row.setAttribute('aria-label', `${u.name} ${canBan ? '쪽지·관리' : '쪽지'} 메뉴`);
      const chev = icon('i-down'); chev.setAttribute('class', 'i chev');
      row.append(chev);
      row.onclick = () => { openUser = openUser === u.id ? null : u.id; renderUsers(); $(`[data-uid="${u.id}"]`)?.focus(); };
    }
    li.append(row);
    if (canOpen && openUser === u.id) {
      const acts = el('div', { className: 'acts' }, el('button', { type: 'button', className: 'btn sm', textContent: '쪽지 보내기', onclick: () => openDm(u.uid, u) }));
      if (canBan) acts.append(banBtn('강퇴', u, 'kick'), banBtn('사용자 밴', u, 'user'), banBtn('IP 밴', u, 'ip'));
      li.append(acts);
    }
    ul.append(li);
  }
}
function banBtn(label, u, mode) {
  const b = el('button', { type: 'button', className: 'btn sm danger', textContent: label });
  b.onclick = () => confirm(`${u.name} 님을 ${label}할까요?`) && send({ t: 'ban', id: u.id, mode });
  return b;
}
function renderBans(bans = []) {
  const ul = $('#bans'); ul.replaceChildren();
  if (!bans.length) ul.append(el('li', { className: 'none', textContent: '차단한 사람이 없어요.' }));
  for (const b of bans) {
    const un = el('button', { type: 'button', className: 'btn sm', textContent: '해제' });
    un.setAttribute('aria-label', `${b.label} 차단 해제`);
    un.onclick = () => send({ t: 'unban', id: b.id });
    ul.append(el('li', {}, el('span', { className: 'nm', textContent: b.label }), tag(b.type === 'ip' ? 'IP' : '사용자', true), un));
  }
}

/* ================= 채팅 ================= */
function addLine(node) {
  const c = $('#chat'), atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
  c.append(node); if (atEnd) c.scrollTop = c.scrollHeight;
}
function chatMsg(m) {
  const u = users.find((x) => x.id === m.id) || { id: m.id, name: m.name };
  const time = new Date(m.ts).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const bubble = el('div', { className: 'bubble' },
    el('header', {}, el('b', { textContent: m.name }), el('time', { textContent: time })),
    el('p', { textContent: m.text }));
  bubble.style.setProperty('--c', u.color || 'var(--line)');
  addLine(el('div', { className: 'm' + (m.id === me ? ' mine' : '') }, avEl(u), bubble));
  if (activeTab !== 'chat' && m.id !== me) setDot('chat', ++unread);
}
const sys = (t) => addLine(el('div', { className: 'sys', textContent: t }));
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatIn').value.trim();
  if (text) send({ t: 'chat', text });
  $('#chatIn').value = '';
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
  if (name === 'dm') dmShown();
  if (name === 'chat') { unread = 0; setDot('chat', 0); const c = $('#chat'); c.scrollTop = c.scrollHeight; }
}
TABS.forEach((n, i) => {
  $('#tab-' + n).onclick = () => showTab(n);
  $('#tab-' + n).onkeydown = (e) => { // 좌우 방향키로 탭 이동
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const next = TABS[(i + d + TABS.length) % TABS.length];
    showTab(next); $('#tab-' + next).focus();
  };
});

// 앱이 뜰 때 서버가 살아 있는지 확인: 꺼져 있으면(5xx, 연결 실패) 서비스 워커가 보여 준 앱 껍데기 위에 안내 페이지를 띄운다
fetch('/healthz', { cache: 'no-store' }).then((r) => { if (!r.ok) showServerDown(); }).catch(() => showServerDown());
$('#nameIn').focus();
