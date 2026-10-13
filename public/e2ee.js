/* ================= 쪽지 종단 암호화 (E2EE) ================= */
// 계정마다 ECDH(P-256) 키 쌍이 있다. 공개 키는 서버에 두고, 비밀 키는 "계정 비밀번호로 감싼 채(PBKDF2 + AES-GCM)" 서버에 맡긴다.
// 이 기기에서는 꺼낼 수 없는 형태(extractable:false)로 IndexedDB에 둔다. 쪽지는 (내 비밀 키 × 상대 공개 키) → HKDF → AES-GCM 으로 암호화하므로 서버는 내용을 모른다.
// 첨부 파일은 파일마다 무작위 키로 암호화해서 올리고, 그 키는 쪽지(암호문) 안에 넣어 보낸다. tools/_e2e.js 가 같은 방식의 Node 구현이다 (바꾸면 같이 바꾼다).
let e2eeKey = null;              // { kid, priv } 이 기기에서 열린 내 쪽지 키
const E2EE_ITER = 600000;        // 비밀번호 → 키 만들기 반복 횟수 (서버는 10만~500만만 받는다)
const e2eePubs = new Map();      // 'uid|kid' → 공개 키(base64)
const e2eeCur = new Map();       // uid → { kid, pub } 상대의 지금 키
const e2eeShared = new Map();    // 'uid|kid' → 대화용 AES 키
const e2eeWait = new Map();      // uid → 공개 키 목록을 기다리는 약속들
const e2eeBlobs = new Map();     // 첨부 주소 → 풀어 둔 파일 주소(blob:)
const e2eeText = new TextEncoder();

const e2eeB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const e2eeUnB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const e2eeEcdh = { name: 'ECDH', namedCurve: 'P-256' };

/* ---------- 이 기기의 키 보관 (IndexedDB) ---------- */
const e2eeIdb = async (mode, fn) => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('siru-e2ee', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  return new Promise((ok, no) => { const tx = db.transaction('k', mode), req = fn(tx.objectStore('k')); tx.oncomplete = () => { db.close(); ok(req.result); }; tx.onerror = tx.onabort = () => no(tx.error); });
};
async function e2eeLoad() {
  try { e2eeKey = (await e2eeIdb('readonly', (s) => s.get('me'))) || null; } catch { e2eeKey = null; }
  if (e2eeKey && !(get('tok') && get('acctName'))) await e2eeClear(); // 로그아웃된 기기에 키가 남아 있으면 지운다
}
async function e2eeSave(k) { e2eeKey = k; try { await e2eeIdb('readwrite', (s) => s.put(k, 'me')); } catch {} } // 저장이 막힌 브라우저(비공개 창 등)는 이번 접속 동안만 열려 있다
async function e2eeClear() {
  e2eeKey = null; for (const m of [e2eePubs, e2eeCur, e2eeShared]) m.clear();
  try { await e2eeIdb('readwrite', (s) => s.delete('me')); } catch {}
}

/* ---------- 비밀번호로 비밀 키 감싸기·풀기 ---------- */
const e2eeKek = async (pw, salt, iter) => crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, await crypto.subtle.importKey('raw', e2eeText.encode(pw.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
async function e2eeWrap(priv, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.wrapKey('pkcs8', priv, await e2eeKek(pw, salt, E2EE_ITER), { name: 'AES-GCM', iv });
  return { v: 1, s: e2eeB64(salt), i: E2EE_ITER, iv: e2eeB64(iv), ct: e2eeB64(ct) };
}
const e2eeUnwrap = async (w, pw, extractable) => crypto.subtle.unwrapKey('pkcs8', e2eeUnB64(w.ct), await e2eeKek(pw, e2eeUnB64(w.s), w.i), { name: 'AES-GCM', iv: e2eeUnB64(w.iv) }, e2eeEcdh, extractable, ['deriveBits']);
async function e2eeNewPair(pw) { // 새 키 쌍: 서버에 맡길 것(공개 키, 감싼 비밀 키)과, 이 기기에 둘 꺼낼 수 없는 비밀 키
  const pair = await crypto.subtle.generateKey(e2eeEcdh, true, ['deriveBits']);
  const wrapped = await e2eeWrap(pair.privateKey, pw);
  const priv = await crypto.subtle.importKey('pkcs8', await crypto.subtle.exportKey('pkcs8', pair.privateKey), e2eeEcdh, false, ['deriveBits']);
  return { pub: e2eeB64(await crypto.subtle.exportKey('spki', pair.publicKey)), wrapped, priv };
}

/* ---------- 로그인·가입·비밀번호 변경과 이어지는 부분 ---------- */
// 로그인 직후: 서버가 준 감싼 키를 비밀번호로 풀어 이 기기에 둔다. 서버에 키가 없으면(가입 직후, 비밀번호 초기화 뒤) 새로 만들어 맡긴다.
async function e2eeAfterAuth(pw, keys) {
  try {
    if (keys) { if (e2eeKey?.kid !== keys.kid) await e2eeSave({ kid: keys.kid, priv: await e2eeUnwrap(keys.wrapped, pw, false) }); return true; }
    const n = await e2eeNewPair(pw), r = await authPost('/auth/keys', { pub: n.pub, wrapped: n.wrapped });
    if (!r.ok) return false;
    await e2eeSave({ kid: r.kid, priv: n.priv }); return true;
  } catch { return false; }
}
// 비밀번호 바꾸기: 감싼 키를 옛 비밀번호로 풀어 새 비밀번호로 다시 감싸서 같이 보낸다 (그래야 쪽지를 계속 읽을 수 있다)
async function e2eePasswordChange(oldPw, newPw) {
  let wrapped;
  const g = await authPost('/auth/keys/get');
  if (g.ok && g.keys) {
    try { wrapped = await e2eeWrap(await e2eeUnwrap(g.keys.wrapped, oldPw, true), newPw); }
    catch { return { ok: false, msg: '현재 비밀번호가 맞지 않아요.' }; }
  }
  const r = await authPost('/auth/password', { old: oldPw, new: newPw, wrapped });
  if (r.ok && !wrapped) await e2eeAfterAuth(newPw, null); // 키가 없던 계정(비밀번호 초기화 뒤)은 새 키를 만든다
  return r;
}
// 이 기기에 키가 없을 때(처음 쓰는 기기) 쪽지 화면에서 비밀번호로 연다
async function e2eeUnlock(pw) {
  const g = await authPost('/auth/keys/get');
  if (!g.ok) return { ok: false, msg: g.msg || '키를 가져오지 못했어요.' };
  try { return { ok: await e2eeAfterAuth(pw, g.keys) }; } catch { return { ok: false }; }
}

/* ---------- 상대의 공개 키 ---------- */
function e2eeNote(uid, kid, pub) { if (uid && kid && pub) { e2eePubs.set(uid + '|' + kid, pub); e2eeCur.set(uid, { kid, pub }); } }
const e2eeKeysOf = (uid) => new Promise((ok) => {
  const w = e2eeWait.get(uid) || []; w.push(ok); e2eeWait.set(uid, w);
  if (w.length === 1) send({ t: 'dm-keys', uid });
  setTimeout(() => ok(), 8000);
});
const e2eeShare = async (uid, kid, pub) => {
  const id = uid + '|' + kid + '|' + e2eeKey.kid;
  if (!e2eeShared.has(id)) {
    const peer = await crypto.subtle.importKey('spki', e2eeUnB64(pub), e2eeEcdh, false, []);
    const base = await crypto.subtle.importKey('raw', await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, e2eeKey.priv, 256), 'HKDF', false, ['deriveKey']);
    e2eeShared.set(id, await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: e2eeText.encode('siru-dm-v1'), info: e2eeText.encode([meUid, uid].sort().join('|')) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  }
  return e2eeShared.get(id);
};
Object.assign(handlers, {
  'dm-keys'(m) {
    for (const k of m.keys || []) e2eePubs.set(m.uid + '|' + k.kid, k.pub);
    const last = (m.keys || []).at(-1); if (last) e2eeCur.set(m.uid, last); else e2eeCur.delete(m.uid);
    for (const ok of e2eeWait.get(m.uid) || []) ok();
    e2eeWait.delete(m.uid);
  },
});

/* ---------- 쪽지 암호화·풀기 ---------- */
async function dmEncrypt(to, plain) { // plain: { t: 글, m: 첨부 정보 } → 서버에 보낼 { s, r, iv, ct }
  if (!e2eeKey || !meUid) throw new Error('nokey');
  if (!e2eeCur.has(to)) await e2eeKeysOf(to);
  const cur = e2eeCur.get(to); if (!cur) throw new Error('nopeer');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: e2eeText.encode(meUid + '>' + to) }, await e2eeShare(to, cur.kid, cur.pub), e2eeText.encode(JSON.stringify(plain)));
  return { s: e2eeKey.kid, r: cur.kid, iv: e2eeB64(iv), ct: e2eeB64(ct) };
}
async function dmDecrypt(msg) { // msg: { from, to, enc } → { t, m } 또는 null (이 기기에서 풀 수 없음)
  try {
    if (!e2eeKey || !msg.enc) return null;
    const mine = msg.from === meUid, peer = mine ? msg.to : msg.from, pkid = mine ? msg.enc.r : msg.enc.s, mkid = mine ? msg.enc.s : msg.enc.r;
    if (mkid !== e2eeKey.kid) return null;
    if (!e2eePubs.has(peer + '|' + pkid)) await e2eeKeysOf(peer);
    const pub = e2eePubs.get(peer + '|' + pkid); if (!pub) return null;
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: e2eeUnB64(msg.enc.iv), additionalData: e2eeText.encode(msg.from + '>' + msg.to) }, await e2eeShare(peer, pkid, pub), e2eeUnB64(msg.enc.ct));
    return JSON.parse(new TextDecoder().decode(out));
  } catch { return null; }
}

/* ---------- 첨부 파일 ---------- */
async function encFile(blob) { // 무작위 키로 암호화 → 올릴 덩어리와, 쪽지 안에 넣을 키·iv
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']), await blob.arrayBuffer());
  return { blob: new Blob([ct], { type: 'application/octet-stream' }), key: e2eeB64(raw), iv: e2eeB64(iv) };
}
function e2eeFile(m) { // 암호화된 첨부를 받아서 풀고 blob: 주소로 돌려준다 (같은 주소는 한 번만)
  if (!e2eeBlobs.has(m.url)) {
    e2eeBlobs.set(m.url, fetch(m.url).then((r) => { if (!r.ok) throw new Error('gone'); return r.arrayBuffer(); })
      .then(async (buf) => URL.createObjectURL(new Blob([await crypto.subtle.decrypt({ name: 'AES-GCM', iv: e2eeUnB64(m.iv) }, await crypto.subtle.importKey('raw', e2eeUnB64(m.key), 'AES-GCM', false, ['decrypt']), buf)], { type: m.type || (m.kind === 'video' ? 'video/mp4' : 'image/jpeg') })))
      .catch((e) => { e2eeBlobs.delete(m.url); throw e; }));
  }
  return e2eeBlobs.get(m.url);
}

const e2eeReady = e2eeLoad(); // 입장하기 전에 이 기기의 키를 읽어 둔다 (dm.js가 기다린다)
