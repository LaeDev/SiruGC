// 쪽지 종단 암호화의 Node 쪽 구현 (자동 테스트용). public/e2ee.js 와 같은 방식이다:
//  - 키: 계정마다 ECDH P-256 키 쌍. 비밀 키는 비밀번호에서 만든 키(PBKDF2-SHA256)로 AES-GCM 감싸서(wrapped) 서버에 맡기고, 공개 키(SPKI)는 그대로 올린다.
//  - 쪽지: 보내는 사람 비밀 키 × 받는 사람 공개 키(ECDH) → HKDF → AES-GCM 키. 글·첨부 정보(JSON)를 암호화하고, 보낸 사람>받는 사람 번호를 AAD로 묶는다.
//  - 첨부: 파일마다 무작위 AES-GCM 키로 암호화해서 올리고, 그 키는 쪽지(암호문) 안에 넣어 보낸다.
const { webcrypto, createHash, randomBytes } = require('crypto');
const subtle = webcrypto.subtle;

const te = new TextEncoder(), td = new TextDecoder();
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ITER = 100000; // 테스트용으로 줄인 값 (브라우저는 더 크게 쓴다). 서버는 10만 이상만 받는다

const kidOf = (pubB64) => createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16);
const kek = async (password, salt, iter) => subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, await subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);

async function wrapPriv(priv, password) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const ct = await subtle.wrapKey('pkcs8', priv, await kek(password, salt, ITER), { name: 'AES-GCM', iv });
  return { v: 1, s: b64(salt), i: ITER, iv: b64(iv), ct: b64(ct) };
}
async function unwrapPriv(w, password) {
  return subtle.unwrapKey('pkcs8', unb64(w.ct), await kek(password, unb64(w.s), w.i), { name: 'AES-GCM', iv: unb64(w.iv) }, ECDH, false, ['deriveBits']);
}
// 새 키 쌍을 만들고 서버에 맡길 것(공개 키, 감싼 비밀 키)까지 준비한다
async function newKeys(password) {
  const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const pub = b64(await subtle.exportKey('spki', pair.publicKey));
  return { priv: pair.privateKey, pub, kid: kidOf(pub), wrapped: await wrapPriv(pair.privateKey, password) };
}

const sharedCache = new Map();
async function shared(myPriv, peerPubB64, uidA, uidB) {
  const peer = await subtle.importKey('spki', unb64(peerPubB64), ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, myPriv, 256);
  const base = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('siru-dm-v1'), info: te.encode([uidA, uidB].sort().join('|')) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// me: { priv, kid, uid }, peer: { uid, kid, pub }. 평문: { t: 글, m: 첨부 정보 }
async function encryptDm(me, peer, plain) {
  const key = await shared(me.priv, peer.pub, me.uid, peer.uid), iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(me.uid + '>' + peer.uid) }, key, te.encode(JSON.stringify(plain)));
  return { s: me.kid, r: peer.kid, iv: b64(iv), ct: b64(ct) };
}
// msg: { from, to, enc }. 내가 보낸 것이면 상대는 to(받는 키 r), 받은 것이면 상대는 from(보낸 키 s). peerPub(uid, kid)로 그 공개 키를 찾는다
async function decryptDm(me, msg, peerPub) {
  const mine = msg.from === me.uid, peerUid = mine ? msg.to : msg.from, peerKid = mine ? msg.enc.r : msg.enc.s, myKid = mine ? msg.enc.s : msg.enc.r;
  if (myKid !== me.kid) throw new Error('이 키로 풀 수 없는 쪽지');
  const pub = await peerPub(peerUid, peerKid);
  const key = await shared(me.priv, pub, me.uid, peerUid);
  const out = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(msg.enc.iv), additionalData: te.encode(msg.from + '>' + msg.to) }, key, unb64(msg.enc.ct));
  return JSON.parse(td.decode(out));
}

// 첨부 파일: 파일마다 무작위 키. 올릴 암호문(Buffer)과, 쪽지 안에 넣을 키·iv를 돌려준다
async function encryptFile(buf) {
  const raw = randomBytes(32), iv = randomBytes(12);
  const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  return { blob: Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, key, buf)), key: b64(raw), iv: b64(iv) };
}
async function decryptFile(blob, keyB64, ivB64) {
  const key = await subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
  return Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, blob));
}

// 안전번호: 두 사람의 uid·공개 키(SPKI base64)로 만든 숫자 24자리(4자리 6묶음). public/dm.js 의 safetyNumber 와 같은 방식
function safetyNumber(uidA, pubA, uidB, pubB) {
  const [a, b] = [[uidA, pubA], [uidB, pubB]].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const h = createHash('sha256').update(['siru-safety-v1', a[0], a[1], b[0], b[1]].join('|')).digest();
  return [0, 1, 2, 3, 4, 5].map((i) => String(h.readUInt32BE(i * 4) % 10000).padStart(4, '0'));
}

module.exports = { safetyNumber, newKeys, wrapPriv, unwrapPriv, encryptDm, decryptDm, encryptFile, decryptFile, kidOf, b64, unb64 };
