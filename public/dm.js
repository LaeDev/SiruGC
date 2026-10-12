/* ================= 쪽지 (DM) ================= */
// 상대는 공개 번호(uid)로 부른다. 목록은 서버가 입장할 때 알려 주고, 새 쪽지는 'dm' 메시지로 실시간으로 온다.
// 화면은 세 가지: 대화 목록(+새 쪽지) / 새 쪽지 상대 고르기 / 대화창.
let meUid = null;
const dmPeers = new Map();   // uid → { uid, name, color, last:{text,ts,mine}, unread, blocked }
const dmThreads = new Map(); // uid → 불러온 쪽지 기록
let dmOpenUid = null;        // 지금 열어 둔 대화 상대
let dmBlocked = new Set();   // 내가 차단한 사람들
let dmMembers = [];          // 새 쪽지 상대 고르기용 전체 회원

const dmOnline = (uid) => users.some((u) => u.uid === uid);
const dmUnread = () => [...dmPeers.values()].reduce((n, p) => n + (p.unread || 0), 0);
const peerUser = (p) => ({ name: p.name, color: p.color, avatar: `/a/${p.uid}` }); // 접속 중이 아닌 사람의 프사도 서버에서 받는다
const dmTime = (ts) => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
};
const dayLabel = (ts) => {
  const d = new Date(ts), t = new Date(), y = new Date(t.getTime() - 86400e3);
  return d.toDateString() === t.toDateString() ? '오늘' : d.toDateString() === y.toDateString() ? '어제' : d.toLocaleDateString('ko-KR', { year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
};
const lastText = (m) => m.text || (m.media?.kind === 'video' ? '(동영상)' : '(사진)');

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
  dmPeers.clear(); dmThreads.clear(); dmOpenUid = null; dmBlocked = new Set(m.blocks || []);
  for (const c of m.inbox || []) dmPeers.set(c.uid, c);
  dmView('list'); dmRender();
}
function dmRefresh() { dmRender(); }
// 끊겼다 이어받았을 때: 끊겨 있던 동안 온 쪽지를 받은편지함에 반영하고, 열려 있는 대화는 기록을 다시 불러온다
function dmResync(m) {
  dmBlocked = new Set(m.blocks || []);
  for (const c of m.inbox || []) dmPeers.set(c.uid, { ...dmPeers.get(c.uid), ...c });
  dmRender();
  if (dmOpenUid) send({ t: 'dm-history', with: dmOpenUid });
}

/* ---------- 화면 전환 ---------- */
function dmView(name) { // 'list' | 'picker' | 'thread'
  $('#dmListWrap').hidden = name !== 'list';
  $('#dmPicker').hidden = name !== 'picker';
  $('#dmThread').hidden = name !== 'thread';
}

/* ---------- 대화 목록 ---------- */
function dmRender() {
  setDot('dm', dmUnread());
  const list = [...dmPeers.values()].filter((p) => p.last).sort((a, b) => b.last.ts - a.last.ts);
  const ul = $('#dmList'); ul.replaceChildren();
  for (const p of list) {
    const btn = el('button', { type: 'button', className: 'conv', onclick: () => openDm(p.uid) });
    const side = el('span', { className: 'side-r' }, el('time', { textContent: dmTime(p.last.ts) }));
    if (p.unread) side.append(el('span', { className: 'dot', ariaHidden: 'true', textContent: p.unread > 99 ? '99+' : p.unread })); // 개수는 버튼의 aria-label이 읽어 준다
    const blocked = dmBlocked.has(p.uid);
    btn.append(
      paintAvatar(el('span', { className: 'av' }), peerUser(p)),
      el('span', { className: 'who' }, el('b', { textContent: p.name }), el('small', { textContent: (blocked ? '차단함 · ' : '') + (p.last.mine ? '나: ' : '') + p.last.text })),
      side);
    btn.setAttribute('aria-label', `${p.name}${blocked ? ' (차단함)' : ''}, ${p.unread ? `안 읽은 쪽지 ${p.unread}개, ` : ''}마지막 쪽지: ${p.last.text}`);
    ul.append(el('li', {}, btn));
  }
  $('#dmEmpty').hidden = list.length > 0;
  if (dmOpenUid) renderThreadHeader();
}
function renderThreadHeader() {
  const p = dmPeers.get(dmOpenUid), who = $('#dmWho'), blocked = dmBlocked.has(dmOpenUid);
  who.replaceChildren();
  if (p) who.append(paintAvatar(el('span', { className: 'av' }), peerUser(p)), el('span', { textContent: p.name }), dmOnline(p.uid) ? el('span', { className: 'on', textContent: '접속 중' }) : '');
  const b = $('#dmBlock');
  b.setAttribute('aria-label', blocked ? '차단 해제' : '이 사람 차단'); b.title = b.getAttribute('aria-label'); b.classList.toggle('stop', blocked);
  $('#dmBlockedNote').hidden = !blocked;
  $('#dmIn').disabled = $('#dmAttachBtn').disabled = blocked;
  $('#dmIn').placeholder = blocked ? '차단한 사람에게는 보낼 수 없어요' : '쪽지를 입력하세요';
}

/* ---------- 대화창 ---------- */
function dmBubble(msg) {
  const mine = msg.from === meUid;
  const p = dmPeers.get(mine ? msg.to : msg.from);
  const who = mine ? { ...(users.find((u) => u.id === me) || {}), name: '나' } : peerUser(p || { uid: msg.from, name: '?' });
  const bubble = el('div', { className: 'bubble' },
    el('header', {}, el('b', { textContent: mine ? '나' : who.name }), el('time', { textContent: dmTime(msg.ts) })),
    ...(msg.text ? [el('p', { textContent: msg.text })] : []));
  if (msg.media) bubble.append(mediaNode(msg.media));
  if (mine) { // 내 쪽지는 눌러서(또는 Enter) 삭제 메뉴를 연다
    const act = el('div', { className: 'mact', hidden: true }, el('button', { type: 'button', className: 'btn sm danger', textContent: '이 쪽지 삭제', onclick: () => confirm('이 쪽지를 지울까요? 상대 화면에서도 사라져요.') && send({ t: 'dm-delete', with: msg.to, id: msg.id }) }));
    bubble.append(act);
    bubble.tabIndex = 0; bubble.setAttribute('role', 'group'); bubble.setAttribute('aria-label', '내 쪽지. 누르면 삭제 메뉴가 열려요');
    const toggle = (e) => { if (e.target.closest('.media, .mact')) return; act.hidden = !act.hidden; };
    bubble.addEventListener('click', toggle);
    bubble.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === bubble) toggle(e); });
  }
  bubble.style.setProperty('--c', who.color || 'var(--line)');
  const row = el('div', { className: 'm' + (mine ? ' mine' : '') }, mine ? avEl(who) : paintAvatar(el('span', { className: 'av' }), who), bubble);
  row.dataset.id = msg.id;
  return row;
}
function dmScroll() { const c = $('#dmMsgs'); c.scrollTop = c.scrollHeight; }
// 대화 전체를 그린다: 날짜가 바뀌는 곳에 구분선, 내 마지막 쪽지 아래에 읽음 표시
function dmDrawThread(msgs) {
  const c = $('#dmMsgs'); c.replaceChildren();
  let lastDay = '';
  for (const msg of msgs) { const d = new Date(msg.ts).toDateString(); if (d !== lastDay) { lastDay = d; c.append(el('div', { className: 'sys day', textContent: dayLabel(msg.ts) })); } c.append(dmBubble(msg)); }
  if (!msgs.length) c.append(el('div', { className: 'sys', textContent: '아직 주고받은 쪽지가 없어요. 첫 쪽지를 보내 보세요.' }));
  dmReceipt(); dmScroll();
}
function dmReceipt() { // 내가 보낸 마지막 쪽지가 읽혔는지
  $('#dmMsgs').querySelector('.rcpt')?.remove();
  const mineRows = [...$('#dmMsgs').querySelectorAll('.m.mine')]; if (!mineRows.length) return;
  const last = (dmThreads.get(dmOpenUid) || []).filter((x) => x.from === meUid).at(-1);
  if (last) mineRows.at(-1).append(el('span', { className: 'rcpt', textContent: last.read ? '읽음' : '전송됨' }));
}

function openDm(uid, info) {
  if (!uid || uid === meUid) return;
  if (!dmPeers.has(uid)) dmPeers.set(uid, { uid, name: info?.name || '알 수 없음', color: info?.color || null, unread: 0 });
  dmOpenUid = uid;
  showTab('dm'); dmView('thread');
  $('#dmMsgs').replaceChildren();
  send({ t: 'dm-history', with: uid });
  dmMarkRead(uid); dmRender();
  if (matchMedia('(pointer:fine)').matches && !dmBlocked.has(uid)) $('#dmIn').focus();
}
function dmMarkRead(uid) {
  const p = dmPeers.get(uid);
  if (!p?.unread) return;
  p.unread = 0;
  send({ t: 'dm-read', with: uid });
  dmRender();
}
// 쪽지 탭을 다시 열었을 때 (app.js의 showTab이 부른다)
function dmShown() { if (dmOpenUid && !$('#dmThread').hidden) dmMarkRead(dmOpenUid); }

$('#dmBack').onclick = () => { dmOpenUid = null; dmView('list'); dmRender(); };
$('#dmForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#dmIn').value.trim();
  if (text && dmOpenUid && !sendPaced('dm', { t: 'dm', to: dmOpenUid, text })) return sys('연결이 끊겨서 보내지 못했어요. 다시 연결되면 보내 주세요.');
  $('#dmIn').value = '';
};
$('#dmClear').onclick = () => {
  const p = dmPeers.get(dmOpenUid);
  if (p && confirm(`${p.name} 님과의 대화를 내 화면에서 지울까요? 상대 화면에는 그대로 남아요.`)) send({ t: 'dm-clear', with: dmOpenUid });
};
$('#dmBlock').onclick = () => {
  const p = dmPeers.get(dmOpenUid), on = !dmBlocked.has(dmOpenUid);
  if (!p) return;
  if (!on || confirm(`${p.name} 님을 차단할까요? 이 사람의 쪽지는 더 이상 오지 않아요. 상대는 차단된 걸 알 수 없어요.`)) send({ t: 'dm-block', uid: dmOpenUid, on });
};

/* ---------- 새 쪽지: 상대 고르기 ---------- */
function renderPicker() {
  const q = $('#pkSearch').value.trim().toLowerCase(), ul = $('#pkList'); ul.replaceChildren();
  const list = dmMembers.filter((p) => !q || p.name.toLowerCase().includes(q));
  for (const p of list) {
    const status = p.blocked ? '차단함' : p.online ? '접속 중' : '접속 안 함';
    const btn = el('button', { type: 'button', className: 'conv', onclick: () => openDm(p.uid, p) },
      paintAvatar(el('span', { className: 'av' }), peerUser(p)),
      el('span', { className: 'who' }, el('b', { textContent: p.name }), el('small', { textContent: status })));
    btn.setAttribute('aria-label', `${p.name}, ${status}. 쪽지 보내기`);
    ul.append(el('li', {}, btn));
  }
  $('#pkEmpty').hidden = list.length > 0;
  $('#pkEmpty').textContent = dmMembers.length ? '찾는 사람이 없어요.' : '아직 다른 사람이 없어요.';
}
$('#dmNew').onclick = () => { dmView('picker'); $('#pkSearch').value = ''; send({ t: 'dm-members' }); renderPicker(); if (matchMedia('(pointer:fine)').matches) $('#pkSearch').focus(); };
$('#pkBack').onclick = () => dmView('list');
$('#pkSearch').oninput = renderPicker;

/* ---------- 서버 메시지 ---------- */
Object.assign(handlers, {
  dm(m) {
    const msg = m.msg, mine = msg.from === meUid, peerUid = mine ? msg.to : msg.from;
    const p = dmPeers.get(peerUid) || { uid: peerUid, unread: 0 };
    Object.assign(p, { name: m.peer.name, color: m.peer.color, last: { text: lastText(msg), ts: msg.ts, mine } });
    dmPeers.set(peerUid, p);
    const arr = dmThreads.get(peerUid), prev = arr?.at(-1); arr?.push(msg);
    const viewing = activeTab === 'dm' && dmOpenUid === peerUid && !$('#dmThread').hidden && !document.hidden;
    if (dmOpenUid === peerUid && !$('#dmMsgs').querySelector(`[data-id="${msg.id}"]`)) {
      const c = $('#dmMsgs'), atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
      if (!c.querySelector('.m')) c.replaceChildren(); // "아직 주고받은 쪽지가 없어요" 안내를 걷어 낸다
      if (!prev || new Date(prev.ts).toDateString() !== new Date(msg.ts).toDateString()) c.append(el('div', { className: 'sys day', textContent: dayLabel(msg.ts) }));
      c.append(dmBubble(msg)); dmReceipt(); if (atEnd || mine) dmScroll();
    }
    if (!mine) { if (viewing) { send({ t: 'dm-read', with: peerUid }); p.unread = 0; } else { p.unread = (p.unread || 0) + 1; ding(); } }
    dmRender();
  },
  'dm-thread'(m) {
    dmThreads.set(m.with, m.msgs);
    const p = dmPeers.get(m.with);
    if (p) {
      if (m.peer?.name) Object.assign(p, { name: m.peer.name, color: m.peer.color });
      const last = m.msgs.at(-1);
      if (last) p.last = { text: lastText(last), ts: last.ts, mine: last.from === meUid }; else delete p.last; // 지운 뒤에는 목록 미리보기도 맞춘다
    }
    if (dmOpenUid === m.with) dmDrawThread(m.msgs);
    dmRender();
  },
  'dm-read'(m) { const p = dmPeers.get(m.with); if (p) { p.unread = 0; dmRender(); } }, // 내 다른 기기에서 읽었을 때
  'dm-seen'(m) { // 상대가 내 쪽지를 읽었다
    const arr = dmThreads.get(m.by); if (arr) for (const x of arr) if (x.from === meUid) x.read = true;
    if (dmOpenUid === m.by) dmReceipt();
  },
  'dm-deleted'(m) {
    const arr = dmThreads.get(m.with); if (arr) dmThreads.set(m.with, arr.filter((x) => x.id !== m.id));
    if (dmOpenUid === m.with) { $('#dmMsgs').querySelector(`[data-id="${m.id}"]`)?.remove(); dmReceipt(); }
    send({ t: 'dm-history', with: m.with }); // 목록의 마지막 쪽지 미리보기를 다시 맞춘다
  },
  'dm-cleared'(m) {
    const p = dmPeers.get(m.with); if (p) { delete p.last; p.unread = 0; }
    dmThreads.delete(m.with);
    if (dmOpenUid === m.with) dmDrawThread([]);
    dmRender();
  },
  blocks(m) { dmBlocked = new Set(m.list); dmRender(); if (dmOpenUid) renderThreadHeader(); },
  members(m) { dmMembers = m.list; renderPicker(); },
  'dm-error'(m) { if (dmOpenUid) { $('#dmMsgs').append(el('div', { className: 'sys err', textContent: m.msg })); dmScroll(); } else sys(m.msg); },
});

// 알림을 눌러서 앱이 열렸을 때 (서비스 워커가 알려 준다)
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.t === 'open-dm' && e.data.uid && joined) openDm(e.data.uid); });
