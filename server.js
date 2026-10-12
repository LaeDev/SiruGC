const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const createMessages = require('./messages');

// config.env (선택): 한 줄에 KEY=VALUE, #으로 시작하면 주석. 이미 설정된 환경변수가 우선한다.
// 쉘 이스케이프 문제(특히 윈도우 배치파일에서 JSON)를 피하려고 스크립트가 아니라 서버가 직접 읽는다.
try {
  for (const line of fs.readFileSync(process.env.CONFIG_FILE || path.join(__dirname, 'config.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = process.env.PORT || 3000;
const TRUST_PROXY = !!process.env.TRUST_PROXY; // 리버스 프록시 뒤에서만 켤 것 (X-Forwarded-For 신뢰)
const DB = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const PUB = path.join(__dirname, 'public');

// 방은 하나. 호스트 키와 밴 목록만 state.json에 저장한다.
// 호스트 키를 잃어버렸으면 state.json의 hostKey를 지우고 재시작 → 다음 입장자가 호스트.
// ponytail: 밴 목록이 커지면 DB로 교체.
const room = {
  hostKey: null, bans: [], clients: new Map(), yt: null, seq: 0, queue: [], sharer: null, voice: new Map(),
  salt: null, vapid: null, members: {}, dms: {}, subs: {}, // 쪽지/알림: 접속한 적 있는 사람, 쪽지, 푸시 구독
};
try { Object.assign(room, JSON.parse(fs.readFileSync(DB, 'utf8'))); } catch {}
if (!room.salt) room.salt = crypto.randomBytes(16).toString('hex');       // uid(공개 번호)를 만들 때 쓰는 비밀 소금
if (!room.vapid) room.vapid = webpush.generateVAPIDKeys();                 // 푸시 서명 키 (개인 키는 서버 밖으로 나가지 않는다)

const save = () => fs.writeFileSync(DB, JSON.stringify({
  hostKey: room.hostKey, bans: room.bans, salt: room.salt, vapid: room.vapid, members: room.members, dms: room.dms, subs: room.subs,
}));
let saveTimer = null; // 쪽지처럼 자주 바뀌는 것은 0.3초 모아서 한 번에 쓴다
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; save(); }, 300); };
process.on('exit', () => { if (saveTimer) save(); });
save();

// 프록시(NPM/nginx)가 X-Forwarded-For 맨 뒤에 실제 접속자 IP를 덧붙이므로 마지막 값을 쓴다.
// 맨 앞 값은 접속자가 마음대로 넣을 수 있어서 쓰면 IP 밴을 피할 수 있다.
const clientIp = (req) => {
  const raw = TRUST_PROXY && req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',').pop().trim()
    : req.socket.remoteAddress;
  return raw.replace(/^::ffff:/, '');
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
// public/ 아래 파일만 서빙한다. 확장자 없는 경로는 index.html로 보낸다.
const server = http.createServer((req, res) => {
  // 서버가 살아 있는지 확인하는 주소. 꺼졌다가 돌아왔는지 클라이언트가 이걸로 본다.
  if (req.url === '/healthz') return res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
  const av = req.url.match(/^\/a\/([0-9a-f]{12})$/); // 쪽지 목록에서 오프라인인 사람의 프사를 보여 주려고
  if (av) {
    const a = messages.avatarOf(av[1]);
    return a ? res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' }).end(a.data) : res.writeHead(404).end();
  }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return res.writeHead(400).end(); }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(PUB, path.normalize(rel));
  if (!file.startsWith(PUB + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // 항상 재검증 (서비스 워커가 오프라인 대비를 맡음)
      'X-Content-Type-Options': 'nosniff',
    }).end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg, except) => room.clients.forEach((c) => c !== except && send(c, msg));
const userOf = (c) => ({ id: c.id, uid: c.uid, name: c.name, avatar: c.avatar, color: c.color, host: c.host });
const banList = () => room.bans.map(({ id, type, label }) => ({ id, type, label })); // IP 값은 노출하지 않음
const sendBans = () => room.clients.forEach((c) => c.host && send(c, { t: 'bans', bans: banList() }));
const isBanned = (ip, cid) => room.bans.some((b) => (b.type === 'ip' ? b.value === ip : b.value === cid));
const newId = (n = 4) => crypto.randomBytes(n).toString('hex');
const messages = createMessages({ room, send, newId, saveSoon });

// ---- WebRTC 연결 서버 목록 (화면 공유 / 음성) ----
// 집 밖 네트워크끼리는 STUN만으로 직접 연결이 안 되는 경우가 많아서 TURN(중계) 서버가 필요하다.
//  - TURN_URL=turn:도메인:3478,turns:도메인:5349  TURN_SECRET=...  → coturn의 use-auth-secret 방식. 접속마다 24시간짜리 임시 계정을 만든다.
//  - ICE_SERVERS='[{"urls":"turn:...","username":"...","credential":"..."}]' → 외부 TURN 서비스의 고정 계정을 그대로 쓸 때.
// 브라우저는 주소에 turn:/turns:/stun: 이 없으면 RTCPeerConnection 만들기 자체를 거부해서(SyntaxError) 화면 공유와 음성이 통째로 죽는다.
// 서비스 사이트에서 'host:3478' 처럼 접두어 없이 알려 주는 경우가 많아서 없으면 turn: 을 붙여 준다.
const iceUrl = (u) => { u = String(u).trim(); return /^(stuns?|turns?):/i.test(u) ? u : 'turn:' + u; };
let EXTRA_ICE = [];
try {
  EXTRA_ICE = [].concat(JSON.parse(process.env.ICE_SERVERS || '[]')).filter((s) => s && s.urls)
    .map((s) => ({ ...s, urls: [].concat(s.urls).map(iceUrl) }));
} catch { console.warn('ICE_SERVERS가 올바른 JSON이 아니라서 무시해요.'); }
function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }, ...EXTRA_ICE];
  const { TURN_URL, TURN_SECRET } = process.env;
  if (TURN_URL && TURN_SECRET) {
    const username = String(Math.floor(Date.now() / 1000) + 86400); // coturn은 사용자 이름을 만료 시각으로 읽는다
    list.push({ urls: TURN_URL.split(',').map(iceUrl), username, credential: crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64') });
  }
  return list;
}

// 음성 참가자: id → { muted }. 마이크 소리는 서버를 거치지 않고 참가자끼리 직접(또는 TURN 경유) 오간다.
const voiceMsg = () => ({ t: 'voice', list: [...room.voice].map(([id, v]) => ({ id, muted: v.muted })) });

// 프사/이모티콘 아바타는 클라이언트가 128px로 줄여 보낸 data URL만 허용 (img.src로만 쓰이므로 형식·크기만 검사)
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const cleanAvatar = (a) => (typeof a === 'string' && a.length <= 30000 && AVATAR_RE.test(a) ? a : null);
// 내 색: 아바타 배경/링/말풍선 띠에 쓰이는 #rrggbb 한 가지만 허용 (CSS에 들어가므로 형식 엄격 검사)
const cleanColor = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null);

// ---- 같이 보기: 지금 재생 중인 영상(room.yt)과 대기열(room.queue) ----
// 방의 재생 시계는 계속 흐른다. 일시정지는 각자의 것이라 서버는 모르고, 다시 틀 때 'yt-sync'로 시계에 맞춘다.
// seq는 영상마다 올라가는 번호: 여러 클라이언트가 동시에 '끝남'을 알려도 한 번만 다음으로 넘기기 위함.
function ytNow() {
  const y = room.yt;
  if (!y) return null;
  return { ...y, time: y.playing ? y.time + (Date.now() - y.at) / 1000 : y.time };
}
const queueMsg = () => ({
  t: 'queue',
  queue: room.queue.map(({ qid, videoId, title, by, byName }) => ({ qid, videoId, title, by, byName })),
});

// 유튜브 oEmbed로 제목을 가져온다 (실패하면 null → 영상 ID로 대체). 주소는 고정이고 ID는 형식 검사를 거친다.
async function ytTitle(videoId) {
  try {
    const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return String((await r.json()).title || '').slice(0, 100) || null;
  } catch { return null; }
}

function startVideo(item) {
  room.yt = {
    seq: ++room.seq, videoId: item.videoId, title: item.title, by: item.by, byName: item.byName,
    playing: true, time: 0, at: Date.now(),
  };
}
function broadcastYt() { if (room.yt) broadcast({ t: 'yt', ...ytNow() }); }
// 다음 영상으로. 대기열이 비면 '끝남' 상태로 두고 아무도 강제로 멈추지 않는다.
function advance() {
  const next = room.queue.shift();
  if (next) startVideo(next);
  else if (room.yt) room.yt = { ...room.yt, playing: false, ended: true, time: 0, at: Date.now() };
  broadcastYt();
  broadcast(queueMsg());
}
const canManage = (ws, by) => ws.host || by === ws.id; // 호스트이거나 올린 본인

async function queueAdd(ws, videoId) {
  if (!/^[\w-]{11}$/.test(videoId || '') || room.queue.length >= 50) return;
  const title = await ytTitle(videoId);
  room.queue.push({ qid: newId(), videoId, title: title || videoId, by: ws.id, byName: ws.name });
  if (!room.yt || room.yt.ended) advance(); else broadcast(queueMsg()); // 기다리는 사이 다른 사람이 틀었을 수 있어 여기서 다시 판단
}

function leave(ws) {
  if (!room.clients.delete(ws.id)) return;
  if (room.sharer === ws.id) { room.sharer = null; broadcast({ t: 'share-stop' }); }
  if (room.voice.delete(ws.id)) broadcast(voiceMsg());
  broadcast({ t: 'user-leave', id: ws.id });
  if (!room.clients.size) room.yt = null; // 아무도 없으면 영상 상태 초기화
}

function join(ws, m, ip) {
  if (typeof m.cid !== 'string' || m.cid.length < 8 || m.cid.length > 64) return;
  const created = !room.hostKey; // 맨 처음 들어온 사람이 호스트
  if (created) { room.hostKey = newId(16); save(); }
  const host = created || (typeof m.hostKey === 'string' && m.hostKey === room.hostKey);
  // 호스트는 밴 대상에서 제외 (같은 공유기 IP를 쓰는 호스트가 같이 잠기는 것 방지)
  if (!host && isBanned(ip, m.cid)) {
    send(ws, { t: 'banned' });
    return ws.close();
  }
  Object.assign(ws, {
    id: newId(), joined: true, ip, cid: m.cid, uid: messages.uidOf(m.cid), host, avatar: cleanAvatar(m.avatar), color: cleanColor(m.color),
    name: String(m.name || '').trim().slice(0, 20) || '익명', visible: true,
  });
  messages.remember(ws);
  if (!room.yt && room.queue.length) advance(); // 모두 나간 뒤 남은 대기열이 있으면 첫 입장자부터 이어서 재생
  send(ws, {
    t: 'joined', me: userOf(ws), hostKey: host ? room.hostKey : undefined,
    users: [...room.clients.values()].map(userOf), yt: ytNow(), queue: queueMsg().queue, sharer: room.sharer,
    voice: voiceMsg().list, ice: iceServers(),
    inbox: messages.inboxFor(ws.uid), vapid: room.vapid.publicKey, spoofs: messages.SPOOFS,
    bans: host ? banList() : undefined,
  });
  room.clients.set(ws.id, ws);
  broadcast({ t: 'user-join', user: userOf(ws) }, ws);
}

function ban(ws, m) {
  const target = room.clients.get(m.id);
  if (!target || target === ws || target.host) return;
  if (m.mode === 'user') room.bans.push({ id: newId(), type: 'cid', value: target.cid, label: target.name });
  else if (m.mode === 'ip') room.bans.push({ id: newId(), type: 'ip', value: target.ip, label: target.name });
  else if (m.mode !== 'kick') return;
  const victims = m.mode === 'ip'
    ? [...room.clients.values()].filter((c) => c.ip === target.ip && !c.host)
    : [target];
  victims.forEach((v) => { send(v, { t: 'banned', kick: m.mode === 'kick' }); v.close(); });
  if (m.mode !== 'kick') { save(); sendBans(); }
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('close', () => leave(ws));
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'join') return !ws.joined && join(ws, m, ip);
    if (!ws.joined) return;
    switch (m.t) {
      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 500);
        const now = Date.now();
        if (!text || now - (ws.lastChat || 0) < 300) return; // 도배 방지
        ws.lastChat = now;
        broadcast({ t: 'chat', id: ws.id, name: ws.name, text, ts: now });
        break;
      }
      case 'queue-add': queueAdd(ws, m.videoId); break;
      case 'queue-remove': {
        const item = room.queue.find((q) => q.qid === m.qid);
        if (!item || !canManage(ws, item.by)) return;
        room.queue = room.queue.filter((q) => q !== item);
        broadcast(queueMsg());
        break;
      }
      case 'queue-play': { // 대기열에서 골라 바로 재생
        const item = room.queue.find((q) => q.qid === m.qid);
        if (!item || !canManage(ws, item.by)) return;
        room.queue = room.queue.filter((q) => q !== item);
        startVideo(item);
        broadcastYt();
        broadcast(queueMsg());
        break;
      }
      case 'yt-next': // 건너뛰기: 호스트 또는 지금 영상을 올린 사람
        if (!room.yt || room.yt.ended || !canManage(ws, room.yt.by)) return;
        advance();
        break;
      case 'yt-ended': // 끝났거나 재생 못 하는 영상. seq가 맞을 때만 한 번 처리
        if (!room.yt || room.yt.ended || room.yt.seq !== m.seq) return;
        advance();
        break;
      case 'yt-seek': // 영상 위치 이동은 모두에게 적용 (일시정지만 개인 것)
        if (!room.yt || room.yt.ended) return;
        room.yt = { ...room.yt, playing: true, time: Math.max(0, Number(m.time) || 0), at: Date.now() };
        broadcast({ t: 'yt', ...ytNow() }, ws);
        break;
      case 'yt-sync': // 개인 일시정지 후 다시 틀 때: 방의 현재 위치를 알려 준다
        if (room.yt) send(ws, { t: 'yt', ...ytNow() });
        break;
      case 'rtc': {
        const to = room.clients.get(m.to);
        if (to) send(to, { t: 'rtc', from: ws.id, data: m.data });
        break;
      }
      case 'share-start':
        if (room.sharer && room.sharer !== ws.id) return send(ws, { t: 'share-denied' });
        room.sharer = ws.id;
        broadcast({ t: 'share-start', id: ws.id });
        break;
      case 'share-stop':
        if (room.sharer !== ws.id) return;
        room.sharer = null;
        broadcast({ t: 'share-stop' });
        break;
      case 'voice-join': room.voice.set(ws.id, { muted: false }); broadcast(voiceMsg()); break;
      case 'voice-leave': if (room.voice.delete(ws.id)) broadcast(voiceMsg()); break;
      case 'voice-mute':
        if (room.voice.has(ws.id)) { room.voice.get(ws.id).muted = !!m.muted; broadcast(voiceMsg()); }
        break;
      case 'ban':
        if (ws.host) ban(ws, m);
        break;
      default: messages.handle(ws, m); // 쪽지 / 푸시 알림 / 화면 보임 여부
      case 'unban':
        if (!ws.host) return;
        room.bans = room.bans.filter((b) => b.id !== m.id);
        save();
        sendBans();
        break;
    }
  });
});

setInterval(() => wss.clients.forEach((ws) => {
  if (!ws.alive) return ws.terminate();
  ws.alive = false;
  ws.ping();
}), 25000);

// 정상 종료(Ctrl+C, systemd stop 등): 접속자 화면에 '서버가 꺼졌습니다' 페이지가 바로 뜨도록 먼저 알린다.
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n${sig}를 받아서 접속자에게 알리고 서버를 끕니다.`);
  broadcast({ t: 'shutdown' });
  setTimeout(() => process.exit(0), 600); // 알림이 먼저 전달되도록 잠깐 기다린다
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

// 프록시 모드 기본값은 로컬 전용(127.0.0.1): 같은 PC의 nginx만 접근. 프록시가 Docker/다른 PC에 있으면 HOST=0.0.0.0 으로 열고
// 방화벽에서 프록시 IP만 허용할 것 (직접 접속자가 X-Forwarded-For를 위조해 IP 밴을 피하는 것 방지).
const HOST = process.env.HOST || (TRUST_PROXY ? '127.0.0.1' : undefined);
server.listen(PORT, HOST, () => {
  console.log(`방 채팅 서버가 켜졌어요.  이 PC에서: http://localhost:${PORT}`);
  if (!HOST || HOST === '0.0.0.0') {
    for (const i of Object.values(os.networkInterfaces()).flat()) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  같은 공유기 안 다른 기기에서: http://${i.address}:${PORT}`);
    }
  } else console.log(`  (${HOST}에서만 열려 있어요. 다른 기기에서 쓰려면 config.env에 HOST=0.0.0.0 을 적으세요)`);
  if (TRUST_PROXY) console.log('  프록시 모드: X-Forwarded-For의 마지막 값을 접속자 IP로 믿어요.');
  console.log('  끄려면 Ctrl+C');
});
