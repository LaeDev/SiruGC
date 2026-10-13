const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');
const createMessages = require('./messages');
const createUploads = require('./uploads');
const createAccounts = require('./accounts');

// config.env (선택): 한 줄에 KEY=VALUE, #으로 시작하면 주석. 이미 설정된 환경변수가 우선한다.
// 쉘 이스케이프 문제(특히 윈도우 배치파일에서 JSON)를 피하려고 스크립트가 아니라 서버가 직접 읽는다.
try {
  for (const line of fs.readFileSync(process.env.CONFIG_FILE || path.join(__dirname, 'config.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = process.env.PORT || 3000;
// 연결이 끊긴 사람을 이 시간 동안은 방에 남겨 둔다. 그 안에 돌아오면 같은 세션을 이어받아서(음성·화면 공유·방 상태 유지)
// 나갔다 들어오는 깜빡임이 없다. 폰은 화면이 꺼지거나 와이파이↔데이터를 갈아탈 때 잠깐씩 끊기기 때문이다.
const GRACE_MS = Number(process.env.RESUME_GRACE_MS) || 60000; // PC: 새로고침·와이파이 전환 정도를 버티는 1분
// 폰·태블릿은 화면이 꺼지면(전원 버튼, 절전) 앱이 멈춰서 연결이 끊긴다. 알림이나 다른 앱을 확인하고 돌아올 시간을 주려고 훨씬 오래 방에 남겨 둔다.
// 테스트처럼 RESUME_GRACE_MS만 지정했으면 폰도 같은 값을 쓴다.
const GRACE_MOBILE_MS = Number(process.env.RESUME_GRACE_MOBILE_MS) || (process.env.RESUME_GRACE_MS ? GRACE_MS : 10 * 60 * 1000);
const LIVE_HOLD_MS = GRACE_MS; // 끊긴 사람의 음성·화면 공유는 이만큼만 붙잡는다 (소리 없는 연결을 남들이 계속 붙잡고 있지 않게)
const HOST_AWAY_MS = Number(process.env.HOST_AWAY_MS) || 3 * 60 * 1000; // 호스트의 연결이 이만큼 끊겨 있으면 다음 사람에게 호스트를 넘긴다
const AWAY_MS = Number(process.env.AWAY_MS) || 8000; // 이 시간 넘게 끊겨 있으면 다른 사람 화면에 '자리 비움'으로 보인다 (잠깐 깜빡임은 알리지 않음)
const graceOf = (ws) => (ws.device === 'mobile' || ws.device === 'tablet' ? GRACE_MOBILE_MS : GRACE_MS);
const TRUST_PROXY = !!process.env.TRUST_PROXY; // 리버스 프록시 뒤에서만 켤 것 (X-Forwarded-For 신뢰)
// 가입·로그인은 AUTH_HOST(쉼표로 여러 개 가능)로 들어온 https 요청에서만 받는다. 프록시 뒤에서는 TRUST_PROXY=1이어야 X-Forwarded-Host/Proto를 믿고 https인지 알 수 있다.
// AUTH_ALLOW_HTTP=1은 자동 테스트 전용(http로도 허용)이다. 다른 주소에서는 게스트로 방에 들어오는 것만 된다.
const AUTH_HOSTS = String(process.env.AUTH_HOST || 'sirugc.kro.kr').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
const AUTH_ALLOW_HTTP = process.env.AUTH_ALLOW_HTTP === '1';
const DB = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const PUB = path.join(__dirname, 'public');
// 화면(클라이언트) 파일이 바뀌었는지 알아보는 번호: 서버 시작 때 파일 수정 시각 중 가장 늦은 것.
// 열어 둔 탭·설치한 앱이 옛 버전이면 접속할 때 서버가 알려 주고, 화면이 새로고침 버튼을 보여 준다.
const BUILD = (() => {
  const t = [__filename, ...fs.readdirSync(PUB).map((n) => path.join(PUB, n))].map((p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } });
  return Math.floor(Math.max(...t)).toString(36);
})();

// 방은 하나. 밴 목록과 쪽지·푸시 같은 오래 남는 기록만 state.json에 저장한다.
// 호스트는 저장하지 않는다: 방에 맨 처음 들어온 사람이 호스트이고, 나가거나 3분 넘게 끊기면 가장 오래 있던 사람에게 넘어간다.
// ponytail: 밴 목록이 커지면 DB로 교체.
const room = {
  hostId: null, queueGrants: new Set(), bans: [], clients: new Map(), yt: null, seq: 0, queue: [], sharer: null, voice: new Map(),
  schema: 0, accounts: {}, sessions: {}, reserved: {}, // 계정, 로그인 세션(토큰 해시), 닉네임을 바꾸면서 한동안 비워 두는 옛 이름
  keys: {}, // 쪽지 공개 키 기록: uid → [{ kid, pub, at }] (옛 쪽지를 풀 때 필요해서 계정을 지워도 남긴다)
  vapid: null, members: {}, dms: {}, subs: {}, // 쪽지/알림: 쪽지를 주고받는 계정 목록, 쪽지, 푸시 구독
  blocks: {}, cleared: {}, // 차단(내가 막은 사람들), 대화 정리(내 화면에서만 지운 시각)
};
let oldState = false;
try { const raw = fs.readFileSync(DB, 'utf8'); oldState = raw.trim().length > 2; Object.assign(room, JSON.parse(raw)); } catch {}
// 계정이 생기면서(스키마 2) 예전 기록(쪽지, 푸시 구독, 밴, 호스트 키)은 이어가지 않는다. 옛 파일은 지우지 않고 .bak 로 남긴다.
if (room.schema !== 2 && room.schema !== 3) {
  if (oldState) {
    const bak = DB + '.bak-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Date.now();
    try { fs.copyFileSync(DB, bak); console.log('이전 버전의 저장 파일을 ' + path.basename(bak) + ' 로 백업하고 새로 시작해요. (쪽지·푸시 구독·밴 목록은 이어지지 않아요)'); } catch (e) { console.warn('저장 파일 백업에 실패했어요:', e.message); }
  }
  Object.assign(room, { bans: [], members: {}, dms: {}, subs: {}, blocks: {}, cleared: {}, accounts: {}, sessions: {}, reserved: {}, keys: {}, vapid: null, schema: 3 });
  delete room.hostKey; delete room.salt;
}
// 스키마 2(쪽지가 암호화되기 전 버전)에서 올라오면 계정·밴 등은 그대로 두고, 평문으로 저장돼 있던 쪽지만 비운다
if (room.schema === 2) { room.dms = {}; room.cleared = {}; room.keys = room.keys || {}; room.schema = 3; console.log('쪽지가 종단 암호화되면서 이전(암호화 전) 쪽지는 비웠어요.'); }
if (!room.vapid) room.vapid = webpush.generateVAPIDKeys();                 // 푸시 서명 키 (개인 키는 서버 밖으로 나가지 않는다)

const save = () => fs.writeFileSync(DB, JSON.stringify({
  schema: 3, bans: room.bans, vapid: room.vapid, accounts: room.accounts, sessions: room.sessions, reserved: room.reserved, keys: room.keys,
  members: room.members, dms: room.dms, subs: room.subs, blocks: room.blocks, cleared: room.cleared,
}));
let saveTimer = null; // 쪽지처럼 자주 바뀌는 것은 0.3초 모아서 한 번에 쓴다
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; save(); }, 300); };
process.on('exit', () => { if (saveTimer) save(); });
save();

// 프록시(NPM/nginx)가 X-Forwarded-For 맨 뒤에 실제 접속자 IP를 덧붙이므로 마지막 값을 쓴다.
// 맨 앞 값은 접속자가 마음대로 넣을 수 있어서 쓰면 IP 밴을 피할 수 있다.
// PROXY_IP(쉼표로 여러 개, 선택)를 정하면 그 주소에서 온 연결의 X-Forwarded-* 만 믿는다. 정하지 않으면 TRUST_PROXY일 때 누가 보내든 믿는다:
// 이 경우 서버 포트가 프록시 밖에서 직접 열려 있으면 접속자가 IP·주소·https 표시를 위조해 로그인 횟수 제한과 https 강제를 피할 수 있으니, 방화벽으로 막거나 PROXY_IP를 정하세요.
const PROXY_IPS = String(process.env.PROXY_IP || '').split(',').map((x) => x.trim().replace(/^::ffff:/, '')).filter(Boolean);
const viaProxy = (req) => TRUST_PROXY && (!PROXY_IPS.length || PROXY_IPS.includes(String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')));
const clientIp = (req) => {
  const raw = viaProxy(req) && req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',').pop().trim()
    : req.socket.remoteAddress;
  return String(raw || '').replace(/^::ffff:/, '');
};

const hostOf = (req) => String((viaProxy(req) && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
function authAllowed(req) {
  if (!AUTH_HOSTS.includes(hostOf(req))) return false;
  if (AUTH_ALLOW_HTTP) return true;
  const proto = viaProxy(req) ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : (req.socket.encrypted ? 'https' : 'http');
  return proto === 'https';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
// public/ 아래 파일만 서빙한다. 확장자 없는 경로는 index.html로 보낸다.
const server = http.createServer((req, res) => {
  if (uploads.handle(req, res)) return; // POST /upload, GET /f/<파일>
  // 서버가 살아 있는지 확인하는 주소. 꺼졌다가 돌아왔는지 클라이언트가 이걸로 본다.
  if (req.url.startsWith('/auth/')) return handleAuth(req, res);
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
    if (path.basename(file) === 'index.html') data = Buffer.from(data.toString('utf8').replace('<head>', `<head><meta name="build" content="${BUILD}">`));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // 항상 재검증 (서비스 워커가 오프라인 대비를 맡음)
      'X-Content-Type-Options': 'nosniff',
    }).end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
// dmOnly: 입장 화면에서 '쪽지만 쓰기'를 고른 연결. 방 사람들에게 보이지 않고 방 소식(채팅·영상·음성)도 받지 않으며 쪽지만 주고받는다. 서버 종료 알림만 예외
const broadcast = (msg, except) => room.clients.forEach((c) => c !== except && (!c.dmOnly || msg.t === 'shutdown') && send(c, msg));
const roomCount = () => [...room.clients.values()].filter((c) => !c.dmOnly).length;
const DEVICES = new Set(['pc', 'tablet', 'mobile']); // 참가자 목록에 보이는 기기 종류. 그 밖의 값은 버린다
const cleanDevice = (d) => (DEVICES.has(d) ? d : null);
// 호스트와 관리자는 호스트의 일(대기열 조작, 강퇴·밴, 호스트 넘기기)을 할 수 있다. 관리자는 계정이 생기면 쓴다
const isStaff = (c) => !!c && !!(c.host || c.admin);
const keyOf = (c) => c.uid || c.cid; // 대기열 추가 권한을 기억하는 단위(사람)
const canQueueAdd = (c) => isStaff(c) || room.queueGrants.has(keyOf(c));
const userOf = (c) => ({ id: c.id, uid: c.uid || null, acct: !!c.acct, prev: c.prev || '', name: c.name, avatar: c.avatar, color: c.color, host: !!c.host, admin: !!c.admin, canQueue: canQueueAdd(c), device: c.device || null, away: !!c.away });
const banList = () => room.bans.map(({ id, type, label }) => ({ id, type, label })); // IP 값은 노출하지 않음
const sendBans = () => room.clients.forEach((c) => isStaff(c) && send(c, { t: 'bans', bans: banList() }));
const isBanned = (ip, cid, acct) => room.bans.some((b) => (b.type === 'ip' ? b.value === ip : b.type === 'acct' ? !!acct && b.value === acct : b.value === cid));
// 닉네임: 한글·영문·숫자·공백·_ - . 만 쓸 수 있다 (보이지 않는 문자·전각·비슷하게 생긴 글자로 남을 흉내 내지 못하게). 한글 채움 문자(U+3164) 같은 안 보이는 글자는 범위에서 뺐다
const NICK_RE = /^[\uAC00-\uD7A3\u3131-\u3163\u3165-\u318EA-Za-z0-9 _.\-]+$/;
const cleanName = (n) => {
  const s = String(n ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 20).trim();
  return NICK_RE.test(s) && /[\uAC00-\uD7A3\u3131-\u3163\u3165-\u318EA-Za-z0-9]/.test(s) ? s : '';
};
const nameKey = (n) => String(n).normalize('NFKC').toLowerCase().replace(/[\s_.\-]+/g, ''); // 대소문자·공백·_ - . 만 다른 이름은 같은 이름으로 본다
const newId = (n = 4) => crypto.randomBytes(n).toString('hex');
// 사진/동영상 업로드: 세션마다 발급한 토큰이 있어야 올릴 수 있다
const uploads = createUploads({ findByToken: (t) => (t ? [...room.clients.values()].find((c) => c.uploadToken === t) : null), send });
const messages = createMessages({ room, send, newId, saveSoon, cleanMedia: uploads.validMedia });
const sendAll = (msg) => room.clients.forEach((c) => send(c, msg)); // 쪽지만 쓰는 연결까지 포함해서 모두에게
const nameInUse = (key) => [...room.clients.values()].some((c) => c.joined && nameKey(c.name) === key);
const accounts = createAccounts({ room, saveSoon, newId, cleanName, nameKey, nameInUse });
accounts.ready.then(() => save()).catch((e) => console.warn('관리자 계정을 맞추지 못했어요:', e.message));
const clientsOfAcct = (id) => [...room.clients.values()].filter((c) => c.acct === id);
// 이 계정으로 접속 중인 다른 기기들의 로그인을 끊는다 (keepId: 지금 요청을 보낸 기기의 연결은 남긴다)
function kickAcct(id, keepId, reason) {
  for (const c of clientsOfAcct(id)) { if (c.id === keepId) continue; send(c, { t: 'logged-out', reason }); c.final = true; c.close(); }
}
function applyRename(a) {
  for (const c of clientsOfAcct(a.id)) { c.name = a.name; c.prev = a.prev; }
  if (room.members[a.id]) Object.assign(room.members[a.id], { name: a.name, prev: a.prev });
  saveSoon();
  sendAll({ t: 'renamed', uid: a.id, name: a.name, prev: a.prev });
}
function removeAccount(a) {
  const id = a.id;
  messages.forget(id); // 쪽지 상대에게는 "탈퇴한 사용자"로 남고, 푸시 구독·차단 목록은 지운다
  accounts.remove(a);
  kickAcct(id, null, 'deleted');
  sendAll({ t: 'renamed', uid: id, name: '탈퇴한 사용자', prev: '', deleted: true });
}

// ---- 가입·로그인 HTTP (/auth/*) ----
const AUTH_MSG = {
  closed: '가입이 닫혀 있어요. 호스트가 가입 코드를 정해야 가입할 수 있어요.', rate: '시도가 너무 많아요. 잠시 뒤에 다시 해 주세요.', code: '가입 코드가 맞지 않아요.',
  name: '닉네임에는 한글, 영문, 숫자, 공백, _ - . 만 쓸 수 있어요.', taken: '이미 쓰는 닉네임이에요.', bad: '닉네임이나 비밀번호가 맞지 않아요.',
  session: '로그인이 풀렸어요. 다시 로그인해 주세요.', admin: '관리자 계정은 설정 파일에서만 바꿀 수 있어요.', same: '지금 쓰는 닉네임과 같아요.',
};
function handleAuth(req, res) {
  const url = req.url.split('?')[0];
  const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(obj));
  if (url === '/auth/status' && req.method === 'GET') return json(200, { allowed: authAllowed(req), signupOpen: accounts.signupOpen(), host: AUTH_HOSTS[0] });
  if (req.method !== 'POST') return json(405, { error: 'method' });
  if (!authAllowed(req)) return json(403, { error: 'host', msg: `로그인과 가입은 https://${AUTH_HOSTS[0]} 에서만 할 수 있어요.`, host: AUTH_HOSTS[0] });
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) return json(415, { error: 'type' });
  const origin = req.headers.origin;
  if (origin) { let h = ''; try { h = new URL(origin).hostname.toLowerCase(); } catch {} if (!AUTH_HOSTS.includes(h) && !AUTH_HOSTS.includes('[' + h + ']')) return json(403, { error: 'origin' }); }
  let body = '', big = false;
  req.on('data', (c) => { body += c; if (body.length > 4096) { big = true; req.destroy(); } });
  req.on('end', async () => {
    if (big) return;
    let m; try { m = JSON.parse(body); } catch { return json(400, { error: 'json' }); }
    if (!m || typeof m !== 'object') return json(400, { error: 'json' });
    try { await authRoute(url, m, clientIp(req), json); } catch (e) { console.warn('인증 처리 오류:', e.message); json(500, { error: 'server' }); }
  });
}
// ---- 쪽지 종단 암호화 키 ----
// 서버가 아는 것은 공개 키(P-256, 91바이트 SPKI)와, 비밀번호에서 만든 키로 감싼 비밀 키뿐이다. 비밀 키 원문과 쪽지 내용은 서버에 오지 않는다.
const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
const kidOf = (pubB64) => crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16);
const validPub = (p) => typeof p === 'string' && b64.test(p) && Buffer.from(p, 'base64').length === 91;
const validWrapped = (w) => !!w && typeof w === 'object' && w.v === 1 && Number.isInteger(w.i) && w.i >= 100000 && w.i <= 5000000
  && [w.s, w.iv, w.ct].every((x) => typeof x === 'string' && b64.test(x)) && w.s.length <= 64 && w.iv.length <= 32 && w.ct.length <= 600;
const curKey = (uid) => (room.keys[uid] || []).at(-1);
async function authRoute(url, m, ip, json) {
  const fail = (code, r) => json(code, { error: r.error, msg: r.msg || AUTH_MSG[r.error] || '처리하지 못했어요.', wait: r.wait });
  if (url === '/auth/signup') {
    const r = await accounts.signup({ name: m.name, password: m.password, code: m.code, ip, avatar: cleanAvatar(m.avatar), color: cleanColor(m.color) });
    return r.ok ? json(200, { ok: true, name: r.name, token: r.token }) : fail(r.error === 'rate' ? 429 : 400, r);
  }
  if (url === '/auth/login') {
    const r = await accounts.login({ name: m.name, password: m.password, ip });
    if (r.error === 'locked') return json(429, { error: 'locked', msg: `로그인에 여러 번 실패해서 잠겼어요. ${r.wait}분 뒤에 다시 해 주세요.`, wait: r.wait });
    const k = r.ok && curKey(r.acct.id);
    return r.ok ? json(200, { ok: true, name: r.name, token: r.token, mustChange: r.mustChange, avatar: r.acct.avatar || undefined, color: r.acct.color || undefined, keys: r.acct.wrapped && k ? { wrapped: r.acct.wrapped, pub: k.pub, kid: k.kid } : null }) : fail(401, r);
  }
  const sess = accounts.session(m.token); // 아래는 모두 로그인한 상태에서만
  if (!sess || sess.reuse) return json(401, { error: 'session', msg: AUTH_MSG.session });
  const a = sess.acct, keep = typeof m.keep === 'string' ? m.keep : null;
  const ok = (extra = {}) => json(200, { ok: true, ...extra, token: extra.token || sess.token || undefined }); // 토큰이 새 값으로 바뀐 요청이면 함께 돌려준다
  if (url === '/auth/check') { // 패닉 화면을 풀 때: 이 로그인의 비밀번호가 맞는지만 확인한다 (틀리면 같은 잠금 규칙)
    const c = await accounts.confirm(a, m.password, 'unlock');
    return c.ok ? ok() : fail(c.error === 'locked' ? 429 : 401, c.error === 'locked' ? { ...c, msg: `여러 번 틀려서 잠겼어요. ${c.wait}분 뒤에 다시 해 주세요.` } : c);
  }
  if (url === '/auth/keys/get') { // 이 기기에서 쪽지 키를 풀려고: 맡겨 둔(감싼) 비밀 키와 공개 키를 돌려준다
    const k = curKey(a.id);
    return ok({ keys: a.wrapped && k ? { wrapped: a.wrapped, pub: k.pub, kid: k.kid } : null });
  }
  if (url === '/auth/keys') { // 새 쪽지 키를 맡긴다 (처음 가입·로그인, 비밀번호 초기화 뒤)
    if (!validPub(m.pub) || !validWrapped(m.wrapped)) return json(400, { error: 'keys', msg: '보안 키 형식이 올바르지 않아요.' });
    const list = (room.keys[a.id] ||= []), kid = kidOf(m.pub);
    if (!list.some((x) => x.kid === kid)) { list.push({ kid, pub: m.pub, at: Date.now() }); if (list.length > 20) list.shift(); }
    else if (list.at(-1).kid !== kid) list.push(list.splice(list.findIndex((x) => x.kid === kid), 1)[0]); // 옛 키로 돌아오면 그 키를 현재로
    a.wrapped = m.wrapped; saveSoon();
    return ok({ kid });
  }
  if (url === '/auth/logout') { accounts.logout(m.token); return json(200, { ok: true }); }
  if (url === '/auth/logout-all') { accounts.revokeAll(a.id); kickAcct(a.id, keep, 'logout-all'); return json(200, { ok: true }); }
  if (url === '/auth/password') {
    const r = await accounts.changePassword(a, m.old, m.new, validWrapped(m.wrapped) ? m.wrapped : null);
    if (!r.ok) return fail(r.error === 'locked' ? 429 : 400, r);
    kickAcct(a.id, keep, 'password'); // 다른 기기의 로그인은 풀린다
    return ok({ token: r.token });
  }
  if (url === '/auth/rename') {
    const r = accounts.rename(a, m.name);
    if (!r.ok) return fail(400, r.error === 'gap' ? { ...r, msg: `닉네임은 7일에 한 번 바꿀 수 있어요. ${r.wait}일 뒤에 다시 바꿀 수 있어요.` } : r);
    applyRename(a);
    return ok({ name: r.name, prev: r.prev });
  }
  if (url === '/auth/delete') {
    if (a.role === 'admin') return fail(400, { error: 'admin' });
    const c = await accounts.confirm(a, m.password, 'del');
    if (!c.ok) return fail(c.error === 'locked' ? 429 : 401, c.error === 'locked' ? { ...c, msg: `비밀번호를 여러 번 틀려서 잠겼어요. ${c.wait}분 뒤에 다시 해 주세요.` } : c);
    removeAccount(a);
    return json(200, { ok: true });
  }
  return json(404, { error: 'unknown' });
}

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
const canManage = (ws) => isStaff(ws); // 대기열 조작(삭제·순서·재생·건너뛰기)은 호스트만. 올린 사람도 예외 없음

async function queueAdd(ws, videoId) {
  if (!/^[\w-]{11}$/.test(videoId || '') || room.queue.length >= 50) return;
  const title = await ytTitle(videoId);
  room.queue.push({ qid: newId(), videoId, title: title || videoId, by: ws.id, byName: ws.name });
  if (!room.yt || room.yt.ended) advance(); else broadcast(queueMsg()); // 기다리는 사이 다른 사람이 틀었을 수 있어 여기서 다시 판단
}

const clearGhostTimers = (ws) => { clearTimeout(ws.ghostTimer); clearTimeout(ws.holdTimer); clearTimeout(ws.awayTimer); clearTimeout(ws.hostTimer); };

// 호스트: 방에 맨 처음 들어온 사람. 나가거나(또는 연결이 HOST_AWAY_MS 넘게 끊기면) 가장 오래 있던 사람에게 넘어간다.
// 쪽지만 쓰는 사람과 관리자는 순번에 끼지 않는다. 호스트가 직접 다른 사람에게 넘길 수도 있다('host-give').
const eligible = (c) => !!c.joined && !c.dmOnly && !c.admin;
const hostVacant = () => { const h = room.hostId && room.clients.get(room.hostId); return !h || (h.ghost && Date.now() - h.ghostAt >= HOST_AWAY_MS); };
function setHost(next) {
  const prev = room.hostId ? room.clients.get(room.hostId) : null;
  if (prev === next) return;
  if (prev) prev.host = false;
  room.hostId = next ? next.id : null;
  if (next) next.host = true;
  if (prev) broadcast({ t: 'user-update', user: userOf(prev) });
  if (next) {
    if (room.clients.get(next.id) === next) broadcast({ t: 'user-update', user: userOf(next) });
    broadcast({ t: 'host', id: next.id, name: next.name });
  }
  sendBans(); // 새 호스트가 밴 목록을 볼 수 있게
}
function ensureHost() {
  if (!hostVacant()) return;
  const cur = room.hostId && room.clients.get(room.hostId);
  const next = [...room.clients.values()].filter((c) => eligible(c) && !c.ghost && c !== cur).sort((a, b) => a.since - b.since)[0];
  if (next) setHost(next);
}
// 오래 끊겨 있는 사람의 음성·화면 공유만 정리한다 (방에는 계속 남아 있음)
function dropLive(ws) {
  if (room.clients.get(ws.id) !== ws) return;
  if (room.sharer === ws.id) { room.sharer = null; broadcast({ t: 'share-stop' }); }
  if (room.voice.delete(ws.id)) broadcast(voiceMsg());
}
function leave(ws) {
  if (room.clients.get(ws.id) !== ws) return; // 이미 다른 소켓이 이 세션을 이어받았으면 무시
  room.clients.delete(ws.id);
  clearGhostTimers(ws);
  if (room.sharer === ws.id) { room.sharer = null; broadcast({ t: 'share-stop' }); }
  if (room.voice.delete(ws.id)) broadcast(voiceMsg());
  if (!ws.dmOnly) broadcast({ t: 'user-leave', id: ws.id });
  if (room.hostId === ws.id) { room.hostId = null; ws.host = false; }
  if (!roomCount()) { room.yt = null; room.queueGrants.clear(); room.hostId = null; } // 방에 아무도 없으면 영상 상태와 대기열 추가 권한을 처음으로
  else ensureHost();
}

// 입장(또는 이어받기) 응답. 입장하는 사람 자신은 users에서 뺀다(클라이언트가 me를 더한다).
function sendJoined(ws, extra = {}) {
  send(ws, {
    t: 'joined', me: userOf(ws), resume: ws.resumeSecret, upload: ws.uploadToken,
    users: ws.dmOnly ? [] : [...room.clients.values()].filter((c) => c.id !== ws.id && !c.dmOnly).map(userOf),
    yt: ws.dmOnly ? null : ytNow(), queue: ws.dmOnly ? [] : queueMsg().queue, sharer: ws.dmOnly ? null : room.sharer,
    voice: ws.dmOnly ? [] : voiceMsg().list, ice: ws.dmOnly ? undefined : iceServers(), dmOnly: ws.dmOnly || undefined,
    kid: ws.uid ? curKey(ws.uid)?.kid : undefined, // 서버가 아는 내 현재 쪽지 키 (이 기기의 키와 다르면 다시 풀어야 한다)
    inbox: ws.uid ? messages.inboxFor(ws.uid) : [], blocks: ws.uid ? messages.blocksOf(ws.uid) : [], vapid: room.vapid.publicKey, spoofs: messages.SPOOFS,
    bans: isStaff(ws) ? banList() : undefined, build: BUILD, ...extra,
  });
}

function join(ws, m, ip) {
  if (typeof m.cid !== 'string' || m.cid.length < 8 || m.cid.length > 64) return;
  // 끊겼다가 돌아온 사람: 제한 시간 안에 같은 비밀 값을 가지고 오면 옛 세션을 그대로 이어받는다
  const old = m.resume && typeof m.resume.id === 'string' ? room.clients.get(m.resume.id) : null;
  if (old && old.cid === m.cid && typeof m.resume.secret === 'string' && m.resume.secret === old.resumeSecret) {
    if (!isStaff(old) && isBanned(ip, m.cid, old.acct)) { send(ws, { t: 'banned' }); return ws.close(); }
    Object.assign(ws, { id: old.id, joined: true, ip, cid: old.cid, uid: old.uid, acct: old.acct, prev: old.prev, host: room.hostId === old.id, admin: old.admin, since: old.since, avatar: old.avatar, color: old.color, name: old.name, device: old.device, dmOnly: old.dmOnly,
      visible: true, resumeSecret: old.resumeSecret, uploadToken: old.uploadToken, joinedAt: Date.now() });
    room.clients.set(ws.id, ws); // 옛 소켓 자리를 새 소켓이 차지한다
    if (!old.ghost) old.terminate(); // 아직 살아 있다고 믿던 옛 소켓은 정리 (이 자리는 이미 넘어갔으니 나가기 처리는 건너뛴다)
    clearGhostTimers(old); old.ghost = false;
    if (old.away) broadcast({ t: 'user-away', id: ws.id, away: false }, ws);
    return sendJoined(ws, { resumed: true });
  }
  // 닉네임은 방에 있는 사람(잠깐 끊긴 사람 포함)끼리 겹칠 수 없다. 같은 기기(cid)의 다시 들어오기만 겹쳐도 된다.
  // IP나 닉네임이 같다는 것만으로는 같은 사람으로 보지 않는다 (예전의 '같은 IP Sync'는 남의 쪽지를 읽을 수 있는 구멍이라 없앴다)
  // 로그인: 토큰이 맞으면 그 계정(닉네임·프로필·쪽지)으로 들어온다. 토큰이 틀리면 게스트로 계속하고 화면에 알린다. 쪽지함은 로그인이 필요하다
  let acct = null, token2;
  if (typeof m.token === 'string' && m.token && ws.authOk) {
    const sess = accounts.session(m.token);
    if (sess && !sess.reuse) { acct = sess.acct; token2 = sess.token || undefined; } else send(ws, { t: 'auth-expired', reuse: !!sess?.reuse });
  }
  if (acct?.mustChange) { send(ws, { t: 'must-change' }); return ws.close(); } // 임시 비밀번호로 들어온 계정은 새 비밀번호를 정해야 한다
  if (m.dmOnly === true && !acct) { send(ws, { t: 'login-required' }); return ws.close(); }
  const name = acct ? acct.name : cleanName(m.name);
  if (!name) { send(ws, { t: 'name-invalid' }); return ws.close(); }
  const key = nameKey(name);
  if (!acct && (!accounts.nameFree(key) || [...room.clients.values()].some((c) => c !== ws && c.joined && c.cid !== m.cid && nameKey(c.name) === key))) { send(ws, { t: 'name-taken', name }); return ws.close(); } // 계정이 쓰는(또는 막 바꾸며 비워 둔) 닉네임은 게스트가 못 쓴다
  // 이 기기가 끊겨서 방에 남아 있던 자리가 있으면(앱이 닫혔다가 알림을 눌러 다시 열린 경우) 같은 자리를 쓴다. 유령이 둘로 보이지 않게
  const stale = [...room.clients.values()].find((c) => c.ghost && c.cid === m.cid);
  if (stale) { dropLive(stale); clearGhostTimers(stale); room.clients.delete(stale.id); }
  const dmOnly = m.dmOnly === true; // 쪽지만 쓰는 사람은 호스트가 될 수 없고, 방을 연 것으로 치지도 않는다
  if (acct?.role !== 'admin' && isBanned(ip, m.cid, acct?.id)) { // 관리자는 밴 대상이 아니다
    send(ws, { t: 'banned' });
    return ws.close();
  }
  // 프로필(아바타·색): 계정은 서버에 저장된 것을 쓰고, 이 화면에서 직접 고쳤거나(profileEdited) 저장된 게 없을 때만 새로 정한다
  const av = cleanAvatar(m.avatar), co = cleanColor(m.color);
  if (acct) { if (av && (m.profileEdited === true || !acct.avatar)) acct.avatar = av; if (co && (m.profileEdited === true || !acct.color)) acct.color = co; acct.lastSeen = Date.now(); saveSoon(); }
  Object.assign(ws, {
    id: stale ? stale.id : newId(), joined: true, ip, cid: m.cid, uid: acct ? acct.id : null, acct: acct ? acct.id : undefined, admin: acct?.role === 'admin' || undefined, prev: acct?.prev || '',
    host: false, since: stale ? stale.since : Date.now(),
    avatar: acct ? acct.avatar : av, color: acct ? acct.color : co, device: cleanDevice(m.device),
    name, dmOnly: dmOnly || undefined, visible: true, resumeSecret: newId(16), uploadToken: newId(16), joinedAt: Date.now(),
  });
  if (eligible(ws) && hostVacant()) setHost(ws); // 방에 호스트가 없으면(맨 처음이거나, 호스트가 3분 넘게 끊겨 있으면) 이 사람이 호스트
  if (acct) messages.remember(ws);
  if (!dmOnly && !room.yt && room.queue.length) advance(); // 모두 나간 뒤 남은 대기열이 있으면 첫 입장자부터 이어서 재생
  sendJoined(ws, token2 ? { token: token2 } : {});
  room.clients.set(ws.id, ws);
  if (!dmOnly) broadcast({ t: 'user-join', user: userOf(ws), back: !!stale }, ws);
}

function ban(ws, m) {
  const target = room.clients.get(m.id);
  if (!target || target === ws || target.admin || (target.host && !ws.admin)) return; // 관리자는 누구도 건드릴 수 없고, 호스트는 관리자만 내보낼 수 있다
  if (m.mode === 'user') {
    room.bans.push({ id: newId(), type: 'cid', value: target.cid, label: target.name });
    if (target.acct) room.bans.push({ id: newId(), type: 'acct', value: target.acct, label: target.name }); // 로그인한 사람은 계정도 막는다 (기기를 바꿔도 못 들어옴)
  }
  else if (m.mode === 'ip') room.bans.push({ id: newId(), type: 'ip', value: target.ip, label: target.name });
  else if (m.mode !== 'kick') return;
  const victims = m.mode === 'ip'
    ? [...room.clients.values()].filter((c) => c.ip === target.ip && !c.admin && (ws.admin || !c.host))
    : [target];
  victims.forEach((v) => { v.final = true; send(v, { t: 'banned', kick: m.mode === 'kick' }); v.close(); }); // 밴/강퇴는 바로 내보낸다(유예 없음)
  if (m.mode !== 'kick') { save(); sendBans(); }
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.missed = 0;
  ws.authOk = authAllowed(req); // 이 연결이 로그인 토큰을 인정하는 주소인가
  ws.on('pong', () => (ws.missed = 0));
  ws.on('close', (code, reason) => {
    if (!ws.joined || room.clients.get(ws.id) !== ws) return leave(ws); // 입장 전이거나 이어받기로 교체된 소켓
    console.log(`[연결 끊김] ${ws.name} code=${code}${reason?.length ? ` 사유=${String(reason).slice(0, 60)}` : ''} ${Math.round((Date.now() - ws.joinedAt) / 1000)}초 접속`); // 원인 추적용 (1006 = 비정상 끊김, 4000번대 = 화면 쪽이 스스로 끊음 + 사유)
    if (ws.final || closing) return leave(ws);
    ws.ghost = true; ws.visible = false; ws.ghostAt = Date.now();
    if (ws.host) ws.hostTimer = setTimeout(ensureHost, HOST_AWAY_MS + 50); // 호스트가 돌아오지 않으면 대기열을 아무도 못 만지지 않게
    const grace = graceOf(ws);
    ws.ghostTimer = setTimeout(() => leave(ws), grace);
    if (grace > LIVE_HOLD_MS) ws.holdTimer = setTimeout(() => dropLive(ws), LIVE_HOLD_MS);
    if (!ws.dmOnly) ws.awayTimer = setTimeout(() => { ws.away = true; broadcast({ t: 'user-away', id: ws.id, away: true }, ws); }, Math.min(AWAY_MS, grace));
  });
  ws.on('message', (data) => {
    ws.missed = 0; // 무슨 메시지든 왔으면 살아 있는 것
    ws.lastMsgAt = Date.now();
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return; // 'null' 같은 프레임을 보내면 m.t에서 예외가 나 서버 전체가 꺼졌었다
    if (m.t === 'join') return !ws.joined && join(ws, m, ip);
    if (!ws.joined) return;
    if (ws.dmOnly && m.t !== 'bye' && m.t !== 'ping') { messages.handle(ws, m); return; } // 쪽지만 쓰는 연결은 방 기능(채팅·영상·음성·공유·관리)을 쓸 수 없다
    switch (m.t) {
      case 'bye': ws.final = true; leave(ws); ws.close(); break; // 탭을 닫는 등 일부러 나가는 것: 유예 없이 바로 나간다
      case 'ping': send(ws, { t: 'pong' }); break; // 앱이 직접 보내는 생존 신호 (프록시/모바일 절전에서 죽은 연결을 알아내려고)
      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 500);
        const media = uploads.validMedia(m.media); // 첨부는 우리가 저장한 파일일 때만 (주소를 마음대로 넣지 못하게)
        const now = Date.now();
        if ((!text && !media) || now - (ws.lastChat || 0) < 300) return; // 도배 방지
        ws.lastChat = now;
        broadcast({ t: 'chat', id: ws.id, name: ws.name, text, media: media || undefined, ts: now });
        break;
      }
      case 'queue-add':
        if (!canQueueAdd(ws)) { send(ws, { t: 'queue-denied' }); break; } // 호스트가 허락한 사람만 올릴 수 있다
        queueAdd(ws, m.videoId);
        break;
      case 'queue-grant': { // 호스트가 사람마다 대기열 추가 권한을 주고 뺏는다
        const t = room.clients.get(m.id);
        if (!isStaff(ws) || !t || t.dmOnly) return;
        const k = keyOf(t);
        if (m.on) room.queueGrants.add(k); else room.queueGrants.delete(k);
        for (const c of room.clients.values()) if (keyOf(c) === k && !c.dmOnly) broadcast({ t: 'user-update', user: userOf(c) });
        break;
      }
      case 'acct-list': // 계정 관리(목록·임시 비밀번호·삭제·밴)는 관리자만. 호스트는 게스트일 수도 있어서, 호스트가 남의 비밀번호를 초기화하면 그 계정을 가로채 쪽지를 읽을 수 있다
        if (ws.admin) send(ws, { t: 'accts', list: accounts.list().map((a) => ({ ...a, online: clientsOfAcct(a.uid).some((c) => !c.ghost) })) });
        break;
      case 'acct-reset': case 'acct-delete': case 'acct-ban': { // 관리자: 임시 비밀번호 발급 / 계정 삭제 / 계정 밴. 관리자 계정은 건드릴 수 없다
        const a = accounts.byId(String(m.uid || ''));
        if (!ws.admin || !a || a.role === 'admin') return;
        if (m.t === 'acct-reset') {
          accounts.resetPassword(a).then((r) => { kickAcct(a.id, null, 'reset'); send(ws, { t: 'acct-reset', uid: a.id, name: a.name, temp: r.temp }); }).catch((e) => console.warn(e.message));
        } else if (m.t === 'acct-delete') { removeAccount(a); send(ws, { t: 'acct-deleted', uid: a.id });
        } else if (m.on) {
          if (!room.bans.some((b) => b.type === 'acct' && b.value === a.id)) room.bans.push({ id: newId(), type: 'acct', value: a.id, label: a.name });
          for (const c of clientsOfAcct(a.id)) { c.final = true; send(c, { t: 'banned' }); c.close(); }
          save(); sendBans();
        } else { room.bans = room.bans.filter((b) => !(b.type === 'acct' && b.value === a.id)); save(); sendBans(); }
        break;
      }
      case 'host-give': { // 호스트(또는 관리자)가 다른 사람에게 호스트를 넘긴다
        const t = room.clients.get(m.id);
        if (!isStaff(ws) || !t || !eligible(t) || t.ghost || t.id === room.hostId) return;
        setHost(t);
        break;
      }
      case 'queue-remove': {
        const item = room.queue.find((q) => q.qid === m.qid);
        if (!item || !canManage(ws)) return;
        room.queue = room.queue.filter((q) => q !== item);
        broadcast(queueMsg());
        break;
      }
      case 'queue-move': { // 순서 바꾸기: 호스트는 모두의 것, 일반 참가자는 자기가 올린 것만. to는 새 위치(0부터), 범위를 벗어나면 맨 앞/맨 뒤로
        const from = room.queue.findIndex((q) => q.qid === m.qid);
        if (from < 0 || !canManage(ws) || !Number.isInteger(m.to)) return;
        const to = Math.max(0, Math.min(room.queue.length - 1, m.to));
        if (to === from) return;
        const [item] = room.queue.splice(from, 1);
        room.queue.splice(to, 0, item);
        broadcast(queueMsg());
        break;
      }
      case 'queue-play': { // 대기열에서 골라 바로 재생
        const item = room.queue.find((q) => q.qid === m.qid);
        if (!item || !canManage(ws)) return;
        room.queue = room.queue.filter((q) => q !== item);
        startVideo(item);
        broadcastYt();
        broadcast(queueMsg());
        break;
      }
      case 'yt-next': // 건너뛰기: 호스트 또는 지금 영상을 올린 사람
        if (!room.yt || room.yt.ended || !canManage(ws)) return;
        advance();
        break;
      case 'yt-ended': // 끝났거나 재생 못 하는 영상. seq가 맞을 때만 한 번 처리
        if (!room.yt || room.yt.ended || room.yt.seq !== m.seq) return;
        advance();
        break;
      case 'yt-seek': // 영상 위치 이동은 호스트(와 관리자)만, 모두에게 적용 (일시정지만 개인 것)
        if (!room.yt || room.yt.ended || !isStaff(ws)) return;
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
        if (isStaff(ws)) ban(ws, m);
        break;
      case 'unban':
        if (!isStaff(ws)) return;
        room.bans = room.bans.filter((b) => b.id !== m.id);
        save();
        sendBans();
        break;
      default: messages.handle(ws, m); // 쪽지 / 푸시 알림 / 화면 보임 여부 (예전에는 이게 위의 unban으로 새서, 호스트가 쪽지를 보낼 때마다 밴 목록을 다시 저장·방송했다)
    }
  });
});

setInterval(() => wss.clients.forEach((ws) => {
  if (ws.missed >= 3) return ws.terminate(); // 약 75초 동안 아무 소식이 없을 때만 끊는다 (예전엔 25초라 폰에서 멀쩡한 연결이 끊겼다)
  ws.missed++;
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
  console.log(`시루 그룹챗 서버가 켜졌어요.  이 PC에서: http://localhost:${PORT}`);
  if (!HOST || HOST === '0.0.0.0') {
    for (const i of Object.values(os.networkInterfaces()).flat()) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  같은 공유기 안 다른 기기에서: http://${i.address}:${PORT}`);
    }
  } else console.log(`  (${HOST}에서만 열려 있어요. 다른 기기에서 쓰려면 config.env에 HOST=0.0.0.0 을 적으세요)`);
  if (TRUST_PROXY) console.log('  프록시 모드: X-Forwarded-For의 마지막 값을 접속자 IP로 믿어요.');
  console.log('  끄려면 Ctrl+C');
});
