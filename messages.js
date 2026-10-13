// 쪽지(DM)와 웹 푸시 알림. server.js에서 한 번 만들어 쓴다.
//
// 신원: 클라이언트가 브라우저에 보관하는 비밀 식별자(cid)는 서버 밖으로 나가지 않는다. 다른 사람에게 보이는 공개 번호(uid)는
//       cid를 서버의 비밀 소금(room.salt)으로 해시한 값이다. uid는 알려져도 그것으로 남의 쪽지를 읽을 수 없다.
// 저장: 쪽지는 서버(state.json)에 30일 보관한다 (오프라인인 사람에게도 전달하려면 저장이 필요하다).
const webpush = require('web-push');
const crypto = require('crypto');

const KEEP_MS = 30 * 86400e3;
const MAX_PER_CONV = 200, MAX_SUBS = 5, MAX_MEMBERS = 300;

// 알림 위장: 알림의 이름·내용·아이콘과 탭 제목을 평범한 것으로 바꾼다. 특정 서비스를 흉내 내지 않는 일반적인 이름만 쓴다.
const SPOOFS = {
  off: { label: '끔 (보낸 사람과 내용이 그대로 보여요)' },
  hide: { label: '내용 숨기기', title: '새 알림', body: '새로운 알림이 도착했어요', icon: '/icons/icon-192.png' },
  study: { label: '학습 도우미', title: '학습 도우미', body: '새 알림 1개', icon: '/icons/spoof-study.png', tab: '학습 도우미 - 과제' },
  docs: { label: '문서 편집기', title: '문서 편집기', body: '공유 문서에 변경 사항이 있어요', icon: '/icons/spoof-docs.png', tab: '제목 없는 문서' },
  calc: { label: '계산기', title: '계산기', body: '새 알림 1개', icon: '/icons/spoof-calc.png', tab: '계산기' },
};

// 푸시 주소는 브라우저 제조사의 푸시 서비스만 허용한다. 아무 주소나 받으면 서버가 남이 정한 주소로 요청을 보내게 된다(SSRF).
const PUSH_HOST_OK = /(^|\.)(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

module.exports = function createMessages({ room, send, newId, saveSoon, cleanMedia }) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://sirugc.kro.kr', room.vapid.publicKey, room.vapid.privateKey);

  const uidOf = (cid) => crypto.createHmac('sha256', room.salt).update(cid).digest('hex').slice(0, 12);
  const convKey = (a, b) => [a, b].sort().join('~');
  const clientsOf = (uid) => [...room.clients.values()].filter((c) => c.uid === uid);
  const pub = ({ id, from, to, text, media, ts, read }) => ({ id, from, to, text, media, ts, read: !!read });
  const clearedAt = (uid, peer) => room.cleared[uid + '>' + peer] || 0;
  // uid가 볼 수 있는 쪽지: 대화를 정리한 시각 이후이고, 차단 때문에 내게 전달되지 않은(drop) 쪽지가 아닌 것
  const visibleTo = (uid, peer, list) => (list || []).filter((m) => m.ts > clearedAt(uid, peer) && !(m.drop && m.to === uid));
  const blocksOf = (uid) => room.blocks[uid] || [];
  const label = (msg) => msg.text || (msg.media?.kind === 'video' ? '(동영상)' : '(사진)'); // 글 없이 첨부만 보낸 쪽지의 미리보기
  const peerInfo = (uid) => {
    const m = room.members[uid];
    return { uid, name: m?.name || '알 수 없음', color: m?.color || null, online: clientsOf(uid).some((c) => !c.ghost) }; // 방금 끊겨서 돌아오기를 기다리는 사람(ghost)은 접속 중으로 치지 않는다
  };

  // 접속할 때 알려 둔다: 이름·프사·색을 기억해 두면 오프라인인 사람에게도 쪽지를 보낼 수 있다.
  function remember(ws) {
    room.members[ws.uid] = { name: ws.name, avatar: ws.avatar, color: ws.color, seen: Date.now() };
    const uids = Object.keys(room.members);
    if (uids.length > MAX_MEMBERS) { // 쪽지 기록이 없는 가장 오래된 사람부터 잊는다
      const hasDm = new Set(Object.keys(room.dms).flatMap((k) => k.split('~')));
      uids.filter((u) => !hasDm.has(u) && !clientsOf(u).length).sort((a, b) => room.members[a].seen - room.members[b].seen)
        .slice(0, uids.length - MAX_MEMBERS).forEach((u) => { delete room.members[u]; delete room.subs[u]; });
    }
    saveSoon();
  }

  function inboxFor(uid) {
    const out = [];
    for (const [k, list] of Object.entries(room.dms)) {
      const [a, b] = k.split('~');
      if (a !== uid && b !== uid) continue;
      const peer = a === uid ? b : a, vis = visibleTo(uid, peer, list);
      if (!vis.length) continue; // 정리했거나 차단으로 안 보이는 대화는 목록에 올리지 않는다
      const last = vis[vis.length - 1];
      out.push({ ...peerInfo(peer), last: { text: label(last), ts: last.ts, mine: last.from === uid }, unread: vis.filter((m) => m.to === uid && !m.read).length, blocked: blocksOf(uid).includes(peer) });
    }
    return out.sort((x, y) => y.last.ts - x.last.ts);
  }

  function prune() {
    const cut = Date.now() - KEEP_MS;
    for (const [k, list] of Object.entries(room.dms)) {
      room.dms[k] = list.filter((m) => m.ts > cut);
      if (!room.dms[k].length) delete room.dms[k];
    }
    saveSoon();
  }

  // ---- 푸시 ----
  function payloadFor(mode, fromName, text, fromUid) {
    const sp = SPOOFS[mode];
    if (sp?.title) return { title: sp.title, body: sp.body, icon: sp.icon, tag: 'n' }; // 보낸 사람도 내용도 싣지 않는다
    return { title: fromName, body: text.slice(0, 120), tag: 'dm-' + fromUid, uid: fromUid };
  }
  async function pushOne(uid, sub, payload) {
    try {
      if (process.env.PUSH_DEBUG_URL) { // 테스트 전용: 실제 푸시 서비스 대신 이 주소로 알림 내용을 보낸다
        const r = await fetch(process.env.PUSH_DEBUG_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid, endpoint: sub.endpoint, payload }) });
        if (!r.ok) throw Object.assign(new Error('sink'), { statusCode: r.status });
      } else await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { // 만료된 구독은 지운다
        room.subs[uid] = (room.subs[uid] || []).filter((s) => s.endpoint !== sub.endpoint);
        saveSoon();
      } else console.warn('푸시를 보내지 못했어요:', e.statusCode || e.message);
    }
  }
  // force: 테스트 알림처럼 화면을 보고 있어도 보낼 때
  function pushTo(uid, fromName, text, fromUid, { force = false } = {}) {
    if (!force && clientsOf(uid).some((c) => c.visible && !c.ghost && Date.now() - (c.lastMsgAt || 0) < 45000)) return; // 화면을 켜 놓은 척 멈춰 있는(꺼진 폰) 연결은 보고 있는 것으로 치지 않는다 // 화면을 보고 있으면 앱 안 알림으로 충분하다
    for (const s of room.subs[uid] || []) if (s.prefs.dm) pushOne(uid, s, payloadFor(s.prefs.spoof, fromName, text, fromUid));
  }

  function addSub(ws, m) {
    const s = m.sub;
    if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 600 || !s.keys?.p256dh || !s.keys?.auth) return;
    if (!process.env.PUSH_DEBUG_URL) {
      let u; try { u = new URL(s.endpoint); } catch { return; }
      if (u.protocol !== 'https:' || !PUSH_HOST_OK.test(u.hostname)) return;
    }
    const prefs = { dm: m.prefs?.dm !== false, spoof: SPOOFS[m.prefs?.spoof] ? m.prefs.spoof : 'off' };
    const list = (room.subs[ws.uid] ||= []);
    const keys = { p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 100) };
    const ex = list.find((x) => x.endpoint === s.endpoint);
    if (ex) Object.assign(ex, { keys, prefs });
    else { list.push({ endpoint: s.endpoint, keys, prefs }); if (list.length > MAX_SUBS) list.shift(); }
    saveSoon();
    send(ws, { t: 'push-ok' });
  }

  // ---- 쪽지 ----
  function sendDm(ws, m) {
    const text = String(m.text || '').trim().slice(0, 500), to = String(m.to || ''), now = Date.now();
    const media = cleanMedia ? cleanMedia(m.media) : null;
    if ((!text && !media) || to === ws.uid || !room.members[to] || now - (ws.lastDm || 0) < 400) return; // 빈 글, 나에게, 모르는 사람, 도배
    if (blocksOf(ws.uid).includes(to)) return send(ws, { t: 'dm-error', msg: '차단한 사람에게는 쪽지를 보낼 수 없어요. 차단을 풀어 주세요.' });
    ws.lastDm = now;
    // 상대가 나를 차단했으면: 나에게는 보낸 것처럼 보이지만(차단 사실을 드러내지 않으려고) 상대에게는 전달도 알림도 가지 않는다
    const dropped = blocksOf(to).includes(ws.uid);
    const msg = { id: newId(), from: ws.uid, to, text, media: media || undefined, ts: now, read: false, drop: dropped || undefined };
    const list = (room.dms[convKey(ws.uid, to)] ||= []);
    list.push(msg);
    if (list.length > MAX_PER_CONV) list.shift();
    saveSoon();
    for (const c of room.clients.values()) if (c.uid === ws.uid || (c.uid === to && !dropped)) send(c, { t: 'dm', msg: pub(msg), peer: peerInfo(c.uid === ws.uid ? to : ws.uid) });
    if (!dropped) pushTo(to, ws.name, label(msg), ws.uid);
  }

  // 메시지 처리: server.js의 switch에서 모르는 종류를 넘겨 받는다. 처리했으면 true.
  function handle(ws, m) {
    switch (m.t) {
      case 'dm': sendDm(ws, m); return true;
      case 'dm-history': {
        const peer = String(m.with || '');
        send(ws, { t: 'dm-thread', with: peer, peer: { ...peerInfo(peer), blocked: blocksOf(ws.uid).includes(peer) }, msgs: visibleTo(ws.uid, peer, room.dms[convKey(ws.uid, peer)]).slice(-100).map(pub) });
        return true;
      }
      case 'dm-read': {
        const peer = String(m.with || '');
        let newly = 0;
        for (const x of room.dms[convKey(ws.uid, peer)] || []) if (x.to === ws.uid && !x.read && !x.drop) { x.read = true; newly++; }
        saveSoon();
        for (const c of clientsOf(ws.uid)) if (c !== ws) send(c, { t: 'dm-read', with: peer }); // 내 다른 기기의 안 읽음 표시도 지운다
        if (newly) for (const c of clientsOf(peer)) send(c, { t: 'dm-seen', by: ws.uid }); // 보낸 사람 화면에 '읽음'을 띄운다
        return true;
      }
      case 'dm-delete': { // 내가 보낸 쪽지를 양쪽에서 지운다 (남이 보낸 건 못 지움)
        const peer = String(m.with || ''), key = convKey(ws.uid, peer), list = room.dms[key] || [];
        const i = list.findIndex((x) => x.id === m.id && x.from === ws.uid);
        if (i < 0) return true;
        const [gone] = list.splice(i, 1);
        if (!list.length) delete room.dms[key];
        saveSoon();
        for (const c of room.clients.values()) {
          if (c.uid === ws.uid) send(c, { t: 'dm-deleted', id: gone.id, with: peer });
          else if (c.uid === peer && !gone.drop) send(c, { t: 'dm-deleted', id: gone.id, with: ws.uid });
        }
        return true;
      }
      case 'dm-clear': { // 대화 정리: 내 화면에서만 지운다 (상대는 그대로)
        const peer = String(m.with || '');
        room.cleared[ws.uid + '>' + peer] = Date.now();
        saveSoon();
        for (const c of clientsOf(ws.uid)) send(c, { t: 'dm-cleared', with: peer });
        return true;
      }
      case 'dm-block': { // 차단/해제
        const uid = String(m.uid || '');
        if (uid === ws.uid || !room.members[uid]) return true;
        const set = new Set(blocksOf(ws.uid)); m.on ? set.add(uid) : set.delete(uid);
        room.blocks[ws.uid] = [...set]; if (!set.size) delete room.blocks[ws.uid];
        saveSoon();
        for (const c of clientsOf(ws.uid)) send(c, { t: 'blocks', list: blocksOf(ws.uid) });
        return true;
      }
      case 'dm-members': { // 새 쪽지를 시작할 사람 고르기: 접속한 적 있는 모든 사람 (접속 중인 사람이 먼저)
        const mine = new Set(blocksOf(ws.uid));
        const list = Object.keys(room.members).filter((u) => u !== ws.uid).map((u) => ({ ...peerInfo(u), blocked: mine.has(u) }))
          .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name, 'ko'));
        send(ws, { t: 'members', list });
        return true;
      }
      case 'push-sub': addSub(ws, m); return true;
      case 'push-unsub':
        room.subs[ws.uid] = (room.subs[ws.uid] || []).filter((s) => s.endpoint !== m.endpoint);
        saveSoon();
        return true;
      case 'push-test': pushTo(ws.uid, '테스트', '알림이 이렇게 보여요', ws.uid, { force: true }); return true;
      case 'vis': ws.visible = !!m.v; return true;
      default: return false;
    }
  }

  // /a/<uid> 로 보여 줄 아바타 이미지 (오프라인인 사람의 프사를 쪽지 목록에 쓰려고)
  function avatarOf(uid) {
    const m = room.members[uid]?.avatar?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    return m && { type: m[1], data: Buffer.from(m[2], 'base64') };
  }

  prune();
  setInterval(prune, 3600e3).unref();
  return { SPOOFS, uidOf, remember, inboxFor, blocksOf, handle, avatarOf, peerInfo };
};
