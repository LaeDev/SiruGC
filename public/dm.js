/* ================= 쪽지 (DM) ================= */
// 상대는 공개 번호(uid)로 부른다. 목록은 서버가 입장할 때 알려 주고, 새 쪽지는 'dm' 메시지로 실시간으로 온다.
// 화면은 세 가지: 대화 목록(+새 쪽지) / 새 쪽지 상대 고르기 / 대화창.
let meUid = null;
let dmKid = null;            // 서버가 알려 준 내 지금 쪽지 키 번호 (이 기기의 키와 같아야 쪽지를 풀 수 있다)
const dmPeers = new Map();   // uid → { uid, name, color, last:{enc,text,ts,mine}, unread, blocked }
const dmThreads = new Map(); // uid → 불러온 쪽지 기록
let dmOpenUid = null;        // 지금 열어 둔 대화 상대
let dmBlocked = new Set();   // 내가 차단한 사람들
let dmMembers = [];          // 새 쪽지 상대 고르기용 전체 회원

// 쪽지만 쓰는 사람은 방 참가자 목록을 받지 않아서, 대화를 열 때 서버가 알려 준 접속 여부를 쓴다
const dmOnline = (uid) => users.some((u) => u.uid === uid) || (dmOnly && !!dmPeers.get(uid)?.online);
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
// 쪽지는 암호문으로 오고, 이 기기에서 푼 내용이 msg.pt = { t: 글, m: 첨부 }. 풀 수 없으면 pt가 null
const dmLocked = () => !!meUid && !(e2eeKey && e2eeKey.kid === dmKid);
const lastText = (m) => (m.pt ? m.pt.t || (m.pt.m?.kind === 'video' ? '(동영상)' : '(사진)') : '암호화된 쪽지');
const dmReveal = async (msgs) => { for (const x of [].concat(msgs)) x.pt = await dmDecrypt(x); };
let dmChain = Promise.resolve(); // 풀리는 동안 다음 소식이 앞질러 처리되지 않게 차례로 처리한다
const dmSerial = (fn) => (m) => { dmChain = dmChain.then(() => fn(m)).catch((e) => console.warn(e)); };
async function dmPreviews() { // 대화 목록의 마지막 쪽지 미리보기를 이 기기에서 푼다
  for (const p of dmPeers.values()) {
    if (!p.last?.enc || p.last.text !== undefined) continue;
    const x = { from: p.last.mine ? meUid : p.uid, to: p.last.mine ? p.uid : meUid, enc: p.last.enc };
    await dmReveal(x); p.last.text = lastText(x);
  }
  dmRender();
}

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
  meUid = m.me.uid || null; dmKid = m.kid || null; // 게스트는 null
  dmPeers.clear(); dmThreads.clear(); dmOpenUid = null; dmBlocked = new Set(m.blocks || []);
  for (const c of m.inbox || []) dmPeers.set(c.uid, c);
  dmView('list'); dmRender();
  e2eeReady.then(() => { dmView(dmOpenUid ? 'thread' : 'list'); dmPreviews(); }); // 이 기기의 키를 읽은 뒤에 잠금 여부와 미리보기를 정한다
}
function dmRefresh() { dmRender(); }
// 끊겼다 이어받았을 때: 끊겨 있던 동안 온 쪽지를 받은편지함에 반영하고, 열려 있는 대화는 기록을 다시 불러온다
function dmResync(m) {
  dmBlocked = new Set(m.blocks || []);
  for (const c of m.inbox || []) dmPeers.set(c.uid, { ...dmPeers.get(c.uid), ...c });
  dmKid = m.kid || null; dmRender(); dmPreviews();
  if (dmOpenUid) send({ t: 'dm-history', with: dmOpenUid });
}

/* ---------- 화면 전환 ---------- */
function dmView(name) { // 'list' | 'picker' | 'thread' (이 기기에 쪽지 키가 없으면 무엇이든 'lock')
  if (dmLocked()) name = 'lock';
  $('#dmLock').hidden = name !== 'lock';
  $('#dmListWrap').hidden = name !== 'list' || !meUid;
  $('#dmGuest').hidden = !!meUid || name !== 'list';
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
      el('span', { className: 'who' }, el('b', {}, p.name, p.prev ? el('small', { className: 'prev', textContent: ' 이전: ' + p.prev }) : ''), el('small', { textContent: (blocked ? '차단함 · ' : '') + (p.last.mine ? '나: ' : '') + (p.last.text ?? '') })),
      side);
    btn.setAttribute('aria-label', `${p.name}${blocked ? ' (차단함)' : ''}, ${p.unread ? `안 읽은 쪽지 ${p.unread}개, ` : ''}마지막 쪽지: ${p.last.text ?? ''}`);
    ul.append(el('li', {}, btn));
  }
  $('#dmEmpty').hidden = list.length > 0;
  if (dmOpenUid) renderThreadHeader();
}
function renderThreadHeader() {
  const p = dmPeers.get(dmOpenUid), who = $('#dmWho'), blocked = dmBlocked.has(dmOpenUid);
  who.replaceChildren();
  if (p) who.append(paintAvatar(el('span', { className: 'av' }), peerUser(p)), el('span', { textContent: p.name }), p.prev ? el('small', { className: 'prev', textContent: '이전: ' + p.prev }) : '', dmOnline(p.uid) ? el('span', { className: 'on', textContent: '접속 중' }) : '');
  const b = $('#dmBlock');
  b.textContent = blocked ? '차단 해제' : '이 사람 차단'; b.classList.toggle('stop', blocked);
  $('#dmBlockedNote').hidden = !blocked;
  const closed = blocked || !!p?.deleted;
  $('#dmIn').disabled = $('#dmAttachBtn').disabled = $('#dmForm button[type=submit]').disabled = closed;
  $('#dmIn').placeholder = blocked ? '차단한 사람에게는 보낼 수 없어요' : p?.deleted ? '탈퇴한 사용자에게는 보낼 수 없어요' : '쪽지를 입력하세요';
  encBadge();
}

/* ---------- 암호화 확인: 안전번호, 서버가 보관하는 모습, 상대의 키가 바뀌었을 때 알림 ----------
   안전번호 = 두 사람의 공개 키에서 만든 숫자 24자리 (양쪽 화면에서 같아야 한다). 같으면 중간에서 키를 바꿔치기한 사람이 없다는 뜻이다.
   (tools/_e2e.js 의 safetyNumber 와 같은 방식이다. 바꾸면 같이 바꾼다) */
const encDlg = $('#encDlg');
const peerKey = (uid) => e2eeCur.get(uid); // { kid, pub }
const safeKey = (uid) => 'safe:' + uid;
const isVerified = (uid) => { const k = peerKey(uid); return !!k && !!e2eeKey && get(safeKey(uid)) === k.kid + '|' + e2eeKey.kid; };
function encBadge() {
  const b = $('#dmEnc'), uid = dmOpenUid, k = uid && peerKey(uid), ver = !!k && isVerified(uid);
  $('#dmEncTxt').textContent = !k ? '상대 준비 전' : ver ? '확인됨' : '암호화됨';
  b.classList.toggle('ok', ver);
  b.title = !k ? '상대가 아직 쪽지 보안 키를 만들지 않았어요' : ver ? '안전번호를 확인한 대화예요' : '눌러서 암호화되는지 확인해요';
}
async function safetyNumber(peerUid, peerPub) {
  const mine = e2eeCur.get(meUid)?.pub; if (!mine || !peerPub) return null;
  const [a, b] = [[meUid, mine], [peerUid, peerPub]].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', e2eeText.encode(['siru-safety-v1', a[0], a[1], b[0], b[1]].join('|'))));
  return [0, 1, 2, 3, 4, 5].map((i) => String((((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0) % 10000).padStart(4, '0'));
}
function dmKeyCheck(uid) { // 상대의 키가 지난번에 본 것과 다르면 알린다 (처음 보는 키는 그냥 기억해 둔다)
  const k = peerKey(uid); if (!k) return;
  const prev = get('peerKid:' + uid);
  if (!prev) set('peerKid:' + uid, k.kid);
  $('#dmKeyWarn').hidden = !(prev && prev !== k.kid && dmOpenUid === uid);
}
async function encOpen() {
  const uid = dmOpenUid; if (!uid || dmLocked()) return;
  if (!e2eeCur.has(meUid)) await e2eeKeysOf(meUid);
  if (!peerKey(uid)) await e2eeKeysOf(uid);
  const k = peerKey(uid), p = dmPeers.get(uid), name = p?.name || '상대';
  $('#encLead').textContent = k ? `${name} 님과 주고받는 쪽지는 두 사람의 기기에서만 풀 수 있게 암호화돼요.` : `${name} 님이 아직 쪽지 보안 키를 만들지 않았어요. 상대가 한 번 로그인하면 암호화해서 보낼 수 있어요.`;
  const nums = k ? await safetyNumber(uid, k.pub) : null;
  $('#encNum').replaceChildren(...(nums || ['—']).map((n) => el('span', { textContent: n })));
  $('#encState').textContent = !nums ? '' : isVerified(uid) ? '이 번호를 확인했어요.' : '아직 확인하지 않았어요.';
  $('#encOk').hidden = $('#encDiff').hidden = !nums;
  const last = (dmThreads.get(uid) || []).filter((x) => x.enc).at(-1);
  $('.enc-cmp').hidden = !last;
  $('#encHow').textContent = last ? '가장 최근 쪽지가 서버에 저장된 모습이에요. 알아볼 수 없는 문자열이라 서버는 읽을 수 없고, 내 기기에서만 아래처럼 풀려요.' : '아직 주고받은 쪽지가 없어요. 쪽지를 하나 보내면 서버에 저장된 모습을 볼 수 있어요.';
  if (last) {
    $('#encCt').textContent = last.enc.ct.slice(0, 160) + (last.enc.ct.length > 160 ? '…' : '');
    $('#encPt').textContent = last.pt ? last.pt.t || (last.pt.m ? '(사진·동영상)' : '') : '이 기기에서는 풀 수 없는 쪽지예요.';
  }
  if (typeof encDlg.showModal === 'function') { if (!encDlg.open) encDlg.showModal(); } else { encDlg.setAttribute('open', ''); encDlg.classList.add('fallback'); }
}
const encClose = () => { if (typeof encDlg.close === 'function') encDlg.close(); else encDlg.removeAttribute('open'); };
$('#dmEnc').onclick = encOpen;
$('#dmKeyWarnGo').onclick = encOpen;
$('#dmKeyAccept').onclick = () => { const k = peerKey(dmOpenUid); if (k) set('peerKid:' + dmOpenUid, k.kid); $('#dmKeyWarn').hidden = true; };
$('#encClose').onclick = (e) => { e.preventDefault(); encClose(); };
encDlg.addEventListener('click', (e) => { if (e.target === encDlg) encClose(); });
$('#encOk').onclick = () => { const k = peerKey(dmOpenUid); if (!k || !e2eeKey) return; set(safeKey(dmOpenUid), k.kid + '|' + e2eeKey.kid); $('#encState').textContent = '이 번호를 확인했어요.'; encBadge(); $('#dmKeyWarn').hidden = true; set('peerKid:' + dmOpenUid, k.kid); };
$('#encDiff').onclick = () => { set(safeKey(dmOpenUid), ''); $('#encState').textContent = '번호가 다르면 이 대화를 믿지 마세요. 그 사람에게 통화나 직접 만나는 다른 방법으로 연락해서 확인해 주세요.'; encBadge(); };

/* ---------- 대화창 ---------- */
function dmBubble(msg) {
  const mine = msg.from === meUid;
  const p = dmPeers.get(mine ? msg.to : msg.from);
  const who = mine ? { ...(users.find((u) => u.id === me) || {}), name: '나' } : peerUser(p || { uid: msg.from, name: '?' });
  const bubble = el('div', { className: 'bubble' },
    el('header', {}, el('b', { textContent: mine ? '나' : who.name }), el('time', { textContent: dmTime(msg.ts) })),
    ...(!msg.pt ? [el('p', { className: 'hint', textContent: '이 기기에서는 풀 수 없는 쪽지예요. 이 기기에 보안 키가 없거나, 상대의 키가 바뀌기 전에 온 쪽지예요.' })] : msg.pt.t ? [el('p', { textContent: msg.pt.t })] : []));
  if (msg.pt?.m) bubble.append(mediaNode(msg.pt.m));
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
  c.querySelectorAll('.media img').forEach((im) => { if (!im.complete) im.addEventListener('load', dmScroll, { once: true }); });
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
  dmOpenUid = uid; $('#dmKeyWarn').hidden = true;
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

const dmMenu = (open) => { $('#dmMenu').hidden = !open; $('#dmMore').setAttribute('aria-expanded', open); };
$('#dmMore').onclick = (e) => { e.stopPropagation(); dmMenu($('#dmMenu').hidden); };
$('#dmMenu').addEventListener('click', () => dmMenu(false));
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) dmMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dmMenu').hidden) { dmMenu(false); $('#dmMore').focus(); } });
$('#dmBack').onclick = () => { dmMenu(false); dmOpenUid = null; dmView('list'); dmRender(); };
// 암호화해서 보낸다. 보내지 못하면 이유를 알려 주고 입력한 글은 그대로 둔다 (true: 보냄)
let dmPend = null; // 마지막으로 보낸 쪽지: 상대 키가 바뀌어 서버가 돌려보내면 새 키로 한 번 더 보낸다
async function dmSend(to, text, media, tries = 0) {
  const fail = (msg) => { handlers['dm-error']({ msg }); return false; };
  if (dmLocked()) return fail('쪽지 보안 키가 잠겨 있어요. 쪽지 목록에서 비밀번호로 열어 주세요.');
  let enc;
  try { enc = await dmEncrypt(to, { t: text, m: media }); }
  catch (e) { return fail(e.message === 'nopeer' ? '상대가 아직 보안 쪽지를 받을 준비가 안 됐어요. 상대가 한 번 로그인하면 보낼 수 있어요.' : '쪽지를 암호화하지 못했어요. 새로고침한 뒤 다시 해 주세요.'); }
  dmPend = { to, text, media, tries };
  return sendPaced('dm', { t: 'dm', to, enc }) || fail('연결이 끊겨서 보내지 못했어요. 다시 연결되면 보내 주세요.');
}
$('#dmForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#dmIn').value.trim();
  if (text && dmOpenUid && !(await dmSend(dmOpenUid, text))) return;
  $('#dmIn').value = '';
};
$('#dmLock').onsubmit = async (e) => { // 이 기기에서 처음 쪽지를 쓸 때: 계정 비밀번호로 보안 키를 연다
  e.preventDefault();
  const pw = $('#dmLockPw').value, msg = $('#dmLockMsg'), go = $('#dmLockGo');
  if (!pw) return;
  go.disabled = true; msg.textContent = '여는 중이에요…';
  const r = await e2eeUnlock(pw); go.disabled = false;
  if (!r.ok) return void (msg.textContent = r.msg || '열지 못했어요. 비밀번호를 확인해 주세요.');
  $('#dmLockPw').value = ''; msg.textContent = '';
  dmKid = e2eeKey.kid; dmThreads.clear();
  for (const p of dmPeers.values()) if (p.last) delete p.last.text;
  dmView(dmOpenUid ? 'thread' : 'list'); await dmPreviews();
  if (dmOpenUid) send({ t: 'dm-history', with: dmOpenUid });
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
  dm: dmSerial(async (m) => {
    const msg = m.msg, mine = msg.from === meUid, peerUid = mine ? msg.to : msg.from;
    await dmReveal(msg);
    if (mine) dmPend = null;
    const p = dmPeers.get(peerUid) || { uid: peerUid, unread: 0 };
    Object.assign(p, { name: m.peer.name, color: m.peer.color, last: { text: lastText(msg), ts: msg.ts, mine } });
    dmPeers.set(peerUid, p);
    const arr = dmThreads.get(peerUid), prev = arr?.at(-1); arr?.push(msg);
    const viewing = activeTab === 'dm' && dmOpenUid === peerUid && !$('#dmThread').hidden && !document.hidden;
    if (dmOpenUid === peerUid && !$('#dmMsgs').querySelector(`[data-id="${msg.id}"]`)) {
      const c = $('#dmMsgs'), atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
      if (!c.querySelector('.m')) c.replaceChildren(); // "아직 주고받은 쪽지가 없어요" 안내를 걷어 낸다
      if (!prev || new Date(prev.ts).toDateString() !== new Date(msg.ts).toDateString()) c.append(el('div', { className: 'sys day', textContent: dayLabel(msg.ts) }));
      c.append(dmBubble(msg)); dmReceipt(); if (atEnd || mine) { dmScroll(); c.lastElementChild.querySelectorAll('.media img').forEach((im) => { if (!im.complete) im.addEventListener('load', dmScroll, { once: true }); }); }
    }
    if (!mine) { if (viewing) { send({ t: 'dm-read', with: peerUid }); p.unread = 0; } else { p.unread = (p.unread || 0) + 1; ding(); } }
    dmRender();
  }),
  'dm-thread': dmSerial(async (m) => {
    e2eeNote(m.with, m.peer?.kid, m.peer?.pub); dmKeyCheck(m.with);
    await dmReveal(m.msgs);
    dmThreads.set(m.with, m.msgs);
    const p = dmPeers.get(m.with);
    if (p) {
      if (m.peer?.name) Object.assign(p, { name: m.peer.name, color: m.peer.color, online: m.peer.online, prev: m.peer.prev || '', deleted: m.peer.deleted });
      const last = m.msgs.at(-1);
      if (last) p.last = { text: lastText(last), ts: last.ts, mine: last.from === meUid }; else delete p.last; // 지운 뒤에는 목록 미리보기도 맞춘다
    }
    if (dmOpenUid === m.with) dmDrawThread(m.msgs);
    dmRender();
  }),
  'dm-rekey'(m) { // 상대의 키가 바뀌어 있었다: 새 키로 한 번 더 암호화해서 보낸다
    e2eeNote(m.uid, m.kid, m.pub);
    if (dmPend?.to === m.uid && dmPend.tries < 1) dmSend(dmPend.to, dmPend.text, dmPend.media, 1);
    else handlers['dm-error']({ msg: '상대의 보안 키가 바뀌어서 보내지 못했어요. 다시 보내 주세요.' });
  },
  'dm-read'(m) { const p = dmPeers.get(m.with); if (p) { p.unread = 0; dmRender(); } }, // 내 다른 기기에서 읽었을 때
  'dm-seen'(m) { // 상대가 내 쪽지를 읽었다
    const arr = dmThreads.get(m.by); if (arr) for (const x of arr) if (x.from === meUid) x.read = true;
    if (dmOpenUid === m.by) dmReceipt();
  },
  'dm-deleted': dmSerial(async (m) => {
    const arr = dmThreads.get(m.with); if (arr) dmThreads.set(m.with, arr.filter((x) => x.id !== m.id));
    if (dmOpenUid === m.with) { $('#dmMsgs').querySelector(`[data-id="${m.id}"]`)?.remove(); dmReceipt(); }
    send({ t: 'dm-history', with: m.with }); // 목록의 마지막 쪽지 미리보기를 다시 맞춘다
  }),
  'dm-cleared': dmSerial(async (m) => {
    const p = dmPeers.get(m.with); if (p) { delete p.last; p.unread = 0; }
    dmThreads.delete(m.with);
    if (dmOpenUid === m.with) dmDrawThread([]);
    dmRender();
  }),
  blocks(m) { dmBlocked = new Set(m.list); dmRender(); if (dmOpenUid) renderThreadHeader(); },
  members(m) { dmMembers = m.list; renderPicker(); },
  'dm-error'(m) {
    if (m.code === 'no-key') { dmKid = '?'; dmView('list'); } // 서버가 알고 있는 내 키와 이 기기의 키가 다르다: 다시 열게 한다
    if (dmOpenUid) { $('#dmMsgs').append(el('div', { className: 'sys err', textContent: m.msg })); dmScroll(); } else sys(m.msg);
  },
});

// 알림을 눌러서 앱이 열렸을 때 (서비스 워커가 알려 준다)
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.t === 'open-dm' && e.data.uid && joined) openDm(e.data.uid); });
