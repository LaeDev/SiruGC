/* ================= 쪽지 (DM) ================= */
// 상대는 공개 번호(uid)로 부른다. 목록은 서버가 입장할 때 알려 주고, 새 쪽지는 'dm' 메시지로 실시간으로 온다.
let meUid = null;
const dmPeers = new Map();   // uid → { uid, name, color, last:{text,ts,mine}, unread }
const dmThreads = new Map(); // uid → 불러온 쪽지 기록
let dmOpenUid = null;        // 지금 열어 둔 대화 상대

const dmOnline = (uid) => users.some((u) => u.uid === uid);
const dmUnread = () => [...dmPeers.values()].reduce((n, p) => n + (p.unread || 0), 0);
const peerUser = (p) => ({ name: p.name, color: p.color, avatar: `/a/${p.uid}` }); // 접속 중이 아닌 사람의 프사도 서버에서 받는다
const dmTime = (ts) => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
};

// 쪽지가 왔을 때 앱 안에서 내는 짧은 소리 (모든 소리 끄기 / 패닉이 켜져 있으면 나지 않는다)
let dingCtx = null;
function ding() {
  if (soundOff || notifPrefs.ding === false) return;
  try {
    dingCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    dingCtx.resume?.();
    const t0 = dingCtx.currentTime;
    for (const [freq, delay] of [[880, 0], [1320, 0.12]]) {
      const o = dingCtx.createOscillator(), g = dingCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + delay);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.25);
      o.connect(g).connect(dingCtx.destination);
      o.start(t0 + delay); o.stop(t0 + delay + 0.3);
    }
  } catch {}
}

function dmInit(m) {
  meUid = m.me.uid;
  dmPeers.clear(); dmThreads.clear(); dmOpenUid = null;
  for (const c of m.inbox || []) dmPeers.set(c.uid, c);
  dmShowThread(false); dmRender();
}
function dmRefresh() { dmRender(); }

function dmRender() {
  setDot('dm', dmUnread());
  const list = [...dmPeers.values()].filter((p) => p.last).sort((a, b) => b.last.ts - a.last.ts);
  const ul = $('#dmList'); ul.replaceChildren();
  for (const p of list) {
    const btn = el('button', { type: 'button', className: 'conv', onclick: () => openDm(p.uid) });
    const side = el('span', { className: 'side-r' }, el('time', { textContent: dmTime(p.last.ts) }));
    if (p.unread) side.append(el('span', { className: 'dot', ariaHidden: 'true', textContent: p.unread > 99 ? '99+' : p.unread })); // 개수는 버튼의 aria-label이 읽어 준다
    btn.append(
      paintAvatar(el('span', { className: 'av' }), peerUser(p)),
      el('span', { className: 'who' }, el('b', { textContent: p.name }), el('small', { textContent: (p.last.mine ? '나: ' : '') + p.last.text })),
      side);
    btn.setAttribute('aria-label', `${p.name}, ${p.unread ? `안 읽은 쪽지 ${p.unread}개, ` : ''}마지막 쪽지: ${p.last.text}`);
    ul.append(el('li', {}, btn));
  }
  $('#dmEmpty').hidden = list.length > 0;
  if (dmOpenUid) {
    const p = dmPeers.get(dmOpenUid);
    const who = $('#dmWho'); who.replaceChildren();
    if (p) who.append(paintAvatar(el('span', { className: 'av' }), peerUser(p)), el('span', { textContent: p.name }), dmOnline(p.uid) ? el('span', { className: 'on', textContent: '접속 중' }) : '');
  }
}

function dmShowThread(on) {
  $('#dmListWrap').hidden = on;
  $('#dmThread').hidden = !on;
}
function dmBubble(msg) {
  const mine = msg.from === meUid;
  const p = dmPeers.get(mine ? msg.to : msg.from);
  const who = mine ? { ...(users.find((u) => u.id === me) || {}), name: '나' } : peerUser(p || { uid: msg.from, name: '?' });
  const bubble = el('div', { className: 'bubble' },
    el('header', {}, el('b', { textContent: mine ? '나' : who.name }), el('time', { textContent: dmTime(msg.ts) })),
    el('p', { textContent: msg.text }));
  bubble.style.setProperty('--c', who.color || 'var(--line)');
  const row = el('div', { className: 'm' + (mine ? ' mine' : '') }, mine ? avEl(who) : paintAvatar(el('span', { className: 'av' }), who), bubble);
  row.dataset.id = msg.id;
  return row;
}
function dmScroll() { const c = $('#dmMsgs'); c.scrollTop = c.scrollHeight; }

function openDm(uid, info) {
  if (!uid || uid === meUid) return;
  if (!dmPeers.has(uid)) dmPeers.set(uid, { uid, name: info?.name || '알 수 없음', color: info?.color || null, unread: 0 });
  dmOpenUid = uid;
  showTab('dm');
  dmShowThread(true);
  $('#dmMsgs').replaceChildren();
  send({ t: 'dm-history', with: uid });
  dmMarkRead(uid);
  dmRender();
  if (matchMedia('(pointer:fine)').matches) $('#dmIn').focus();
}
function dmMarkRead(uid) {
  const p = dmPeers.get(uid);
  if (!p?.unread) return;
  p.unread = 0;
  send({ t: 'dm-read', with: uid });
  dmRender();
}
// 쪽지 탭을 다시 열었을 때 (app.js의 showTab이 부른다)
function dmShown() { if (dmOpenUid) dmMarkRead(dmOpenUid); }

$('#dmBack').onclick = () => { dmOpenUid = null; dmShowThread(false); dmRender(); };
$('#dmForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#dmIn').value.trim();
  if (text && dmOpenUid) send({ t: 'dm', to: dmOpenUid, text });
  $('#dmIn').value = '';
};

Object.assign(handlers, {
  dm(m) {
    const msg = m.msg, mine = msg.from === meUid, peerUid = mine ? msg.to : msg.from;
    const p = dmPeers.get(peerUid) || { uid: peerUid, unread: 0 };
    Object.assign(p, { name: m.peer.name, color: m.peer.color, last: { text: msg.text, ts: msg.ts, mine } });
    dmPeers.set(peerUid, p);
    dmThreads.get(peerUid)?.push(msg);
    const viewing = activeTab === 'dm' && dmOpenUid === peerUid && !document.hidden;
    if (dmOpenUid === peerUid && !$('#dmMsgs').querySelector(`[data-id="${msg.id}"]`)) {
      const c = $('#dmMsgs'), atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
      c.append(dmBubble(msg)); if (atEnd || mine) dmScroll();
    }
    if (!mine) { if (viewing) { send({ t: 'dm-read', with: peerUid }); p.unread = 0; } else { p.unread = (p.unread || 0) + 1; ding(); } }
    dmRender();
  },
  'dm-thread'(m) {
    dmThreads.set(m.with, m.msgs);
    const p = dmPeers.get(m.with);
    if (p && m.peer?.name) Object.assign(p, { name: m.peer.name, color: m.peer.color });
    if (dmOpenUid === m.with) {
      const c = $('#dmMsgs'); c.replaceChildren(...m.msgs.map(dmBubble)); dmScroll();
      if (!m.msgs.length) c.append(el('div', { className: 'sys', textContent: '아직 주고받은 쪽지가 없어요. 첫 쪽지를 보내 보세요.' }));
    }
    dmRender();
  },
  'dm-read'(m) { const p = dmPeers.get(m.with); if (p) { p.unread = 0; dmRender(); } }, // 내 다른 기기에서 읽었을 때
});

// 알림을 눌러서 앱이 열렸을 때 (서비스 워커가 알려 준다)
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.t === 'open-dm' && e.data.uid && joined) openDm(e.data.uid); });
