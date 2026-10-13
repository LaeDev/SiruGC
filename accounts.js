// 계정과 로그인 세션 (닉네임 + 비밀번호). server.js에서 한 번 만들어 쓴다.
// 저장 위치는 room.accounts / room.sessions / room.reserved 이고, 파일에 쓰는 시점은 server.js(saveSoon)가 정한다.
//  - 비밀번호: scrypt 해시만 저장한다. 원문은 어디에도 남기지 않는다.
//  - 로그인 토큰: 기기마다 무작위 값. 서버에는 SHA-256만 저장한다. 쓸 때 만든 지 ROTATE_MS(3일)가 넘었으면 새 값으로 바꾸고,
//    옛 값은 GRACE_MS(10분)만 더 받아 준다(탭이 여러 개이거나 응답이 늦은 경우). 그 뒤에 옛 값이 오면 도난으로 보고 그 기기의 로그인을 끊는다.
//    안 쓰고 IDLE_MS(60일)가 지나면 만료된다.
//  - 로그인 실패 5번이면 15분 잠긴다(닉네임 + IP 기준). 가입은 IP마다 시간당 횟수를 제한한다.
// ponytail: 계정이 수백 개를 넘으면 nameKey 색인을 만들 것 (지금은 목록을 훑는다).
const crypto = require('crypto');

const DAY = 86400e3;
const DUMMY_SALT = '00112233445566778899aabbccddeeff'; // 없는 계정에도 같은 시간이 걸리게 (닉네임이 있는지 시간으로 알아내지 못하게)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // 임시 비밀번호용: 헷갈리는 글자(0 O 1 l I) 제외

module.exports = function createAccounts({ room, saveSoon, newId, cleanName, nameKey, nameInUse, env = process.env }) {
  const num = (k, d) => Number(env[k]) || d;
  const ROTATE_MS = num('TOKEN_ROTATE_MS', 3 * DAY), GRACE_MS = num('TOKEN_GRACE_MS', 10 * 60e3), IDLE_MS = num('TOKEN_IDLE_MS', 60 * DAY);
  const RENAME_GAP_MS = num('RENAME_GAP_MS', 7 * DAY), RESERVE_MS = num('NAME_RESERVE_MS', 7 * DAY);
  const LOCK_AFTER = num('LOGIN_MAX_FAILS', 5), LOCK_MS = num('LOGIN_LOCK_MS', 15 * 60e3), SIGNUP_MAX = num('SIGNUP_PER_HOUR', 10);
  const accounts = room.accounts, sessions = room.sessions, reserved = room.reserved;

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const same = (buf, hex) => { try { const b = Buffer.from(hex, 'hex'); return b.length === buf.length && crypto.timingSafeEqual(buf, b); } catch { return false; } };
  const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
  const secret = () => crypto.randomBytes(32).toString('base64url');

  // ---- 비밀번호 ----
  const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(String(pw).normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? no(e) : ok(k))));
  async function setPassword(a, pw) { const salt = crypto.randomBytes(16); a.salt = salt.toString('hex'); a.hash = (await scrypt(pw, salt)).toString('hex'); }
  async function checkPassword(a, pw) {
    const k = await scrypt(pw, Buffer.from(a?.salt || DUMMY_SALT, 'hex'));
    return !!a && same(k, a.hash);
  }
  const pwProblem = (pw, name) => {
    if (typeof pw !== 'string' || !pw) return '비밀번호를 입력해 주세요.';
    if (pw.length < 8) return '비밀번호는 8자 이상이어야 해요.';
    if (pw.length > 64) return '비밀번호는 64자까지 쓸 수 있어요.';
    if (name && nameKey(pw) === nameKey(name)) return '비밀번호가 닉네임과 같으면 안 돼요.';
    return '';
  };

  // ---- 잠금과 횟수 제한 (메모리에만 둔다: 재시작하면 풀려도 괜찮은 정도의 방어) ----
  const fails = new Map(), signups = new Map();
  const lockLeft = (k) => { const f = fails.get(k); return f && f.until > Date.now() ? f.until - Date.now() : 0; };
  const failed = (k) => {
    let f = fails.get(k) || { n: 0, until: 0 };
    if (f.until && f.until <= Date.now()) f = { n: 0, until: 0 };
    f.n++; if (f.n >= LOCK_AFTER) f.until = Date.now() + LOCK_MS;
    fails.set(k, f);
  };
  const signupOk = (ip) => { const t = Date.now(); let r = signups.get(ip); if (!r || r.reset < t) r = { n: 0, reset: t + 3600e3 }; r.n++; signups.set(ip, r); return r.n <= SIGNUP_MAX; };

  // ---- 이름 ----
  const byKey = (key) => Object.values(accounts).find((a) => a.key === key);
  const byId = (id) => accounts[id];
  // 이 닉네임을 쓸 수 있는가: 다른 계정이 쓰는 이름도, 다른 계정이 바꾸면서 예약해 둔 이름도 안 된다
  function nameFree(key, forAcct) {
    const a = byKey(key); if (a && a.id !== forAcct) return false;
    const r = reserved[key]; if (r && r.until > Date.now() && r.acct !== forAcct) return false;
    return true;
  }

  // ---- 세션(토큰) ----
  function issue(acctId) {
    const sid = newId(8), sec = secret(), t = Date.now();
    sessions[sid] = { sid, acct: acctId, hash: sha(sec).toString('hex'), issuedAt: t, created: t, lastUsed: t };
    saveSoon();
    return sid + '.' + sec;
  }
  // 토큰이 맞으면 { acct, token } (token은 새 값으로 바뀐 경우에만 들어 있다). 도난이 의심되면 { reuse: true }, 아니면 null
  function session(token) {
    if (typeof token !== 'string' || token.length > 200) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const sid = token.slice(0, dot), s = sessions[sid];
    if (!s) return null;
    const a = accounts[s.acct], now = Date.now();
    if (!a || now - s.lastUsed > IDLE_MS) { delete sessions[sid]; saveSoon(); return null; }
    const h = sha(token.slice(dot + 1));
    let token2 = null;
    if (same(h, s.hash)) {
      s.lastUsed = now;
      if (now - s.issuedAt >= ROTATE_MS) { // 3일이 지났으니 새 값으로
        const next = secret();
        s.prevHash = s.hash; s.prevUntil = now + GRACE_MS; s.hash = sha(next).toString('hex'); s.issuedAt = now;
        token2 = sid + '.' + next; saveSoon();
      }
    } else if (s.prevHash && same(h, s.prevHash)) {
      if (now > s.prevUntil) { delete sessions[sid]; saveSoon(); return { reuse: true }; } // 유예가 끝난 옛 값: 복사본이 돌아다니는 것이니 이 기기의 로그인을 끊는다
      s.lastUsed = now;
    } else return null;
    return { acct: a, token: token2, sid };
  }
  const logout = (token) => { const r = typeof token === 'string' ? token.slice(0, token.indexOf('.')) : ''; if (sessions[r]) { delete sessions[r]; saveSoon(); } };
  const revokeAll = (acctId) => { for (const [sid, s] of Object.entries(sessions)) if (s.acct === acctId) delete sessions[sid]; saveSoon(); };

  // ---- 가입 · 로그인 ----
  async function signup({ name, password, code, ip, avatar, color }) {
    const want = env.SIGNUP_CODE;
    if (!want) return { error: 'closed' };
    if (!signupOk(ip)) return { error: 'rate' };
    if (!safeEq(String(code ?? ''), want)) return { error: 'code' };
    const nm = cleanName(name);
    if (!nm) return { error: 'name' };
    const prob = pwProblem(password, nm); if (prob) return { error: 'password', msg: prob };
    const key = nameKey(nm);
    if (!nameFree(key) || nameInUse(key)) return { error: 'taken' };
    const a = { id: newId(6), name: nm, key, role: 'user', created: Date.now(), lastSeen: Date.now(), avatar: avatar || null, color: color || null, prev: '', history: [] };
    await setPassword(a, password);
    if (byKey(key)) return { error: 'taken' }; // 해시를 만드는 사이에 같은 이름으로 가입한 사람이 있었다
    accounts[a.id] = a; saveSoon();
    return { ok: true, name: a.name, acct: a, token: issue(a.id) };
  }
  async function login({ name, password, ip }) {
    const key = nameKey(cleanName(name) || String(name ?? '')), lk = key + '|' + ip;
    const left = lockLeft(lk); if (left) return { error: 'locked', wait: Math.ceil(left / 60e3) };
    const a = byKey(key);
    if (!(await checkPassword(a, String(password ?? '')))) { failed(lk); return { error: 'bad' }; }
    fails.delete(lk);
    a.lastSeen = Date.now(); saveSoon();
    return { ok: true, name: a.name, acct: a, token: issue(a.id), mustChange: !!a.mustChange };
  }
  // 현재 비밀번호를 다시 확인해야 하는 일(비밀번호 변경, 계정 삭제)용: 틀리면 같은 잠금 규칙을 쓴다
  async function confirm(a, password, kind) {
    const lk = kind + ':' + a.id, left = lockLeft(lk);
    if (left) return { error: 'locked', wait: Math.ceil(left / 60e3) };
    if (!(await checkPassword(a, String(password ?? '')))) { failed(lk); return { error: 'bad' }; }
    fails.delete(lk); return { ok: true };
  }
  async function changePassword(a, oldPw, newPw) {
    if (a.role === 'admin') return { error: 'admin' }; // 관리자 비밀번호는 설정 파일에서만 바꾼다
    const c = await confirm(a, oldPw, 'pw'); if (!c.ok) return c;
    const prob = pwProblem(newPw, a.name); if (prob) return { error: 'password', msg: prob };
    await setPassword(a, newPw); a.mustChange = false;
    revokeAll(a.id); // 모든 기기의 로그인이 풀린다. 이 기기는 새 토큰을 받는다
    return { ok: true, token: issue(a.id) };
  }
  async function resetPassword(a) { // 호스트·관리자가 임시 비밀번호를 발급한다. 그 비밀번호로 들어오면 바로 새로 정해야 한다
    const temp = Array.from(crypto.randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');
    await setPassword(a, temp); a.mustChange = true; revokeAll(a.id);
    return { ok: true, temp };
  }
  function rename(a, raw) {
    if (a.role === 'admin') return { error: 'admin' }; // 관리자 이름은 설정 파일에서만 바꾼다
    const nm = cleanName(raw); if (!nm) return { error: 'name' };
    const key = nameKey(nm), now = Date.now();
    if (a.changedAt && now - a.changedAt < RENAME_GAP_MS) return { error: 'gap', wait: Math.ceil((RENAME_GAP_MS - (now - a.changedAt)) / DAY) };
    if (nm === a.name) return { error: 'same' };
    if (key !== a.key) {
      if (!nameFree(key, a.id) || nameInUse(key)) return { error: 'taken' };
      reserved[a.key] = { acct: a.id, until: now + RESERVE_MS }; // 옛 닉네임은 한동안 다른 사람이 못 쓴다 (그 사이 내가 되돌아올 수는 있다)
      delete reserved[key];
      a.prev = a.name; a.history.push({ name: a.name, at: now });
    }
    a.name = nm; a.key = key; a.changedAt = now; saveSoon();
    return { ok: true, name: nm, prev: a.prev };
  }
  function remove(a) {
    delete accounts[a.id]; revokeAll(a.id);
    for (const [k, r] of Object.entries(reserved)) if (r.acct === a.id) delete reserved[k];
    saveSoon();
  }
  const list = () => Object.values(accounts).map((a) => ({ uid: a.id, name: a.name, role: a.role, created: a.created, lastSeen: a.lastSeen, prev: a.prev || '' }))
    .sort((x, y) => (y.role === 'admin') - (x.role === 'admin') || x.name.localeCompare(y.name, 'ko'));

  // ---- 관리자 계정: 서버를 켤 때마다 설정 파일(ADMIN_NAME, ADMIN_PASSWORD)을 기준으로 맞춘다 ----
  async function syncAdmin() {
    const name = cleanName(env.ADMIN_NAME), pw = env.ADMIN_PASSWORD;
    if (env === process.env) delete process.env.ADMIN_PASSWORD; // 원문은 해시를 만든 뒤 어디에도 남기지 않는다
    const admins = Object.values(accounts).filter((a) => a.role === 'admin');
    const demote = (why) => { for (const a of admins) a.role = 'user'; if (why) console.warn('관리자 계정을 만들지 못했어요: ' + why); saveSoon(); };
    if (!env.ADMIN_NAME && !pw) return demote(''); // 관리자를 쓰지 않는 설정
    if (!name || !pw) return demote('config.env에 ADMIN_NAME(한글·영문·숫자 등)과 ADMIN_PASSWORD를 둘 다 적어야 해요.');
    const prob = pwProblem(pw, name); if (prob) return demote('ADMIN_PASSWORD: ' + prob);
    const key = nameKey(name);
    const clash = byKey(key);
    if (clash && clash.role !== 'admin') return demote(`"${name}" 닉네임을 다른 사람이 이미 쓰고 있어요. ADMIN_NAME을 바꿔 주세요.`);
    let a = clash || admins[0];
    for (const o of admins) if (o !== a) o.role = 'user'; // 관리자는 한 명
    if (!a) { a = { id: newId(6), created: Date.now(), history: [], prev: '' }; accounts[a.id] = a; }
    delete reserved[key];
    Object.assign(a, { name, key, role: 'admin', mustChange: false });
    if (!(await checkPassword(a.hash ? a : null, pw))) { await setPassword(a, pw); revokeAll(a.id); } // 비밀번호가 바뀌었으면 옛 로그인은 모두 풀린다
    saveSoon();
  }

  // 오래된 것 정리 (예약이 끝난 이름, 만료된 세션, 지난 잠금)
  function sweep() {
    const t = Date.now();
    for (const [k, r] of Object.entries(reserved)) if (r.until <= t) delete reserved[k];
    for (const [sid, s] of Object.entries(sessions)) if (!accounts[s.acct] || t - s.lastUsed > IDLE_MS) delete sessions[sid];
    for (const [k, f] of fails) if (f.until <= t && t - (f.until || 0) > LOCK_MS) fails.delete(k);
    for (const [k, r] of signups) if (r.reset < t) signups.delete(k);
    saveSoon();
  }
  setInterval(sweep, 3600e3).unref();

  return {
    ready: syncAdmin(), signup, login, session, logout, revokeAll, confirm, changePassword, resetPassword, rename, remove, list, byId, byKey, nameFree, pwProblem,
    signupOpen: () => !!env.SIGNUP_CODE, sweep,
  };
};
