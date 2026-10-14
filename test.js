// 실행: `npm test` — 임시 상태 파일로 서버를 직접 띄워서 밴 / 대기열 / 재생 시계 / 공유 / 프사 로직을 확인한다.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { newKeys, wrapPriv, unwrapPriv, encryptDm, decryptDm, encryptFile, decryptFile } = require('./tools/_e2e');

const PORT = 3100 + Math.floor(Math.random() * 500);
const STATE = path.join(os.tmpdir(), `chat-test-${Date.now()}.json`);
const AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
let mainHost; // main()의 호스트 연결 (뒤의 점검에서 호스트 권한이 필요할 때 씀)
const V1 = 'dQw4w9WgXcQ', V2 = 'jNQXAC9IVRw', V3 = 'aqz-KE-bpKQ';

// 가짜 푸시 서비스: 실제 푸시 대신 서버가 이 주소로 알림 내용을 보낸다 (PUSH_DEBUG_URL)
const sink = { hits: [], status: 201 };
const sinkServer = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => { sink.hits.push(JSON.parse(body)); res.writeHead(sink.status).end(); });
});

// 테스트 서버들이 공통으로 쓰는 로그인 설정 (테스트는 http라서 AUTH_ALLOW_HTTP, 주소는 localhost 계열)
const AUTH_ENV = { AUTH_HOST: 'localhost,127.0.0.1,[::1]', AUTH_ALLOW_HTTP: '1', SIGNUP_CODE: 'test-code', SIGNUP_PER_HOUR: '1000', ADMIN_NAME: '관리자', ADMIN_PASSWORD: 'admin-pass-1' };
async function api(p, body, { port = PORT } = {}) {
  const r = await fetch(`http://localhost:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
}
const ACCOUNTS = new Map(); // 같은 이름은 한 번만 가입하고 토큰을 다시 쓴다
async function account(name, { port = PORT } = {}) {
  const k = port + ':' + name;
  if (!ACCOUNTS.has(k)) {
    const r = await api('/auth/signup', { name, password: 'pw-' + name + '-12345', code: 'test-code' }, { port });
    assert(r.ok, '가입 실패: ' + name + ' ' + JSON.stringify(r));
    const keys = await newKeys('pw-' + name + '-12345'); // 쪽지 보안 키 (기기에서 만들고 공개 키와 감싼 비밀 키만 서버에 맡긴다)
    const kr = await api('/auth/keys', { token: r.token, pub: keys.pub, wrapped: keys.wrapped }, { port });
    assert(kr.ok && kr.kid === keys.kid, '쪽지 키 등록 실패: ' + name);
    ACCOUNTS.set(k, { ...r, keys });
  }
  return ACCOUNTS.get(k);
}
// extra.acct = true 이면 그 닉네임으로 가입(한 번)해 둔 계정으로 로그인해서 입장한다 (쪽지는 로그인한 사람만 쓴다)
function client(cid, name, extra = {}, { host = 'localhost', headers, port = PORT } = {}) {
  const c = { ws: null, msgs: [], closed: false };
  c.open = (async () => {
    const { acct, keys, ...rest } = extra;
    const join = { t: 'join', name, cid, ...rest };
    if (acct) { const a = await account(name, { port }); join.token = a.token; c.keys = a.keys; }
    if (keys) c.keys = keys;
    c.ws = new WebSocket(`ws://${host}:${port}`, { headers });
    c.ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'joined') c.uid = m.me.uid; c.msgs.push(m); });
    c.ws.on('close', () => (c.closed = true));
    await new Promise((r) => c.ws.on('open', r));
    c.ws.send(JSON.stringify(join));
  })();
  c.send = (m) => c.ws.send(JSON.stringify(m));
  // ---- 쪽지 암호화 (화면이 하는 일을 흉내 낸다) ----
  c.myUid = () => c.uid;
  const me = () => ({ priv: c.keys.priv, kid: c.keys.kid, uid: c.myUid() });
  c.keyOf = async (uid, kid) => { // 상대의 공개 키(들)를 서버에서 받는다 (kid를 정하면 그 키)
    const from = c.msgs.length; c.send({ t: 'dm-keys', uid });
    const r = await until(() => c.msgs.slice(from).find((m) => m.t === 'dm-keys' && m.uid === uid), '공개 키 목록');
    return kid ? r.keys.find((k) => k.kid === kid) : r.keys.at(-1);
  };
  c.dm = async (to, text, media, peerOverride) => {
    const peer = peerOverride || (await c.keyOf(to)) || { kid: '0000000000000000', pub: c.keys.pub }; // 모르는 사람이면 아무 키나 (서버가 걸러야 한다)
    c.send({ t: 'dm', to, enc: await encryptDm(me(), { uid: to, ...peer }, { t: String(text).trim().slice(0, 500), m: media }) });
  };
  c.edit = async (to, id, text) => { const peer = await c.keyOf(to); c.send({ t: 'dm-edit', with: to, id, enc: await encryptDm(me(), { uid: to, ...peer }, { t: String(text).trim().slice(0, 500) }) }); };
  c.reveal = async (msg) => decryptDm(me(), msg, async (uid, kid) => (await c.keyOf(uid, kid)).pub);
  c.preview = (e) => c.reveal({ from: e.last.mine ? c.myUid() : e.uid, to: e.last.mine ? e.uid : c.myUid(), enc: e.last.enc }); // 쪽지 목록의 마지막 쪽지
  c.texts = (msgs) => Promise.all(msgs.map(async (m) => (await c.reveal(m)).t));
  c.find = (t) => c.msgs.find((m) => m.t === t);
  c.last = (t) => [...c.msgs].reverse().find((m) => m.t === t);
  c.clear = () => (c.msgs.length = 0);
  return c;
}
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
// 조건이 참이 될 때까지 기다린다 (유튜브 제목 조회가 최대 3초 걸릴 수 있음)
async function until(fn, label, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(50); }
  assert.fail('시간 초과: ' + label);
}

async function main() {
  const host = client('host-cid-0001', '호스트', { acct: true, avatar: AVATAR, color: '#FF6B8B', device: 'tablet' }); await host.open; await wait();
  const hj = host.find('joined');
  mainHost = host;
  assert(hj.me.host && !hj.hostKey, '첫 입장자는 호스트 (호스트 키는 없어짐)');
  assert.equal(hj.me.avatar, AVATAR, '정상 프사는 저장됨');
  assert.equal(hj.me.color, '#ff6b8b', '내 색은 소문자 #rrggbb로 저장됨');

  const a = client('alice-cid-0001', '앨리스', { acct: true, avatar: 'javascript:alert(1)', color: 'red;background:url(x)', device: '<b>toaster</b>' }); await a.open; await wait();
  const aj = a.find('joined');
  assert(!aj.me.host, '두번째는 일반 참가자');
  assert.equal(aj.me.avatar, null, '잘못된 프사는 버려짐');
  assert.equal(aj.me.color, null, '잘못된 색은 버려짐 (CSS 주입 방지)');
  assert.equal(aj.users[0].color, '#ff6b8b', '다른 참가자의 색이 전달됨');
  assert.equal(hj.me.device, 'tablet', '기기 종류(pc/tablet/mobile)는 저장됨');
  assert.equal(aj.users[0].device, 'tablet', '다른 참가자의 기기 종류가 전달됨');
  assert.equal(aj.me.device, null, '정해진 값이 아닌 기기 종류는 버려짐');
  a.send({ t: 'ban', id: hj.me.id, mode: 'kick' }); await wait();
  assert(!host.closed, '일반 참가자는 밴 불가');

  // ---- WebRTC 서버 목록: STUN + coturn 임시 계정(HMAC) ----
  const turn = hj.ice.find((s) => String(s.urls).startsWith('turn:'));
  assert(hj.ice.some((s) => String(s.urls).startsWith('stun:')), 'STUN 서버가 포함됨');
  assert(turn && turn.username > Math.floor(Date.now() / 1000), 'TURN 임시 계정은 미래 시각이 만료');
  assert.equal(turn.credential, crypto.createHmac('sha1', 'test-secret').update(turn.username).digest('base64'), 'TURN 비밀번호는 HMAC-SHA1');
  assert(!JSON.stringify(hj.ice).includes('test-secret'), '비밀 키 자체는 내려가지 않음');

  // ---- 음성: 참가/마이크 끔/나가기가 모두에게 전달됨 ----
  a.send({ t: 'voice-join' }); await wait(200);
  assert.deepEqual(host.last('voice').list, [{ id: aj.me.id, muted: false }], '음성 참가가 방송됨');
  a.send({ t: 'voice-mute', muted: true }); await wait(200);
  assert.equal(host.last('voice').list[0].muted, true, '마이크 끔이 방송됨');
  host.send({ t: 'voice-mute', muted: true }); await wait(200);
  assert.equal(host.last('voice').list.length, 1, '음성에 참가하지 않은 사람의 마이크 신호는 무시');
  a.send({ t: 'voice-leave' }); await wait(200);
  assert.equal(host.last('voice').list.length, 0, '음성 나가기가 방송됨');

  // ---- 대기열: 비어 있으면 바로 재생, 아니면 줄 서기 ----
  a.send({ t: 'queue-add', videoId: V1 }); await wait(300);
  assert(a.find('queue-denied') && !host.find('yt'), '호스트가 허락하지 않은 사람은 대기열에 올릴 수 없음');
  a.clear(); host.send({ t: 'queue-grant', id: aj.me.id, on: true });
  await until(() => a.find('user-update')?.user.canQueue === true, '허락하면 본인에게 권한이 켜졌다고 알려 줌');
  host.clear();
  a.send({ t: 'queue-add', videoId: 'not-an-id' }); await wait(300);
  assert(!host.find('queue'), '잘못된 영상 ID는 무시');
  a.send({ t: 'queue-add', videoId: V1 });
  const y1 = await until(() => host.find('yt'), '첫 영상 재생 시작');
  assert.equal(y1.videoId, V1); assert.equal(y1.seq, 1); assert.equal(y1.byName, '앨리스'); assert(y1.title, '제목(또는 ID)이 있음');
  a.send({ t: 'queue-add', videoId: V2 });
  const q1 = await until(() => host.last('queue')?.queue.length === 1 && host.last('queue'), '대기열에 추가');
  assert.equal(q1.queue[0].videoId, V2);
  assert.equal(host.last('yt')?.seq, 1, '대기열에 올려도 재생 중인 영상은 그대로');

  // ---- 재생 시계: 늦게 들어온 사람과 yt-sync는 방의 현재 위치를 받음 ----
  await wait(1100);
  const late = client('late-cid-00001', '지각'); await late.open; await wait();
  const lj = late.find('joined');
  assert(lj.yt.time >= 1 && lj.yt.playing, '방 시계가 흘러간 위치로 시작');
  assert.equal(lj.queue.length, 1, '입장할 때 대기열도 받음');
  host.clear(); host.send({ t: 'yt-sync' }); await wait();
  assert(host.find('yt').time >= 1, 'yt-sync는 현재 위치를 돌려줌');
  late.ws.close();

  // 위치 이동은 모두에게 적용
  a.clear(); host.clear(); a.send({ t: 'yt-seek', time: 200 }); await wait(300);
  assert(!host.find('yt') && !a.find('yt'), '호스트가 아니면 영상 위치를 옮길 수 없음');
  host.send({ t: 'yt-seek', time: 100 }); await wait();
  assert(a.find('yt').time >= 100 && a.find('yt').time < 102, '호스트의 위치 이동이 다른 사람에게 전달됨');

  // ---- 권한: 호스트만 빼기/건너뛰기 (올린 사람도 예외 없음) ----
  const b = client('bob-cid-000001', '밥'); await b.open; await wait();
  const qid = q1.queue[0].qid;
  host.clear(); b.send({ t: 'queue-remove', qid }); b.send({ t: 'yt-next' }); a.send({ t: 'queue-remove', qid }); a.send({ t: 'yt-next' }); await wait(300);
  assert(!host.find('queue'), '호스트가 아니면 못 뺌, 올린 사람도 마찬가지 (대기열 변경 방송 없음)');
  assert(!host.find('yt'), '호스트가 아니면 건너뛰기 불가, 올린 사람도 마찬가지 (영상 변경 방송 없음)');

  // ---- 끝남 처리: seq가 맞을 때만, 한 번만 ----
  a.send({ t: 'yt-ended', seq: 99 }); await wait(200);
  assert(!host.find('yt'), 'seq가 틀리면 무시 (영상 변경 방송 없음)');
  a.send({ t: 'yt-ended', seq: 1 }); b.send({ t: 'yt-ended', seq: 1 });
  await until(() => host.last('yt')?.seq === 2, '다음 영상으로 넘어감');
  await wait(300);
  assert.equal(host.last('yt')?.seq, 2, '동시에 끝남을 알려도 한 번만 넘어감');
  assert.equal(host.last('yt')?.videoId, V2);
  assert.equal(host.last('queue')?.queue.length, 0);

  // 마지막 영상이 끝나면 '끝남' 상태, 이후 추가하면 다시 재생
  host.send({ t: 'yt-ended', seq: 2 });
  await until(() => host.last('yt')?.ended, '끝남 상태');
  b.send({ t: 'queue-add', videoId: V3 }); await wait(300);
  assert(b.find('queue-denied') && host.last('yt')?.ended, '허락받지 않은 사람은 영상이 끝난 뒤에도 올릴 수 없음');
  a.send({ t: 'queue-add', videoId: V3 });
  await until(() => host.last('yt')?.videoId === V3 && host.last('yt')?.playing, '끝난 뒤 추가하면 바로 재생');
  a.send({ t: 'yt-next' }); await wait(300);
  assert(!host.last('yt')?.ended, '올린 사람이라도 호스트가 아니면 건너뛸 수 없음');
  host.send({ t: 'yt-next' });
  await until(() => host.last('yt')?.ended, '호스트가 건너뛰기');
  host.send({ t: 'queue-add', videoId: V1 }); host.send({ t: 'queue-add', videoId: V2 });
  await until(() => host.last('yt')?.videoId === V1, '호스트 영상 재생');
  const q2 = await until(() => host.last('queue')?.queue.length === 1 && host.last('queue'), '대기열 1개');
  host.send({ t: 'queue-play', qid: q2.queue[0].qid });
  await until(() => host.last('yt')?.videoId === V2, '호스트는 남의 것도 바로 재생/제거 가능');

  // ---- 쪽지(DM) ----
  const hostUid = hj.me.uid, aliceUid = aj.me.uid;
  assert(/^[0-9a-f]{12}$/.test(hostUid) && hostUid !== aliceUid, 'uid는 사람마다 다른 12자리 공개 번호');
  assert(!JSON.stringify(a.msgs).includes('host-cid-0001'), '다른 사람의 비밀 식별자(cid)는 내려가지 않음');
  assert(hj.vapid.length > 40 && !JSON.stringify(a.msgs).includes('privateKey'), '푸시 공개키만 내려감');
  assert(hj.spoofs.off && hj.spoofs.study.tab && hj.spoofs.hide.title, '위장 프리셋 목록이 내려감');
  const avatarRes = await fetch(`http://localhost:${PORT}/a/${hostUid}`);
  assert(avatarRes.status === 200 && avatarRes.headers.get('content-type') === 'image/jpeg', '/a/<uid> 로 프사를 받을 수 있음');
  assert.equal((await fetch(`http://localhost:${PORT}/a/ffffffffffff`)).status, 404, '모르는 uid는 404');

  host.clear();
  await a.dm(hostUid, '  안녕, 쪽지야  ');
  const dm1 = await until(() => host.find('dm'), '쪽지 도착');
  assert.equal((await host.reveal(dm1.msg)).t, '안녕, 쪽지야', '받는 사람 기기에서 풀리고, 앞뒤 공백은 보내는 화면이 잘라 줌'); assert.equal(dm1.msg.from, aliceUid); assert.equal(dm1.peer.name, '앨리스');
  assert(!JSON.stringify(dm1).includes('안녕') && !JSON.stringify(dm1).includes('쪽지야'), '서버가 보낸 쪽지에는 내용이 평문으로 들어 있지 않음');
  assert(a.find('dm'), '보낸 사람 화면에도 같은 쪽지가 옴(여러 기기 동기화)');
  a.clear(); await a.dm(aliceUid, '나에게'); await a.dm('ffffffffffff', '모르는 사람'); await a.dm(hostUid, '   '); await wait(500);
  assert(!a.find('dm'), '자기 자신, 모르는 사람은 무시');
  a.send({ t: 'dm', to: hostUid, text: '평문 쪽지' }); a.send({ t: 'dm', to: hostUid, enc: { s: 'x', r: 'y', iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(20000) } }); await wait(500);
  assert.equal(a.msgs.filter((m) => m.t === 'dm-error').length, 2, '암호화하지 않았거나 너무 큰 쪽지는 서버가 받지 않음'); assert(!host.msgs.some((m) => m.t === 'dm' && m.msg.id !== dm1.msg.id), '그런 쪽지는 상대에게 가지 않음');
  await a.dm(hostUid, 'x'.repeat(700)); await a.dm(hostUid, '너무 빨라'); await wait(500);
  assert.equal(host.msgs.filter((m) => m.t === 'dm').length, 2, '0.4초 안의 연속 쪽지는 도배로 막힘');
  host.send({ t: 'dm-history', with: aliceUid });
  assert.equal((await until(() => host.find('dm-thread'), '기록')).msgs.length, 2, '대화 기록을 불러옴');

  // 오프라인인 사람에게도 전달 + 안 읽음 표시 + 읽음 처리
  const z = client('zed-cid-0000001', '제드', { acct: true }); await z.open; await wait();
  const zUid = z.find('joined').me.uid; z.ws.close(); await wait(300);
  await a.dm(zUid, '자고 있니?'); await wait(500);
  const z2 = client('zed-cid-0000001', '제드', { acct: true }); await z2.open; await wait();
  const inbox = z2.find('joined').inbox;
  assert(!JSON.stringify(fs.readFileSync(STATE, 'utf8')).includes('자고 있니'), '저장 파일에도 쪽지 내용이 평문으로 없음');
  assert(inbox.length === 1 && inbox[0].uid === aliceUid && inbox[0].unread === 1 && (await z2.preview(inbox[0])).t === '자고 있니?' && inbox[0].online, '오프라인 쪽지가 안 읽음 1로 도착 (미리보기는 받는 기기가 풂)');
  z2.send({ t: 'dm-read', with: aliceUid }); await wait(300); z2.ws.close(); await wait(200);
  const z3 = client('zed-cid-0000001', '제드', { acct: true }); await z3.open; await wait();
  assert.equal(z3.find('joined').inbox[0].unread, 0, '읽음 처리가 저장됨');

  // ---- 푸시 알림: 화면을 안 볼 때만, 위장 설정대로 ----
  const sub = (n) => ({ endpoint: 'https://push.example.test/' + n, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
  const dmTo = async (text) => { sink.hits.length = 0; await a.dm(zUid, text); await wait(500); return sink.hits; };
  z3.send({ t: 'push-sub', sub: sub(1), prefs: { dm: true, spoof: 'off' } }); await until(() => z3.find('push-ok'), '구독 등록');
  z3.send({ t: 'vis', v: true }); await wait(100);
  assert.equal((await dmTo('보고 있을 때')).length, 0, '화면을 보고 있으면 푸시를 보내지 않음');
  z3.send({ t: 'vis', v: false }); await wait(100);
  let hit = (await dmTo('안 볼 때'))[0];
  assert(hit && hit.payload.title === '앨리스' && hit.payload.body === '새 쪽지가 왔어요' && hit.payload.uid === aliceUid, '화면을 안 보면 보낸 사람이 보임 (내용은 서버도 모르니 "새 쪽지가 왔어요")');
  assert(!JSON.stringify(hit).includes('안 볼 때'), '알림에는 쪽지 내용이 없음');
  z3.send({ t: 'push-sub', sub: sub(1), prefs: { dm: true, spoof: 'study' } }); await wait(200);
  hit = (await dmTo('비밀 내용입니다'))[0];
  assert(hit.payload.title === '학습 도우미' && hit.payload.body === '새 알림 1개' && hit.payload.icon === '/icons/spoof-study.png', '위장하면 가짜 이름·내용·아이콘');
  assert(!JSON.stringify(hit).includes('앨리스') && !JSON.stringify(hit).includes('비밀 내용') && !hit.payload.uid, '위장 알림에는 보낸 사람도 내용도 들어가지 않음');
  z3.send({ t: 'push-sub', sub: sub(1), prefs: { dm: false, spoof: 'off' } }); await wait(200);
  assert.equal((await dmTo('끈 상태')).length, 0, '쪽지 알림을 끄면 보내지 않음');
  z3.send({ t: 'push-sub', sub: sub(1), prefs: { dm: true, spoof: 'off' } }); await wait(200);
  z3.send({ t: 'vis', v: true }); sink.hits.length = 0; z3.send({ t: 'push-test' }); await wait(500);
  assert(sink.hits.length === 1 && sink.hits[0].payload.title === '테스트', '테스트 알림은 화면을 보고 있어도 감');
  z3.send({ t: 'vis', v: false }); await wait(100);
  sink.status = 410; assert.equal((await dmTo('만료')).length, 1, '만료된 구독에도 한 번은 시도');
  sink.status = 201; assert.equal((await dmTo('만료 뒤')).length, 0, '410을 받으면 구독을 지움');
  z3.ws.close();

  // ---- 대기열 순서 바꾸기 ----
  for (const v of [V1, V3, V1]) host.send({ t: 'queue-add', videoId: v });
  const q3 = await until(() => host.last('queue')?.queue.length === 3 && host.last('queue'), '대기열 3개');
  const ids = q3.queue.map((q) => q.qid), order = () => host.last('queue').queue.map((q) => q.qid).join();
  host.send({ t: 'queue-move', qid: ids[2], to: 0 }); await until(() => order() === [ids[2], ids[0], ids[1]].join(), '맨 뒤를 맨 앞으로');
  host.send({ t: 'queue-move', qid: ids[2], to: 99 }); await until(() => order() === [ids[0], ids[1], ids[2]].join(), '범위를 넘으면 맨 뒤로');
  host.send({ t: 'queue-move', qid: ids[0], to: 1 }); await until(() => order() === [ids[1], ids[0], ids[2]].join(), '가운데로 옮기기');
  host.clear(); host.send({ t: 'queue-move', qid: ids[0], to: 1 }); host.send({ t: 'queue-move', qid: ids[0], to: 1.5 }); host.send({ t: 'queue-move', qid: 'nope', to: 0 }); await wait(500);
  assert(!host.find('queue'), '같은 자리, 정수가 아닌 위치, 없는 항목은 무시');
  a.send({ t: 'queue-add', videoId: V2 }); const q4 = await until(() => host.last('queue')?.queue.length === 4 && host.last('queue'), '앨리스가 하나 추가');
  const mine = q4.queue[3].qid; host.clear(); a.clear();
  a.send({ t: 'queue-move', qid: ids[1], to: 0 }); a.send({ t: 'queue-move', qid: mine, to: 0 }); await wait(400);
  assert(!host.find('queue'), '일반 참가자는 순서를 바꿀 수 없음 (자기가 올린 항목도)');
  host.send({ t: 'queue-move', qid: mine, to: 0 }); await until(() => host.last('queue')?.queue[0].qid === mine, '호스트는 옮길 수 있음');
  assert(a.find('queue'), '바뀐 순서는 모두에게 방송됨');
  host.send({ t: 'queue-remove', qid: mine });
  for (const id of ids) host.send({ t: 'queue-remove', qid: id });
  await until(() => host.last('queue')?.queue.length === 0, '대기열 비우기');

  // ---- 화면 공유는 한 명만 ----
  a.send({ t: 'share-start' }); await wait();
  const c2 = client('cat-cid-0000001', '고양이'); await c2.open; await wait();
  assert.equal(c2.find('joined').sharer, aj.me.id);
  c2.send({ t: 'share-start' }); await wait();
  assert(c2.find('share-denied'), '이미 공유 중이면 거절');
  c2.ws.close();

  // ---- 밴: 사용자 밴 → 같은 cid 재접속 차단 ----
  host.send({ t: 'ban', id: aj.me.id, mode: 'user' }); await wait();
  assert(a.closed, '밴된 사용자는 끊김');
  assert(host.find('share-stop'), '공유자가 나가면 공유 종료');
  const a2 = client('alice-cid-0001', '앨리스2'); await a2.open; await wait();
  assert(a2.find('banned') && a2.closed, '밴된 cid 재입장 차단');

  // IP 밴 → 다른 cid도 같은 IP면 차단, 호스트는 예외
  host.send({ t: 'ban', id: b.find('joined').me.id, mode: 'ip' }); await wait();
  assert(b.closed, 'IP 밴 대상 끊김');
  const c = client('carol-cid-00001', '캐롤'); await c.open; await wait();
  assert(c.find('banned'), '같은 IP 다른 cid도 차단');
  assert(!host.closed, 'IP 밴에도 같은 IP의 호스트는 끊기지 않음');
  const bansNow = host.last('bans').bans;
  assert(bansNow.length === 3, '호스트 화면에 밴 목록이 보임 (사용자 밴은 기기와 계정 둘, IP 밴 하나)');

  // 해제 후 입장 가능
  for (const ban of bansNow) host.send({ t: 'unban', id: ban.id });
  await wait();
  const d = client('dave-cid-000001', '데이브'); await d.open; await wait();
  assert(d.find('joined'), '해제 후 입장 가능');
}

// 쪽지 완성: 읽음 표시, 삭제, 대화 정리, 차단, 전체 회원 목록
async function dmFullCheck() {
  const mk = async (cid, name) => { const c = client(cid, name, { acct: true }); await c.open; await wait(300); c.uid = c.find('joined').me.uid; return c; };
  const x1 = await mk('dmf-1-cid-000001', '쪽지일'), x2 = await mk('dmf-2-cid-000001', '쪽지이'), x3 = await mk('dmf-3-cid-000001', '쪽지삼');
  x3.ws.close(); await wait(300); // 삼은 오프라인

  x1.send({ t: 'dm-members' });
  const mem = (await until(() => x1.find('members'), '회원 목록')).list;
  assert(!mem.some((u) => u.uid === x1.uid), '회원 목록에 나는 없음');
  const off = mem.find((u) => u.uid === x3.uid);
  assert(off && off.online === false && mem.find((u) => u.uid === x2.uid).online === true, '오프라인인 사람도 목록에 있고 접속 중 여부가 표시됨');
  assert(mem.findIndex((u) => u.uid === x2.uid) < mem.findIndex((u) => u.uid === x3.uid), '접속 중인 사람이 먼저');

  // 읽음 표시
  await x1.dm(x2.uid, '읽음 확인'); const sent = (await until(() => x2.find('dm'), '쪽지 도착')).msg;
  x1.send({ t: 'dm-history', with: x2.uid }); assert.equal((await until(() => x1.find('dm-thread'), '기록')).msgs.at(-1).read, false, '읽기 전에는 read=false');
  x1.clear(); x2.send({ t: 'dm-read', with: x1.uid });
  assert.equal((await until(() => x1.find('dm-seen'), '읽음 알림')).by, x2.uid, '상대가 읽으면 보낸 사람에게 dm-seen이 감');
  x1.clear(); x2.send({ t: 'dm-read', with: x1.uid }); await wait(300);
  assert(!x1.find('dm-seen'), '이미 읽은 걸 또 읽어도 알림은 다시 가지 않음');
  x1.send({ t: 'dm-history', with: x2.uid }); assert.equal((await until(() => x1.find('dm-thread'), '기록')).msgs.at(-1).read, true, '기록에도 read=true');

  // 삭제: 내가 보낸 것만
  x1.clear(); x2.clear(); x2.send({ t: 'dm-delete', with: x1.uid, id: sent.id }); await wait(300);
  assert(!x1.find('dm-deleted') && !x2.find('dm-deleted'), '남이 보낸 쪽지는 지울 수 없음');
  x1.send({ t: 'dm-delete', with: x2.uid, id: sent.id });
  assert.equal((await until(() => x2.find('dm-deleted'), '상대에게 삭제 알림')).id, sent.id, '지우면 상대 화면에서도 사라짐');
  assert(x1.find('dm-deleted'), '내 화면에도 알림');
  x2.send({ t: 'dm-history', with: x1.uid }); assert.equal((await until(() => x2.find('dm-thread'), '기록')).msgs.length, 0, '기록에서 빠짐');

  // 대화 정리: 내 화면에서만
  await x1.dm(x2.uid, '정리 전 1'); await wait(500); await x1.dm(x2.uid, '정리 전 2'); await wait(500);
  x2.clear(); x2.send({ t: 'dm-clear', with: x1.uid }); await until(() => x2.find('dm-cleared'), '정리 알림');
  x2.send({ t: 'dm-history', with: x1.uid }); assert.equal((await until(() => x2.find('dm-thread'), '기록')).msgs.length, 0, '정리한 쪽에서는 이전 쪽지가 안 보임');
  x1.clear(); x1.send({ t: 'dm-history', with: x2.uid }); assert((await until(() => x1.find('dm-thread'), '기록')).msgs.length >= 2, '상대 화면의 기록은 그대로');
  await x1.dm(x2.uid, '정리 후'); await wait(500);
  x2.clear(); x2.send({ t: 'dm-history', with: x1.uid }); assert.deepEqual(await x2.texts((await until(() => x2.find('dm-thread'), '기록')).msgs), ['정리 후'], '정리한 뒤 온 쪽지만 보임');
  const x2b = client('dmf-2b-cid-00001', '쪽지이', { acct: true }); await x2b.open; await wait(300);
  assert.equal((await x2b.preview(x2b.find('joined').inbox.find((c) => c.uid === x1.uid))).t, '정리 후', '다시 접속해도 정리가 유지되고 목록 미리보기는 새 쪽지');
  x2b.ws.close();

  // 차단
  x2.send({ t: 'dm-read', with: x1.uid }); await wait(400); // 차단 전에 받아 둔 쪽지는 먼저 읽어 둔다 (그 읽음 알림이 아래 확인과 섞이지 않게)
  x2.send({ t: 'push-sub', sub: { endpoint: 'https://push.example.test/blk', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, prefs: { dm: true, spoof: 'off' } }); await until(() => x2.find('push-ok'), '구독');
  x2.send({ t: 'vis', v: false }); x2.clear(); x2.send({ t: 'dm-block', uid: x1.uid, on: true });
  assert.deepEqual((await until(() => x2.find('blocks'), '차단 목록')).list, [x1.uid], '차단하면 목록이 돌아옴');
  x2.clear(); x1.clear(); sink.hits.length = 0; await wait(450);
  await x1.dm(x2.uid, '차단된 상태의 쪽지'); await until(() => x1.find('dm'), '보낸 사람 화면에는 정상으로 보임');
  await wait(600);
  assert(!x2.find('dm'), '차단한 사람에게는 쪽지가 도착하지 않음');
  assert.equal(sink.hits.length, 0, '알림(푸시)도 가지 않음');
  x2.send({ t: 'dm-history', with: x1.uid }); assert(!(await x2.texts((await until(() => x2.find('dm-thread'), '기록')).msgs)).includes('차단된 상태의 쪽지'), '차단한 쪽 기록에는 안 남음');
  x1.send({ t: 'dm-history', with: x2.uid }); assert((await x1.texts((await until(() => x1.find('dm-thread'), '기록')).msgs)).includes('차단된 상태의 쪽지'), '차단당한 쪽 기록에는 남아 있음(차단 사실을 숨김)');
  x2.send({ t: 'dm-read', with: x1.uid }); x1.clear(); await wait(300); assert(!x1.find('dm-seen'), '전달되지 않은 쪽지는 읽음으로 바뀌지 않음');
  x2.clear(); await x2.dm(x1.uid, '내가 차단한 사람에게'); assert((await until(() => x2.find('dm-error'), '오류')).msg.includes('차단'), '내가 차단한 사람에게는 보낼 수 없고 이유를 알려 줌');
  x2.send({ t: 'dm-block', uid: x1.uid, on: false }); await until(() => x2.last('blocks')?.list.length === 0, '차단 해제'); x1.clear(); x2.clear(); await wait(450);
  await x1.dm(x2.uid, '해제 뒤'); await until(() => x2.find('dm'), '차단을 풀면 다시 도착함');
  const x2c = client('dmf-2c-cid-00001', '쪽지이', { acct: true }); await x2c.open; await wait(300);
  assert.deepEqual(x2c.find('joined').blocks, [], '입장할 때 차단 목록을 받음');
  // 수정: 내가 보낸 쪽지만, 새로 암호화한 내용으로 (이전 내용은 남지 않음)
  x1.clear(); x2.clear(); x2c.clear(); await wait(450);
  await x1.dm(x2.uid, '고치기 전'); const toEdit = (await until(() => x2.find('dm'), '고칠 쪽지 도착')).msg; await wait(450);
  x1.clear(); x2.clear();
  await x2.edit(x1.uid, toEdit.id, '남의 쪽지를 고침'); await wait(400);
  assert(!x1.find('dm-edited') && !x2.find('dm-edited'), '남이 보낸 쪽지는 고칠 수 없음');
  await x1.edit(x2.uid, 'ffffffffffff', '없는 쪽지'); await wait(450);
  assert(!x1.find('dm-edited'), '없는 쪽지는 무시');
  x1.send({ t: 'dm-edit', with: x2.uid, id: toEdit.id, text: '평문으로 고침' }); await wait(450); x1.send({ t: 'dm-edit', with: x2.uid, id: toEdit.id, enc: { s: 'x', r: 'y', iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(20000) } }); await wait(500);
  assert.equal(x1.msgs.filter((m) => m.t === 'dm-error').length, 2, '암호화하지 않았거나 너무 큰 수정은 서버가 받지 않음');
  assert(!x2.find('dm-edited'), '그런 수정은 상대에게 가지 않음');
  await wait(450); await x1.edit(x2.uid, toEdit.id, '  고친 뒤  ');
  const ed = await until(() => x2.find('dm-edited'), '고친 쪽지가 상대에게 옴');
  assert.equal((await x2.reveal({ from: x1.uid, to: x2.uid, enc: ed.enc })).t, '고친 뒤', '상대 기기에서 새 내용으로 풀림');
  assert(ed.id === toEdit.id && ed.with === x1.uid && ed.edited > toEdit.ts, '같은 쪽지에 수정 시각이 붙음');
  assert(x1.find('dm-edited') && x1.find('dm-edited').with === x2.uid, '보낸 사람의 다른 화면에도 알림');
  assert(!JSON.stringify(ed).includes('고친'), '서버가 보낸 수정에도 내용이 평문으로 들어 있지 않음');
  x2.clear(); x2.send({ t: 'dm-history', with: x1.uid });
  const hist = (await until(() => x2.find('dm-thread'), '기록')).msgs.find((m) => m.id === toEdit.id);
  assert.equal((await x2.reveal(hist)).t, '고친 뒤', '기록에도 새 내용(이전 내용은 없음)'); assert(hist.edited, '기록에 수정됨 표시');
  await wait(500); assert(!fs.readFileSync(STATE, 'utf8').includes('고친'), '저장 파일에도 평문이 없음');
  x2.send({ t: 'dm-block', uid: 'ffffffffffff', on: true }); x2.send({ t: 'dm-block', uid: x2.uid, on: true }); await wait(300);
  assert(!x2.msgs.some((m) => m.t === 'blocks' && m.list.includes('ffffffffffff')) && !x2.msgs.some((m) => m.t === 'blocks' && m.list.includes(x2.uid)), '모르는 사람이나 나 자신은 차단할 수 없음');
  for (const c of [x1, x2, x2c]) c.send({ t: 'bye' }); // 유예 없이 바로 정리해서 뒤의 점검에 퇴장 알림이 섞이지 않게
  await wait(400);
}

// 쪽지 종단 암호화: 키 맡기기·바꾸기, 상대 키가 바뀐 경우, 비밀번호 변경·초기화와 감싼 키, 변조 방지, 키가 없을 때
async function e2eeCheck() {
  const pwOf = (n) => 'pw-' + n + '-12345';
  const fresh = async (name) => { // 키 없이 가입 → 키를 직접 만들어 맡긴다
    const r = await api('/auth/signup', { name, password: pwOf(name), code: 'test-code' });
    assert(r.ok, '가입'); const keys = await newKeys(pwOf(name));
    assert((await api('/auth/keys', { token: r.token, pub: keys.pub, wrapped: keys.wrapped })).ok, '키 맡기기');
    return { ...r, keys };
  };
  const A = await fresh('암호갑'), B = await fresh('암호을');
  const a = client('e2-a-00000001', '암호갑', { token: A.token, keys: A.keys }), b = client('e2-b-00000001', '암호을', { token: B.token, keys: B.keys });
  await a.open; await b.open; await wait(300);
  const auid = a.myUid(), buid = b.myUid();

  // 보내고 받기, 변조 방지
  await a.dm(buid, '비밀 이야기');
  const got = await until(() => b.find('dm'), '도착');
  assert.equal((await b.reveal(got.msg)).t, '비밀 이야기', '받는 사람이 풂');
  assert.equal((await a.reveal(got.msg)).t, '비밀 이야기', '보낸 사람도 자기 기기에서 다시 풀 수 있음');
  await assert.rejects(() => b.reveal({ ...got.msg, to: auid }), '받는 사람·보낸 사람 번호를 바꾸면(변조) 풀리지 않음');
  const bad = { ...got.msg, enc: { ...got.msg.enc, ct: got.msg.enc.ct.slice(0, -4) + 'AAAA' } };
  await assert.rejects(() => b.reveal(bad), '암호문을 고치면 풀리지 않음');
  const third = await fresh('암호병'); const c3 = client('e2-c-00000001', '암호병', { token: third.token, keys: third.keys }); await c3.open; await wait(200);
  await assert.rejects(() => c3.reveal(got.msg), '제3자는 서버에서 받은 암호문을 풀 수 없음');

  // 상대가 키를 바꾼 경우(비밀번호 초기화 등): 서버가 알려 주고, 새 키로 다시 보내면 도착
  const nk = await newKeys(pwOf('암호을'));
  assert((await api('/auth/keys', { token: B.token, pub: nk.pub, wrapped: nk.wrapped })).ok, '새 키 맡기기');
  a.clear(); await a.dm(buid, '옛 키로 보냄', undefined, { kid: B.keys.kid, pub: B.keys.pub }); await wait(400);
  const rk = a.find('dm-rekey');
  assert(rk && rk.uid === buid && rk.kid === nk.kid && rk.pub === nk.pub, '상대 키가 바뀌었으면 새 키를 알려 주고 보내지 않음');
  b.clear(); await a.dm(buid, '새 키로 보냄'); const got2 = await until(() => b.find('dm'), '새 키로 도착');
  b.keys = nk;
  assert.equal((await b.reveal(got2.msg)).t, '새 키로 보냄', '새 키로 보낸 쪽지는 바뀐 키로 풀림');
  await assert.rejects(() => b.reveal(got.msg), '키를 잃은(바뀐) 쪽은 옛 쪽지를 풀 수 없음');
  assert.equal((await a.reveal(got.msg)).t, '비밀 이야기', '보낸 사람은 상대의 지난 공개 키 기록으로 옛 쪽지를 계속 풀 수 있음');
  a.send({ t: 'dm-keys', uid: buid }); const dk = await until(() => a.last('dm-keys'), '키 기록');
  assert(dk.keys.length === 2 && !JSON.stringify(dk).includes('priv') && !JSON.stringify(dk).includes('wrapped'), '공개 키 기록에는 공개 키만 있음');

  // 키가 없는 계정: 보낼 수도, 받을 수도 없음
  const nokey = await api('/auth/signup', { name: '암호없음', password: pwOf('암호없음'), code: 'test-code' });
  const n = client('e2-n-00000001', '암호없음', { token: nokey.token }); await n.open; await wait(300);
  n.send({ t: 'dm', to: buid, enc: { s: 'abcd', r: nk.kid, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' } }); await wait(300);
  assert.equal(n.find('dm-error')?.code, 'no-key', '쪽지 키를 맡기지 않은 계정은 보낼 수 없음');
  a.clear(); await a.dm(n.myUid(), '받을 준비 안 된 사람에게', undefined, { kid: 'aaaaaaaaaaaaaaaa', pub: A.keys.pub }); await wait(300);
  assert(a.find('dm-error')?.msg.includes('준비'), '상대에게 키가 없으면 안내함');
  assert.equal((await api('/auth/keys', { token: nokey.token, pub: 'AAAA', wrapped: A.keys.wrapped })).error, 'keys', '길이가 맞지 않는 공개 키는 거절');
  assert.equal((await api('/auth/keys', { token: nokey.token, pub: A.keys.pub, wrapped: { v: 1, s: 'AA', i: 5, iv: 'AA', ct: 'AA' } })).error, 'keys', '반복 횟수가 너무 적은 감싼 키는 거절');

  // 비밀번호 바꾸기: 감싼 키도 새 비밀번호로 다시 감싸야 하고, 그러면 새 비밀번호로만 열림
  const P = await fresh('암호정'); const W2 = await wrapPriv((await newKeys('x')).priv, 'x').catch(() => null);
  const no = await api('/auth/password', { token: P.token, old: pwOf('암호정'), new: 'new-pass-word-1' });
  assert.equal(no.error, 'keys', '감싼 키를 다시 감싸서 보내지 않으면 비밀번호를 바꿀 수 없음 (키를 잃지 않도록)');
  const ps = await newKeys('new-pass-word-1');
  const yes = await api('/auth/password', { token: P.token, old: pwOf('암호정'), new: 'new-pass-word-1', wrapped: ps.wrapped }); assert(yes.ok, '다시 감싸서 보내면 바뀜');
  const kg = await api('/auth/keys/get', { token: yes.token });
  assert(kg.keys && kg.keys.wrapped.ct === ps.wrapped.ct, '맡겨 둔 감싼 키가 새 것으로 바뀜');
  await unwrapPriv(kg.keys.wrapped, 'new-pass-word-1'); await assert.rejects(() => unwrapPriv(kg.keys.wrapped, pwOf('암호정')), '옛 비밀번호로는 열리지 않음');

  // 관리자가 비밀번호를 초기화하면 감싼 키는 사라진다 (이전 쪽지는 못 읽는다)
  const adminTok = (await api('/auth/login', { name: '관리자', password: 'admin-pass-1' })).token;
  const adm = client('e2-adm-0000001', '관리', { token: adminTok }); await adm.open; await wait(300);
  const Q = await fresh('암호무'); const qc = client('e2-q-00000001', '암호무', { token: Q.token, keys: Q.keys }); await qc.open; await wait(300);
  adm.send({ t: 'acct-reset', uid: qc.myUid() }); const rr = await until(() => adm.find('acct-reset'), '초기화');
  const lg = await api('/auth/login', { name: '암호무', password: rr.temp });
  assert(lg.ok && lg.keys === null, '초기화한 뒤 로그인하면 맡겨 둔 감싼 키가 없음 (새로 만들게 됨)');
  assert((await api('/auth/keys/get', { token: lg.token })).keys === null, '키 목록 요청에도 없음');
  for (const x of [a, b, c3, n, adm, qc]) x.ws.close();
  await wait(300);
}

// 닉네임은 겹칠 수 없고, IP나 닉네임이 같다고 같은 사람으로 합쳐지지 않는다(예전 '같은 IP Sync'는 남의 쪽지를 읽는 구멍이라 없앴다).
// 서로 다른 IP는 127.0.0.1 과 ::1 로 만든다
async function nameCheck() {
  const A = '127.0.0.1', B = '[::1]';
  const a = client('nm-cid-a000001', '닉네임', { acct: true, avatar: AVATAR, color: '#112233' }, { host: A }); await a.open; await wait(250);
  const aj = a.find('joined'); assert(aj, '처음 쓰는 닉네임은 그냥 들어감');
  const b = client('nm-cid-b000001', ' 닉  네임 ', {}, { host: B }); await b.open; await wait(350);
  assert(b.find('name-taken')?.name && !b.find('joined'), '다른 IP에서 같은 닉네임(공백 차이)은 들어올 수 없음');
  await until(() => b.closed, '거부된 연결은 닫힘', 1500);
  const b2 = client('nm-cid-b000002', 'NICK', {}, { host: B }); await b2.open; await wait(200);
  const b3 = client('nm-cid-b000003', 'nick', {}, { host: A }); await b3.open; await wait(350);
  assert(b2.find('joined') && b3.find('name-taken'), '대소문자만 다른 닉네임도 같은 이름으로 봄');
  const dots = client('nm-cid-d000001', 'n.i_c-k', {}, { host: A }); await dots.open; await wait(350);
  assert(dots.find('name-taken') && !dots.find('joined'), '_ - . 만 끼운 닉네임도 같은 이름으로 봄');
  const p = client('nm-cid-p000001', '닉네임', {}, { host: A, headers: { 'X-Forwarded-For': '9.9.9.9' } }); await p.open; await wait(350);
  assert(p.find('name-taken') && !p.find('joined'), '프록시 헤더가 있어도 같은 닉네임은 들어올 수 없음');
  // 핵심: 같은 IP, 같은 닉네임이라도 내 쪽지·프로필을 가져갈 수 없다
  const c = client('nm-cid-c000001', '닉네임', { avatar: '', color: '#ffffff' }, { host: A }); await c.open; await wait(350);
  assert(c.find('name-taken') && !c.find('joined') && !c.find('inbox'), '같은 IP의 같은 닉네임도 들어올 수 없음 (같은 사람으로 합쳐지지 않음)');
  const d = client('nm-cid-d000009', '보내는이', { acct: true }); await d.open; await wait(200);
  a.clear(); c.clear(); await d.dm(aj.me.uid, '나에게만 와야 함'); await wait(400);
  assert(a.find('dm') && !c.find('dm'), '쪽지는 그 닉네임을 쓰려던 다른 사람에게 가지 않음');
  const a2 = client('nm-cid-a000001', '닉네임', { acct: true }, { host: A }); await a2.open; await wait(300);
  assert(a2.find('joined') && !a2.find('name-taken'), '같은 기기(탭 두 개)는 그대로 들어올 수 있음');
  // 쓸 수 없는 글자: 보이지 않는 문자, 전각, 이모티콘, 태그, 한글 채움 문자
  for (const bad of ['시\u200B루', 'ＮＩＣＫ', '😎멋쟁이', '<b>x</b>', 'ㅤ', '   ', '_ _']) {
    const x = client('nm-cid-x' + Math.random().toString(16).slice(2, 9), bad, {}, { host: A }); await x.open; await wait(250);
    assert(x.find('name-invalid') && !x.find('joined'), '쓸 수 없는 닉네임은 거절됨: ' + JSON.stringify(bad));
  }
  // 객체가 아닌 JSON 프레임 한 줄로 서버가 죽지 않는다 (입장 전·후 모두)
  const raw = client('nm-cid-r000001', '프레임'); await raw.open; await wait(250);
  const pre = new WebSocket(`ws://localhost:${PORT}`); await new Promise((r) => pre.on('open', r));
  for (const f of ['null', '5', '"x"', '[]', 'true']) { pre.send(f); raw.ws.send(f); }
  await wait(300);
  const alive = client('nm-cid-z000001', '살아있나'); await alive.open; await wait(300);
  assert(alive.find('joined') && !raw.closed, '이상한 JSON 프레임을 보내도 서버가 계속 동작함');
  pre.close();
  for (const x of [a, a2, b2, d, raw, alive]) x.send({ t: 'bye' });
  await wait(400);
}

// 입장 화면에서 '쪽지함'으로 들어온 사람: 방에는 보이지도 들어가지도 않고, 쪽지만 주고받는다
async function dmOnlyCheck() {
  const room = client('do-room-0000001', '방사람', { acct: true }); await room.open; await wait(250);
  const rj = room.find('joined');
  const d = client('do-dm-00000001', '쪽지러', { acct: true, dmOnly: true, device: 'pc' }, { host: '127.0.0.1' }); await d.open; await wait(300);
  const dj = d.find('joined');
  assert(dj?.dmOnly === true && !dj.me.host && dj.users.length === 0 && !dj.ice, '쪽지만 쓰는 연결은 방 정보(참가자·영상·음성 서버)를 받지 않음');
  assert(!room.find('user-join'), '방 사람들에게 입장 알림이 가지 않음');
  room.send({ t: 'chat', text: '방 안의 말' }); await wait(300);
  assert(!d.find('chat'), '방 채팅은 쪽지만 쓰는 사람에게 가지 않음');
  d.clear(); room.clear();
  d.send({ t: 'chat', text: '몰래 채팅' }); d.send({ t: 'voice-join' }); d.send({ t: 'queue-add', videoId: V1 }); d.send({ t: 'share-start' }); d.send({ t: 'ban', id: rj.me.id, mode: 'kick' }); await wait(400);
  assert(!room.find('chat') && !room.find('voice') && !room.find('queue') && !room.find('share-start') && !room.closed, '쪽지만 쓰는 사람은 채팅·음성·대기열·공유·강퇴를 할 수 없음');
  d.send({ t: 'dm-members' }); await wait(250);
  assert(d.find('members')?.list.some((p) => p.uid === rj.me.uid && p.online), '쪽지 상대 목록에서 방 사람을 찾을 수 있음');
  await d.dm(rj.me.uid, '방 밖에서 보낸 쪽지'); await wait(350);
  assert((await room.reveal(room.find('dm').msg)).t === '방 밖에서 보낸 쪽지', '방에 들어가지 않고도 쪽지를 보낼 수 있음');
  room.clear(); d.clear();
  await room.dm(dj.me.uid, '답장'); await wait(350);
  assert((await d.reveal(d.find('dm').msg)).t === '답장', '방 사람의 답장이 쪽지만 쓰는 사람에게 도착함');
  const late = client('do-late-0000001', '늦게온이'); await late.open; await wait(250);
  assert(!late.find('joined').users.some((u) => u.uid === dj.me.uid), '나중에 방에 들어온 사람의 참가자 목록에도 보이지 않음');
  const same = client('do-same-0000001', '쪽지러', {}, { host: '[::1]' }); await same.open; await wait(300);
  assert(same.find('name-taken') && !same.find('joined'), '다른 IP에서는 쪽지만 쓰는 사람의 닉네임도 쓸 수 없음');
  const twin = client('do-twin-0000001', '쪽지러', {}, { host: '127.0.0.1' }); await twin.open; await wait(300);
  assert(twin.find('name-taken') && !twin.find('joined'), '같은 IP에서도 쪽지만 쓰는 사람의 닉네임을 쓸 수 없음 (같은 사람으로 합쳐지지 않음)');
  room.clear(); d.ws.terminate(); await wait(2200); // 폰이 아니라서 유예 1.5초
  assert(!room.find('user-leave') && !room.find('user-away'), '쪽지만 쓰는 사람이 나가도 방에는 아무 알림이 가지 않음');
  const d2 = client('do-dm-00000002', '쪽지러셋', { acct: true, dmOnly: true }); await d2.open; await wait(300);
  assert(!d2.find('joined').me.host, '쪽지만 쓰는 연결은 호스트가 아님');
  for (const x of [room, late, d2]) x.send({ t: 'bye' });
  await wait(400);
}

// 호스트 규칙: 맨 처음 들어온 사람, 승계, 직접 넘기기, 오래 끊긴 호스트(실제 3분, 테스트 1.5초), 대기열 추가 권한. 비어 있는 방이 필요해서 서버를 따로 띄운다
async function hostCheck() {
  const port = PORT + 800;
  const env = { ...process.env, ...AUTH_ENV, PORT: String(port), STATE_FILE: STATE + '.host', CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'),
    HOST_AWAY_MS: '1500', RESUME_GRACE_MS: '800', RESUME_GRACE_MOBILE_MS: '6000', AWAY_MS: '300' };
  const sv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
  const cl = (cid, name, extra) => client(cid, name, extra, { port });
  try {
    await wait(1200);
    const A = cl('ho-a-000000001', '가나다'); await A.open; await wait(250);
    const B = cl('ho-b-000000001', '라마바'); await B.open; await wait(250);
    const C = cl('ho-c-000000001', '사아자'); await C.open; await wait(250);
    const aj = A.find('joined'), bj = B.find('joined'), cj = C.find('joined');
    assert(aj.me.host && !bj.me.host && !cj.me.host && !aj.hostKey, '맨 처음 들어온 사람이 호스트');
    assert(bj.users.find((u) => u.id === aj.me.id).host === true, '다른 사람의 목록에서 호스트가 표시됨');
    for (const x of [B, C]) { x.send({ t: 'host-give', id: cj.me.id }); x.send({ t: 'queue-grant', id: bj.me.id, on: true }); x.send({ t: 'ban', id: aj.me.id, mode: 'kick' }); }
    await wait(300);
    assert(!A.closed && !B.msgs.some((m) => m.t === 'host' || m.t === 'user-update'), '호스트가 아닌 사람의 호스트 넘기기·권한 부여·강퇴는 무시됨');

    // 직접 넘기기
    A.clear(); B.clear(); C.clear();
    A.send({ t: 'host-give', id: cj.me.id });
    await until(() => B.find('host')?.id === cj.me.id, '호스트를 넘기면 모두에게 알려 줌');
    assert(C.msgs.some((m) => m.t === 'user-update' && m.user.id === cj.me.id && m.user.host), '새 호스트가 목록에 표시됨');
    assert(A.msgs.some((m) => m.t === 'user-update' && m.user.id === aj.me.id && !m.user.host), '넘긴 사람은 더 이상 호스트가 아님');
    A.send({ t: 'ban', id: bj.me.id, mode: 'kick' }); await wait(300);
    assert(!B.closed, '넘긴 사람은 더 이상 강퇴할 수 없음');

    // 호스트가 나가면 가장 오래 있던 사람에게 (A가 B보다 먼저 들어왔다)
    A.clear(); B.clear();
    C.send({ t: 'bye' });
    await until(() => B.find('host')?.id === aj.me.id, '호스트가 나가면 가장 오래 있던 사람이 이어받음');
    assert(A.msgs.some((m) => m.t === 'user-update' && m.user.id === aj.me.id && m.user.host), '이어받은 사람 화면에서도 호스트로 바뀜');

    // 대기열 추가 권한: 기본은 호스트만, 호스트가 주고 뺏는다
    B.clear(); B.send({ t: 'queue-add', videoId: V1 }); await wait(300);
    assert(B.find('queue-denied') && !B.find('yt'), '허락받지 않은 사람은 대기열에 올릴 수 없음');
    A.send({ t: 'queue-grant', id: bj.me.id, on: true });
    await until(() => B.msgs.some((m) => m.t === 'user-update' && m.user.id === bj.me.id && m.user.canQueue), '허락하면 본인에게 알려 줌');
    B.clear(); B.send({ t: 'queue-add', videoId: V1 });
    await until(() => B.find('yt'), '허락받은 사람은 올릴 수 있음');
    A.send({ t: 'queue-grant', id: bj.me.id, on: false });
    await until(() => B.msgs.some((m) => m.t === 'user-update' && m.user.id === bj.me.id && !m.user.canQueue), '뺏으면 알려 줌');
    B.clear(); B.send({ t: 'queue-add', videoId: V2 }); await wait(300);
    assert(B.find('queue-denied'), '권한을 뺏기면 다시 올릴 수 없음');

    // 호스트의 연결이 오래 끊기면 다음 사람에게 (폰은 유예가 길어서 아직 방에 남아 있다)
    const D = cl('ho-d-000000001', '타파하', { device: 'mobile' }); await D.open; await wait(250);
    const dj = D.find('joined');
    A.send({ t: 'host-give', id: dj.me.id }); await until(() => D.find('host')?.id === dj.me.id, '폰 사용자가 호스트가 됨');
    A.clear(); B.clear();
    D.ws.terminate(); await wait(700);
    assert(!A.msgs.some((m) => m.t === 'host'), '잠깐 끊긴 호스트는 바로 바꾸지 않음');
    await until(() => A.msgs.some((m) => m.t === 'host' && m.id === aj.me.id), '오래 끊긴 호스트는 가장 오래 있던 사람에게 넘어감', 4000);
    const D2 = cl('ho-d-000000001', '타파하', { device: 'mobile', resume: { id: dj.me.id, secret: dj.resume } }); await D2.open; await wait(300);
    const d2j = D2.find('joined');
    assert(d2j.resumed && !d2j.me.host && d2j.users.find((u) => u.id === aj.me.id).host, '돌아온 옛 호스트는 호스트를 자동으로 되찾지 않음');

    // 방이 비면 호스트도, 대기열 추가 권한도 처음으로
    A.send({ t: 'queue-grant', id: bj.me.id, on: true }); await wait(200);
    for (const x of [A, B, D2]) x.send({ t: 'bye' });
    await wait(3200); // 호스트가 탭을 닫으면(bye) HOST_AWAY_MS 동안은 자리를 지키므로, 그 유예가 지나 방이 완전히 빌 때까지 기다린다
    const E = cl('ho-e-000000001', '차카타'); await E.open; await wait(250);
    const F = cl('ho-b-000000001', '라마바'); await F.open; await wait(250);
    assert(E.find('joined').me.host && !F.find('joined').me.host && !F.find('joined').me.canQueue, '방이 비었다가 다시 열리면 먼저 들어온 사람이 호스트이고 대기열 권한은 초기화됨');
    F.send({ t: 'queue-add', videoId: V3 }); await wait(300);
    assert(F.find('queue-denied'), '초기화된 권한으로는 올릴 수 없음');
    for (const x of [E, F]) x.send({ t: 'bye' });
    await wait(3200);

    // 쪽지만 쓰는 사람은 방이 비어 있어도 호스트가 되지 않는다
    const G = cl('ho-g-000000001', '파하가', { acct: true, dmOnly: true }); await G.open; await wait(250);
    const H = cl('ho-h-000000001', '나다라'); await H.open; await wait(250);
    assert(!G.find('joined').me.host && H.find('joined').me.host, '쪽지만 쓰는 사람이 먼저 와도 방에 처음 들어온 사람이 호스트');
    for (const x of [G, H]) x.send({ t: 'bye' });
    await wait(300);
  } finally { sv.kill(); fs.rmSync(STATE + '.host', { force: true }); }
}

// 계정·로그인: 가입 코드, 잠금, 토큰 순환과 도난 감지, 닉네임 변경·예약, 비밀번호 변경, 삭제, 관리자, 계정 관리, 게스트 제한. 타이머를 줄인 서버를 따로 띄운다
// 방 열림 알림: 빈 방에 첫 사람이 들어오면 푸시와 웹훅이 한 번 가고, 5분(여기서는 짧게) 안에 다시 열려도 가지 않는다
async function roomOpenCheck() {
  const port = PORT + 850;
  const env = { ...process.env, ...AUTH_ENV, PORT: String(port), STATE_FILE: STATE + '.open', CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'), PUSH_DEBUG_URL: `http://127.0.0.1:${PORT + 300}/`,
    ROOM_OPEN_WEBHOOK: `http://127.0.0.1:${PORT + 300}/hook`, ROOM_URL: 'https://room.example.test', ROOM_OPEN_COOLDOWN_MS: '3000', RESUME_GRACE_MS: '300', RESUME_GRACE_MOBILE_MS: '300', HOST_AWAY_MS: '300' }; // (호스트가 탭을 닫으면 HOST_AWAY_MS+1초 동안 자리를 지키므로, 그 시간을 짧게 해서 방이 금방 비게 한다)
  const sv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
  const cl = (cid, name, extra) => client(cid, name, extra, { port });
  try {
    await wait(1200);
    const sub = (n) => ({ endpoint: 'https://push.example.test/open' + n, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
    const A = cl('ro-a-000000001', '열림알림', { acct: true }); await A.open; await wait(300);
    const Z = cl('ro-z-000000001', '끈사람', { acct: true }); await Z.open; await wait(300);
    A.send({ t: 'push-sub', sub: sub(1), prefs: { dm: false, spoof: 'off', open: true } }); await until(() => A.find('push-ok'), '켠 기기 구독');
    Z.send({ t: 'push-sub', sub: sub(2), prefs: { dm: false, spoof: 'off' } }); await until(() => Z.find('push-ok'), '끈 기기 구독');
    A.send({ t: 'bye' }); Z.send({ t: 'bye' }); await wait(3600); // (처음 입장도 방 열림이라 5분 규칙이 시작된다: 그 시간이 지나고 방이 비도록 기다린다)
    sink.hits.length = 0;
    const B = cl('ro-b-000000001', '여는사람'); await B.open; await wait(700);
    const push1 = sink.hits.filter((h) => h.payload && h.endpoint?.includes('open1')), hook1 = sink.hits.filter((h) => h.event === 'room-open');
    assert.equal(push1.length, 1, '방이 열리면 "방이 열리면 알려 주기"를 켠 기기에 푸시가 감');
    assert(push1[0].payload.title === '시루 그룹챗' && push1[0].payload.body.includes('방이 열렸어요') && !JSON.stringify(push1[0]).includes('여는사람'), '알림에는 누가 열었는지가 들어가지 않음');
    assert(!sink.hits.some((h) => h.endpoint?.includes('open2')), '끈 기기에는 가지 않음');
    assert.equal(hook1.length, 1, '웹훅이 한 번 감');
    assert(hook1[0].text.includes('방이 열렸어요') && hook1[0].url === 'https://room.example.test' && hook1[0].content === hook1[0].text && !JSON.stringify(hook1[0]).includes('여는사람'), '웹훅 내용: 문구·주소 (디스코드·슬랙 호환 text/content), 누가 열었는지는 없음');
    B.send({ t: 'bye' }); await wait(1600); sink.hits.length = 0;
    const B2 = cl('ro-b-000000001', '여는사람'); await B2.open; await wait(700);
    assert(!sink.hits.some((h) => h.event === 'room-open' || h.endpoint?.includes('open1')), '같은 방이 바로 다시 열려도(5분 규칙) 알리지 않음');
    B2.send({ t: 'bye' }); await wait(3800); sink.hits.length = 0;
    const A3 = cl('ro-a-000000001', '열림알림', { acct: true, dmOnly: true }); await A3.open; await wait(300); sink.hits.length = 0; // 쪽지만 쓰는 연결은 방에 있는 것이 아니다
    const C = cl('ro-c-000000001', '다시여는사람'); await C.open; await wait(700);
    assert(sink.hits.some((h) => h.endpoint?.includes('open1')), '쪽지만 쓰는 연결로 접속해 있어도(방에 있는 것이 아니라서) 방이 열리면 알림이 감');
    A3.send({ t: 'bye' }); C.send({ t: 'bye' }); await wait(3800); sink.hits.length = 0;
    const D = cl('ro-d-000000001', '쪽지만', { acct: true, dmOnly: true }); await D.open; await wait(700);
    assert(!sink.hits.some((h) => h.event === 'room-open'), '쪽지만 쓰는 연결은 방을 연 것이 아님');
    D.send({ t: 'bye' });
  } finally { sv.kill(); fs.rmSync(STATE + '.open', { force: true }); }
}

async function accountCheck() {
  const port = PORT + 900;
  const env = { ...process.env, ...AUTH_ENV, PORT: String(port), STATE_FILE: STATE + '.acct', CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'), SIGNUP_PER_HOUR: '40',
    TOKEN_ROTATE_MS: '3000', TOKEN_GRACE_MS: '1200', RENAME_GAP_MS: '2500', NAME_RESERVE_MS: '2500', LOGIN_MAX_FAILS: '3', LOGIN_LOCK_MS: '1500', HOST_AWAY_MS: '1500', RESUME_GRACE_MS: '800' };
  const sv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
  const O = { port }, post = (p, b) => api(p, b, O), pwOf = (n) => 'pw-' + n + '-12345';
  const signup = (name, extra = {}) => post('/auth/signup', { name, password: pwOf(name), code: 'test-code', ...extra });
  const live = []; let n = 0;
  const cl = async (extra = {}, name) => { const c = client('ac-cid-' + String(++n).padStart(7, '0'), name || '접속' + n, extra, O); live.push(c); await c.open; await wait(250); return c; };
  const bye = async () => { for (const c of live.splice(0)) if (c.ws.readyState === 1) c.send({ t: 'bye' }); await wait(2800); }; // (호스트가 bye 를 보내도 HOST_AWAY_MS+1초는 자리를 지키므로 그 유예가 지나길 기다린다)
  const raw = (reqOpts, body) => new Promise((ok) => { const rq = http.request({ host: '127.0.0.1', port, ...reqOpts }, (res) => { let d = ''; res.on('data', (x) => (d += x)); res.on('end', () => ok({ status: res.statusCode, body: d })); }); rq.end(body); });
  try {
    await wait(1500);
    // ---- 어디서 로그인을 받는가 ----
    const st = await (await fetch(`http://localhost:${port}/auth/status`)).json();
    assert(st.allowed && st.signupOpen, '허용된 주소에서는 가입·로그인이 열려 있음');
    assert(JSON.parse((await raw({ path: '/auth/status', headers: { Host: 'evil.example' } })).body).allowed === false, '허용 목록에 없는 주소로 들어오면 로그인·가입이 닫혀 있음');
    assert.equal((await raw({ path: '/auth/login', method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, '{}')).status, 403, '다른 주소로 로그인을 시도하면 거절');
    assert.equal((await raw({ path: '/auth/login', method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'text/plain' } }, '{}')).status, 415, 'JSON이 아닌 요청은 거절 (다른 사이트의 폼 전송을 막음)');
    assert.equal((await raw({ path: '/auth/login', method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Origin: 'https://evil.example' } }, '{}')).status, 403, '출처가 다른 요청은 거절');

    // ---- 가입 ----
    assert.equal((await signup('가입자', { code: 'wrong' })).error, 'code', '가입 코드가 틀리면 거절');
    for (const bad of ['😎', 'a\u200Bb', '<b>']) assert.equal((await signup(bad)).error, 'name', '쓸 수 없는 닉네임은 거절: ' + JSON.stringify(bad));
    assert.equal((await post('/auth/signup', { name: '짧은비번', password: 'abc', code: 'test-code' })).error, 'password', '짧은 비밀번호는 거절');
    assert.equal((await post('/auth/signup', { name: 'SamePassName', password: 'samepassname', code: 'test-code' })).error, 'password', '닉네임과 같은 비밀번호는 거절');
    const s1 = await signup('가입자'); assert(s1.ok && s1.token.includes('.'), '가입하면 토큰을 받음');
    assert.equal((await signup(' 가 입 자 ')).error, 'taken', '공백만 다른 닉네임으로는 가입할 수 없음');
    assert(!JSON.stringify(JSON.parse(fs.readFileSync(STATE + '.acct', 'utf8'))).includes(pwOf('가입자')), '저장 파일에 비밀번호 원문이 없음');

    // ---- 로그인과 잠금 ----
    const bad = await post('/auth/login', { name: '가입자', password: 'nope-nope-1' });
    assert(bad.status === 401 && bad.error === 'bad', '틀린 비밀번호');
    assert.equal((await post('/auth/login', { name: '없는사람', password: 'nope-nope-1' })).msg, bad.msg, '없는 닉네임도 같은 안내 (있는지 알아내지 못하게)');
    await post('/auth/login', { name: '가입자', password: 'nope-nope-2' }); await post('/auth/login', { name: '가입자', password: 'nope-nope-3' });
    const locked = await post('/auth/login', { name: '가입자', password: pwOf('가입자') });
    assert(locked.status === 429 && locked.error === 'locked', '여러 번 틀리면 맞는 비밀번호로도 잠시 잠김');
    await wait(1700);
    assert((await post('/auth/login', { name: '가입자', password: pwOf('가입자') })).ok, '잠금이 지나면 다시 로그인됨');

    // ---- 토큰으로 입장 / 게스트 제한 ----
    const w1 = await cl({ token: s1.token }, '아무이름');
    const j1 = w1.find('joined');
    assert(j1.me.name === '가입자' && j1.me.acct === true && /^[0-9a-f]{12}$/.test(j1.me.uid), '토큰으로 들어오면 계정의 닉네임으로 입장함 (화면이 보낸 이름은 무시)');
    const g1 = await cl({}, '가입자'); assert(g1.find('name-taken') && !g1.find('joined'), '계정이 쓰는 닉네임을 게스트가 쓸 수 없음');
    const g2 = await cl({ dmOnly: true }, '게스트쪽지'); assert(g2.find('login-required') && !g2.find('joined'), '쪽지함은 로그인이 필요함');
    const g3 = await cl({}, '게스트셋');
    g3.send({ t: 'dm', to: j1.me.uid, text: '게스트가 보내는 쪽지' }); g3.send({ t: 'dm-members' }); g3.send({ t: 'push-sub', sub: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } } }); await wait(400);
    assert(g3.msgs.filter((m) => m.t === 'dm-error').length === 3 && !w1.find('dm') && !g3.find('members') && !g3.find('push-ok'), '게스트는 쪽지·쪽지 상대 목록·푸시 구독을 쓸 수 없음');
    assert(g3.find('joined').me.uid === null && g3.find('joined').me.acct === false && !g3.find('joined').inbox.length, '게스트에게는 uid가 없음');
    const g4 = await cl({ token: 'abc.def' }, '토큰틀림'); assert(g4.find('auth-expired') && g4.find('joined').me.acct === false, '틀린 토큰은 알리고 게스트로 계속함');

    // ---- 토큰 순환과 도난 감지 ----
    const r1 = await signup('토큰순환'), t0 = r1.token;
    let a = await cl({ token: t0 }); assert(!a.find('joined').token, '3일이 지나기 전에는 토큰을 바꾸지 않음'); a.send({ t: 'bye' });
    await wait(3100);
    a = await cl({ token: t0 }); const t1 = a.find('joined').token;
    assert(t1 && t1 !== t0 && t1.includes('.'), '3일(테스트에서는 3초)이 지나면 새 토큰을 내려 줌'); a.send({ t: 'bye' });
    const b = await cl({ token: t0 }); // 새 토큰을 못 받았다고 치고(응답이 유실된 폰) 옛 토큰으로 다시 옴
    assert(b.find('joined')?.me.acct && !b.find('auth-expired') && b.find('joined').token === t1, '옛 토큰이 유예 시간 안에 다시 오면 같은 새 토큰을 한 번 더 내려 줌 (끊긴 폰에서 로그인이 풀리지 않게)'); b.send({ t: 'bye' });
    await wait(1300);
    const e = await cl({ token: t1 });
    assert(e.find('joined')?.me.acct && !e.find('auth-expired'), '유예가 끝난 뒤에도 새 토큰은 그대로 쓸 수 있음'); e.send({ t: 'bye' });
    const c = await cl({ token: t0 });
    assert(c.find('auth-expired')?.reuse === true && c.find('joined').me.acct === false, '유예가 끝난 옛 토큰이 다시 오면 도난으로 보고 알림');
    const d = await cl({ token: t1 });
    assert(d.find('auth-expired') && !d.find('joined').me.acct, '그 기기의 로그인은 끊겨서 새 토큰도 쓸 수 없음');
    await bye();

    // ---- 닉네임 변경: 7일에 한 번, 옛 이름 예약, 이전 닉네임 표시 ----
    const rn = await signup('이름바꿈'), obsA = await signup('관찰자일');
    const obs = await cl({ token: obsA.token }); const mine = await cl({ token: rn.token });
    let r = await post('/auth/rename', { token: rn.token, name: '새이름' });
    assert(r.ok && r.name === '새이름' && r.prev === '이름바꿈', '닉네임을 바꿈');
    assert(obs.msgs.some((m) => m.t === 'renamed' && m.name === '새이름' && m.prev === '이름바꿈'), '바뀐 이름이 모두에게 알려짐');
    assert.equal((await post('/auth/rename', { token: rn.token, name: '또바꿈' })).error, 'gap', '7일(테스트에서는 2.5초)에 한 번만 바꿀 수 있음');
    const g5 = await cl({}, '이름바꿈'); assert(g5.find('name-taken'), '바꾼 뒤 옛 닉네임은 게스트가 못 씀(예약)');
    assert.equal((await signup('이름바꿈')).error, 'taken', '옛 닉네임으로는 가입도 못 함(예약)');
    assert.equal((await post('/auth/login', { name: '이름바꿈', password: pwOf('이름바꿈') })).status, 401, '옛 닉네임으로는 로그인되지 않음');
    assert((await post('/auth/login', { name: '새이름', password: pwOf('이름바꿈') })).ok, '새 닉네임으로 로그인됨');
    const v = await cl({}, '늦은손님'); assert.equal(v.find('joined').users.find((u) => u.name === '새이름').prev, '이름바꿈', '이전 닉네임이 다른 사람에게 보임');
    await wait(2700);
    const g6 = await cl({}, '이름바꿈'); assert(g6.find('joined'), '예약 기간이 지나면 옛 닉네임을 쓸 수 있음');
    const tk = await signup('사용중확인');
    assert.equal((await post('/auth/rename', { token: tk.token, name: '이름바꿈' })).error, 'taken', '지금 방에 있는 사람의 닉네임으로는 바꿀 수 없음');
    assert((await post('/auth/rename', { token: rn.token, name: '세번째이름' })).ok, '간격이 지나면 다시 바꿀 수 있음');
    await bye();

    // ---- 비밀번호 변경·로그아웃 ----
    const pw = await signup('비번바꿈'), dev2 = await post('/auth/login', { name: '비번바꿈', password: pwOf('비번바꿈') });
    const live2 = await cl({ token: dev2.token }), live1 = await cl({ token: pw.token }), keep = live1.find('joined').me.id;
    assert.equal((await post('/auth/password', { token: pw.token, old: 'wrong-wrong-1', new: 'brand-new-pass-1', keep })).error, 'bad', '현재 비밀번호가 틀리면 못 바꿈');
    assert.equal((await post('/auth/password', { token: pw.token, old: pwOf('비번바꿈'), new: 'short', keep })).error, 'password', '너무 짧은 새 비밀번호는 거절');
    const pc = await post('/auth/password', { token: pw.token, old: pwOf('비번바꿈'), new: 'brand-new-pass-1', keep });
    assert(pc.ok && pc.token && pc.token !== pw.token, '비밀번호를 바꾸면 이 기기는 새 토큰을 받음');
    await wait(300);
    assert(live2.find('logged-out')?.reason === 'password' && !live1.find('logged-out'), '다른 기기의 연결은 끊기고 요청한 기기는 유지됨');
    assert(!(await cl({ token: dev2.token })).find('joined').me.acct && !(await cl({ token: pw.token })).find('joined').me.acct, '옛 토큰은 모두 쓸 수 없음');
    assert((await post('/auth/login', { name: '비번바꿈', password: 'brand-new-pass-1' })).ok, '새 비밀번호로 로그인됨');
    assert((await cl({ token: pc.token })).find('joined').me.acct, '새 토큰으로 입장됨');
    await post('/auth/logout', { token: pc.token });
    assert(!(await cl({ token: pc.token })).find('joined').me.acct, '로그아웃한 토큰은 쓸 수 없음');
    const la = await post('/auth/login', { name: '비번바꿈', password: 'brand-new-pass-1' }), lb = await post('/auth/login', { name: '비번바꿈', password: 'brand-new-pass-1' });
    const liveB = await cl({ token: lb.token });
    await post('/auth/logout-all', { token: la.token }); await wait(300);
    assert(liveB.find('logged-out')?.reason === 'logout-all' && !(await cl({ token: lb.token })).find('joined').me.acct, '모든 기기에서 로그아웃하면 다른 기기도 끊김');
    await bye();

    // ---- 계정 삭제: 상대 화면에는 "탈퇴한 사용자" ----
    const del = await signup('탈퇴할사람'), friend = await signup('남는사람');
    for (const [acc, nm] of [[del, '탈퇴할사람'], [friend, '남는사람']]) { acc.keys = await newKeys(pwOf(nm)); assert((await post('/auth/keys', { token: acc.token, pub: acc.keys.pub, wrapped: acc.keys.wrapped })).ok, '키 등록'); }
    const dc = await cl({ token: del.token, keys: del.keys }), fc = await cl({ token: friend.token, keys: friend.keys });
    const duid = dc.find('joined').me.uid, fuid = fc.find('joined').me.uid;
    await dc.dm(fuid, '남기는 말'); await until(() => fc.find('dm'), '쪽지 도착');
    assert.equal((await post('/auth/delete', { token: del.token, password: 'nope-nope-12' })).error, 'bad', '비밀번호가 틀리면 삭제되지 않음');
    assert((await post('/auth/delete', { token: del.token, password: pwOf('탈퇴할사람') })).ok, '삭제됨');
    await wait(400);
    assert(dc.find('logged-out')?.reason === 'deleted', '삭제한 계정의 연결은 끊김');
    assert(fc.msgs.some((m) => m.t === 'renamed' && m.uid === duid && m.name === '탈퇴한 사용자' && m.deleted), '상대에게 "탈퇴한 사용자"로 알려짐');
    fc.clear(); fc.send({ t: 'dm-history', with: duid });
    const th = await until(() => fc.find('dm-thread'), '기록');
    assert((await fc.texts(th.msgs)).includes('남기는 말') && th.peer.name === '탈퇴한 사용자', '쪽지 기록은 상대에게 남고(탈퇴한 사람의 공개 키 기록도 남아 있어서 풀림) 이름은 "탈퇴한 사용자"');
    fc.clear(); await fc.dm(duid, '탈퇴한 사람에게'); fc.send({ t: 'dm-members' });
    assert((await until(() => fc.find('dm-error'), '오류')).msg.includes('탈퇴'), '탈퇴한 사용자에게는 보낼 수 없음');
    assert(!(await until(() => fc.find('members'), '목록')).list.some((p) => p.uid === duid), '쪽지 상대 목록에서도 빠짐');
    assert.equal((await post('/auth/login', { name: '탈퇴할사람', password: pwOf('탈퇴할사람') })).status, 401, '삭제한 계정으로는 로그인되지 않음');
    assert.equal((await fetch(`http://localhost:${port}/a/${duid}`)).status, 404, '탈퇴한 사람의 프로필 사진도 사라짐');
    const again = await signup('탈퇴할사람'); assert(again.ok, '같은 이름으로 다시 가입할 수 있음');
    assert((await cl({ token: again.token })).find('joined').me.uid !== duid, '다시 가입하면 새 사람(새 uid)');
    await bye();

    // ---- 관리자 ----
    const ad = await post('/auth/login', { name: '관리자', password: 'admin-pass-1' }); assert(ad.ok, '관리자 계정이 설정 파일대로 만들어져 로그인됨');
    const adc = await cl({ token: ad.token });
    assert(adc.find('joined').me.admin === true && !adc.find('joined').me.host, '관리자는 방에 먼저 와도 호스트가 되지 않음 (승계 순번에 안 낌)');
    const hostG = await cl({}, '게스트호스트');
    assert(hostG.find('joined').me.host && adc.msgs.some((m) => m.t === 'user-join' && m.user.name === '게스트호스트' && m.user.host), '그 다음에 들어온 사람이 호스트가 됨');
    for (const p of ['/auth/password', '/auth/rename', '/auth/delete']) assert.equal((await post(p, { token: ad.token, name: '바꿈', old: 'x', new: 'y', password: 'admin-pass-1' })).error, 'admin', '관리자 계정은 앱 안에서 바꿀 수 없음: ' + p);
    hostG.send({ t: 'ban', id: adc.find('joined').me.id, mode: 'kick' }); await wait(300);
    assert(!adc.closed, '호스트는 관리자를 내보낼 수 없음');
    const victim = await cl({}, '관리대상게스트');
    hostG.send({ t: 'ban', id: victim.find('joined').me.id, mode: 'ip' }); await wait(400);
    assert(victim.closed, '호스트의 IP 밴');
    assert(!hostG.closed && !adc.closed, '같은 IP여도 호스트와 관리자는 끊기지 않음');
    assert((await cl({ token: (await post('/auth/login', { name: '관리자', password: 'admin-pass-1' })).token })).find('joined')?.me.admin, '관리자는 IP 밴에도 들어올 수 있음');
    assert((await cl({}, '밴된IP손님')).find('banned'), '일반 사람은 IP 밴 때문에 못 들어옴');
    for (const x of hostG.last('bans').bans) hostG.send({ t: 'unban', id: x.id }); await wait(300);
    adc.send({ t: 'ban', id: hostG.find('joined').me.id, mode: 'kick' }); await wait(400);
    assert(hostG.closed, '관리자는 호스트도 내보낼 수 있음');
    await bye();

    // ---- 계정 관리는 관리자만: 호스트는 게스트일 수도 있고, 호스트가 남의 비밀번호를 초기화하면 그 계정을 가로채 쪽지를 읽을 수 있다 ----
    const mg = await signup('관리대상'), mgc = await cl({ token: mg.token }); // 맨 처음 들어온 로그인한 사람 = 호스트
    assert(mgc.find('joined').me.host, '맨 처음 들어온 계정이 호스트');
    const normal = await cl({}, '일반게스트');
    const tgt = await signup('초기화대상'), tgtc = await cl({ token: tgt.token }), tuid = tgtc.find('joined').me.uid;
    for (const who of [normal, mgc]) { who.send({ t: 'acct-list' }); who.send({ t: 'acct-reset', uid: tuid }); who.send({ t: 'acct-delete', uid: tuid }); who.send({ t: 'acct-ban', uid: tuid, on: true }); }
    await wait(500);
    assert(![normal, mgc].some((x) => x.find('accts') || x.find('acct-reset') || x.find('acct-deleted')) && !tgtc.find('logged-out') && !tgtc.find('banned') && (await post('/auth/login', { name: '초기화대상', password: pwOf('초기화대상') })).ok,
      '호스트도 일반 참가자도 계정 목록·비밀번호 초기화·삭제·계정 밴을 할 수 없음 (호스트가 남의 계정을 가로채지 못하게)');
    const adm = await cl({ token: (await post('/auth/login', { name: '관리자', password: 'admin-pass-1' })).token });
    adm.send({ t: 'acct-list' });
    const list = (await until(() => adm.find('accts'), '목록')).list, adminUid = list.find((x) => x.role === 'admin').uid;
    assert(list.some((x) => x.uid === tuid && x.role === 'user' && x.online) && list.some((x) => x.role === 'admin' && x.name === '관리자'), '관리자에게는 계정 목록(접속 여부, 관리자 표시)이 보임');
    adm.send({ t: 'acct-reset', uid: adminUid }); adm.send({ t: 'acct-delete', uid: adminUid }); adm.send({ t: 'acct-ban', uid: adminUid, on: true }); await wait(300);
    assert(!adm.find('acct-reset') && !adm.find('acct-deleted') && (await post('/auth/login', { name: '관리자', password: 'admin-pass-1' })).ok, '관리자 계정은 초기화·삭제·밴할 수 없음');
    adm.send({ t: 'acct-reset', uid: tuid });
    const rs = await until(() => adm.find('acct-reset'), '임시 비밀번호');
    assert(/^[A-Za-z0-9]{10}$/.test(rs.temp) && rs.name === '초기화대상', '임시 비밀번호가 관리자에게만 내려옴');
    await wait(300);
    assert(tgtc.find('logged-out')?.reason === 'reset' && !(await cl({ token: tgt.token })).find('joined').me.acct, '초기화하면 옛 로그인은 모두 풀림');
    const tl = await post('/auth/login', { name: '초기화대상', password: rs.temp }); assert(tl.ok && tl.mustChange === true, '임시 비밀번호로 로그인하면 새로 정해야 한다고 알려 줌');
    assert((await cl({ token: tl.token })).find('must-change'), '새 비밀번호를 정하기 전에는 입장할 수 없음');
    const np = await post('/auth/password', { token: tl.token, old: rs.temp, new: 'after-reset-pass-1' }); assert(np.ok, '임시 비밀번호로 새 비밀번호를 정함');
    assert((await cl({ token: np.token })).find('joined')?.me.acct, '새 비밀번호를 정하면 입장됨');
    adm.send({ t: 'acct-ban', uid: tuid, on: true }); await wait(300);
    assert((await cl({ token: np.token })).find('banned'), '계정 밴: 그 계정은 들어올 수 없음');
    adm.send({ t: 'acct-ban', uid: tuid, on: false }); await wait(300);
    assert((await cl({ token: np.token })).find('joined'), '계정 밴을 풀면 다시 들어옴');
    adm.send({ t: 'acct-delete', uid: tuid });
    assert((await until(() => adm.find('acct-deleted'), '삭제 응답')).uid === tuid, '관리자가 계정을 삭제함');
    assert.equal((await post('/auth/login', { name: '초기화대상', password: 'after-reset-pass-1' })).status, 401, '삭제된 계정으로는 로그인되지 않음');
    await bye();

    // ---- 가입 시도가 너무 많으면 막힘 (마지막: 이 IP의 가입 횟수를 모두 쓴다) ----
    let hit = 0;
    for (let i = 0; i < 80 && !hit; i++) if ((await signup('도배' + i, { code: 'wrong' })).status === 429) hit = i;
    assert(hit > 0, '같은 IP에서 가입을 너무 많이 시도하면 막힘');
  } finally { sv.kill(); fs.rmSync(STATE + '.acct', { force: true }); }
}

// 프록시 뒤 운영(TRUST_PROXY): X-Forwarded-* 는 프록시가 보낸 것일 때만 믿는다. 실제 운영처럼 https를 강제(AUTH_ALLOW_HTTP 없음)하고 확인한다
async function proxyCheck() {
  const port = PORT + 960;
  const run = (over = {}) => spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore', env: { ...process.env, PORT: String(port), STATE_FILE: STATE + '.proxy', CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'),
    TRUST_PROXY: '1', AUTH_HOST: 'sirugc.kro.kr', AUTH_ALLOW_HTTP: '', SIGNUP_CODE: 'x', ADMIN_NAME: '', ADMIN_PASSWORD: '', PROXY_IP: '', ...over } });
  const status = (headers) => new Promise((ok, no) => http.get({ host: '127.0.0.1', port, path: '/auth/status', headers }, (res) => { let d = ''; res.on('data', (x) => (d += x)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
  const https = { Host: 'sirugc.kro.kr', 'X-Forwarded-Proto': 'https' };
  let sv = run();
  try {
    await wait(1400);
    assert.equal((await status(https)).allowed, true, '프록시가 https로 넘긴 요청에서는 로그인·가입이 열림');
    assert.equal((await status({ Host: 'sirugc.kro.kr' })).allowed, false, 'https 표시가 없으면 열리지 않음');
    assert.equal((await status({ Host: 'sirugc.kro.kr', 'X-Forwarded-Proto': 'http' })).allowed, false, 'http로 들어온 요청은 열리지 않음');
    assert.equal((await status({ ...https, Host: 'evil.example' })).allowed, false, '허용 목록에 없는 주소는 열리지 않음');
    assert.equal((await status({ Host: '127.0.0.1', 'X-Forwarded-Host': 'sirugc.kro.kr', 'X-Forwarded-Proto': 'https' })).allowed, true, '프록시가 X-Forwarded-Host로 원래 주소를 알려도 됨');
    sv.kill(); await wait(700); sv = run({ PROXY_IP: '203.0.113.9' }); await wait(1400);
    assert.equal((await status(https)).allowed, false, '프록시가 아닌 곳이 https·주소 표시를 위조해도 믿지 않음 (PROXY_IP)');
    sv.kill(); await wait(700); sv = run({ PROXY_IP: '127.0.0.1,::1' }); await wait(1400);
    assert.equal((await status(https)).allowed, true, 'PROXY_IP에 있는 프록시가 보낸 요청은 믿음');
  } finally { sv.kill(); fs.rmSync(STATE + '.proxy', { force: true }); }
}

// 2.0 첫 시작: 옛 저장 파일은 백업하고 새로 시작한다. 관리자·가입 코드는 설정 파일이 기준이다. 서버를 껐다 켜며 확인한다
async function migrationCheck() {
  const port = PORT + 950, file = STATE + '.mig', dir = path.dirname(file), baseName = path.basename(file);
  fs.writeFileSync(file, JSON.stringify({ hostKey: 'old-host-key', salt: 'old-salt', bans: [{ id: 'b1', type: 'cid', value: 'x', label: '옛밴' }], vapid: { publicKey: 'old-pub', privateKey: 'old-priv' },
    members: { aaaaaaaaaaaa: { name: '옛사람' } }, dms: { 'aaaaaaaaaaaa~bbbbbbbbbbbb': [{ id: '1', from: 'aaaaaaaaaaaa', to: 'bbbbbbbbbbbb', text: '옛 쪽지', ts: Date.now() }] }, subs: { aaaaaaaaaaaa: [{ endpoint: 'https://x', keys: {}, prefs: {} }] }, blocks: {}, cleared: {} }));
  const run = (over = {}, drop = []) => { const e = { ...process.env, ...AUTH_ENV, PORT: String(port), STATE_FILE: file, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'), ...over }; for (const k of drop) delete e[k]; return spawn(process.execPath, ['server.js'], { cwd: __dirname, env: e, stdio: 'ignore' }); };
  const stop = async (s) => { s.kill(); await wait(600); };
  let sv = run();
  try {
    await wait(1500);
    const baks = fs.readdirSync(dir).filter((x) => x.startsWith(baseName + '.bak-'));
    assert(baks.length === 1 && JSON.parse(fs.readFileSync(path.join(dir, baks[0]), 'utf8')).hostKey === 'old-host-key', '옛 저장 파일이 .bak 으로 백업됨 (지워지지 않음)');
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(now.schema === 3 && !now.hostKey && !now.salt && !Object.keys(now.dms).length && !Object.keys(now.subs).length && !now.bans.length && !Object.keys(now.members).length && now.vapid.publicKey !== 'old-pub', '쪽지, 푸시 구독, 밴, 호스트 키, 푸시 키가 새로 시작됨');
    const ad = await api('/auth/login', { name: '관리자', password: 'admin-pass-1' }, { port }); assert(ad.ok, '관리자가 설정 파일대로 만들어짐');
    assert(!fs.readFileSync(file, 'utf8').includes('admin-pass-1'), '저장 파일에 관리자 비밀번호 원문이 없음');
    await stop(sv);
    assert.equal(fs.readdirSync(dir).filter((x) => x.startsWith(baseName + '.bak-')).length, 1, '이미 새 형식이면 다시 백업하지 않음');

    // 설정 파일이 기준: 관리자 비밀번호를 바꾸고 다시 켜면 옛 비밀번호와 옛 로그인이 모두 무효
    sv = run({ ADMIN_PASSWORD: 'admin-pass-2' }); await wait(1500);
    assert.equal((await api('/auth/login', { name: '관리자', password: 'admin-pass-1' }, { port })).status, 401, '바뀐 설정에서는 옛 관리자 비밀번호가 안 됨');
    assert(!(await (async () => { const c = client('mig-cid-000001', 'x', { token: ad.token }, { port }); await c.open; await wait(300); return c.find('joined').me.acct; })()), '옛 관리자 로그인(토큰)은 풀림');
    const ad2 = await api('/auth/login', { name: '관리자', password: 'admin-pass-2' }, { port }); assert(ad2.ok, '새 비밀번호로 로그인됨');
    await stop(sv);

    // 관리자 설정을 빼면 관리자가 아니다 / 가입 코드가 없으면 가입이 닫혀 있다
    sv = run({}, ['ADMIN_NAME', 'ADMIN_PASSWORD', 'SIGNUP_CODE']); await wait(1500);
    const c = client('mig-cid-000002', 'x', { token: (await api('/auth/login', { name: '관리자', password: 'admin-pass-2' }, { port })).token }, { port }); await c.open; await wait(300);
    assert(c.find('joined').me.acct && !c.find('joined').me.admin, '설정에서 관리자를 빼면 그 계정은 일반 계정이 됨');
    assert.equal((await (await fetch(`http://localhost:${port}/auth/status`)).json()).signupOpen, false, '가입 코드가 없으면 가입이 닫혀 있다고 알림');
    assert.equal((await api('/auth/signup', { name: '새사람', password: 'some-password-1', code: '' }, { port })).error, 'closed', '가입 코드가 없으면 가입할 수 없음');
    c.send({ t: 'bye' });
    // 쪽지가 암호화되기 전 버전(스키마 2)에서 올라오면 계정은 그대로 두고 평문 쪽지만 비운다
    await stop(sv);
    const keep = JSON.parse(fs.readFileSync(file, 'utf8')); keep.schema = 2; keep.dms = { 'a~b': [{ id: '9', from: 'a', to: 'b', text: '평문 쪽지', ts: Date.now() }] };
    fs.writeFileSync(file, JSON.stringify(keep));
    sv = run({}, ['ADMIN_NAME', 'ADMIN_PASSWORD', 'SIGNUP_CODE']); await wait(1500);
    const mig = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(mig.schema === 3 && !Object.keys(mig.dms).length && Object.keys(mig.accounts).length >= 1 && !JSON.stringify(mig).includes('평문 쪽지'), '암호화 전 버전의 저장 파일은 계정을 남기고 평문 쪽지만 비움');
  } finally { sv.kill(); for (const x of fs.readdirSync(dir)) if (x.startsWith(baseName)) fs.rmSync(path.join(dir, x), { force: true }); }
}

// 폰·태블릿은 화면이 꺼져도 PC보다 훨씬 오래 방에 남는다 (알림 확인하고 돌아올 시간). PC 1.5초, 폰 4.5초로 줄여서 시험
async function graceCheck() {
  const obs = client('gr-obs-0000001', '지켜보는이'); await obs.open; await wait();
  const m = client('gr-mob-0000001', '폰사람', { device: 'mobile' }); await m.open; await wait();
  const p = client('gr-pc-00000001', '피씨사람', { device: 'pc' }); await p.open; await wait(200);
  const mj = m.find('joined'), pj = p.find('joined');
  m.send({ t: 'voice-join' }); await wait(200); obs.clear();
  m.ws.terminate(); p.ws.terminate(); // 둘 다 갑자기 끊김 (폰은 화면이 꺼짐)
  await until(() => obs.find('user-leave')?.id === pj.me.id, 'PC는 1.5초 유예 뒤에 나감', 3000);
  assert(!obs.msgs.some((x) => x.t === 'user-leave' && x.id === mj.me.id), '같은 시각에 폰은 아직 방에 남아 있음');
  assert(obs.msgs.some((x) => x.t === 'user-away' && x.id === mj.me.id && x.away === true), '오래 끊긴 폰은 다른 사람에게 "자리 비움"으로 알려짐');
  await until(() => obs.last('voice') && !obs.last('voice').list.some((v) => v.id === mj.me.id), '끊긴 폰의 음성은 1.5초 뒤에 정리됨', 2500);
  assert(!obs.msgs.some((x) => x.t === 'user-leave' && x.id === mj.me.id), '음성이 정리돼도 방에는 계속 남아 있음');
  await wait(1500); // 합쳐서 약 3.5초: 폰 유예(4.5초) 안
  const m2 = client('gr-mob-0000001', '폰사람', { device: 'mobile', resume: { id: mj.me.id, secret: mj.resume } }); await m2.open; await wait(300);
  const rj = m2.find('joined');
  assert(rj.resumed === true && rj.me.id === mj.me.id, '화면을 켜고 돌아오면 같은 자리를 이어받음');
  assert(!rj.voice.some((v) => v.id === mj.me.id), '오래 끊겨 있던 동안 정리된 음성은 돌아온 뒤에도 꺼져 있음 (화면이 이 상태에 맞춘다)');
  await until(() => obs.last('user-away')?.id === mj.me.id && obs.last('user-away').away === false, '돌아오면 "자리 비움"이 풀림', 1500);
  await wait(5000);
  assert(!obs.msgs.some((x) => x.t === 'user-leave' && x.id === mj.me.id), '돌아온 뒤에는 유예 시간이 지나도 내보내지 않음');

  // 앱이 완전히 닫혔다가(비밀 값 없음) 알림을 눌러 다시 열려도 같은 자리를 쓴다: 유령이 둘로 보이지 않는다
  m2.ws.terminate(); await wait(800); obs.clear();
  const m3 = client('gr-mob-0000001', '폰사람', { device: 'mobile' }); await m3.open; await wait(400);
  const j3 = m3.find('joined');
  assert(j3.me.id === mj.me.id && !j3.resumed, '비밀 값 없이 다시 열어도 끊겨 있던 같은 기기의 자리를 그대로 씀');
  assert(!obs.find('user-leave') && obs.find('user-join')?.back === true, '다른 사람에게는 나갔다 들어온 새 사람이 아니라 돌아온 것으로 보임');
  await wait(5200);
  assert(!obs.find('user-leave'), '이전 유령 타이머가 남아 새 자리를 내보내지 않음');
  for (const x of [obs, m3]) x.send({ t: 'bye' }); await wait(300);
}

// 끊겼다가 돌아오면 같은 세션을 이어받는다 (폰이 와이파이↔데이터를 갈아타거나 절전에서 깨어날 때)
async function resumeCheck() {
  const obs = client('obs-cid-00000001', '관찰자'); await obs.open; await wait();
  const x = client('xx-cid-000000001', '엑스'); await x.open; await wait();
  const xj = x.find('joined');
  assert(xj.resume && xj.resume.length >= 16, '입장하면 이어받기용 비밀 값을 받음');
  x.send({ t: 'voice-join' }); await wait(200);
  obs.clear();

  x.ws.terminate(); await wait(600); // 연결이 갑자기 끊김
  assert(!obs.find('user-leave'), '끊긴 직후에는 다른 사람에게 퇴장 알림이 가지 않음 (유예 시간)');
  const x2 = client('xx-cid-000000001', '엑스', { resume: { id: xj.me.id, secret: xj.resume } }); await x2.open; await wait(300);
  const rj = x2.find('joined');
  assert(rj.resumed === true && rj.me.id === xj.me.id && rj.me.uid === xj.me.uid, '같은 id로 세션을 이어받음');
  assert(rj.voice.some((v) => v.id === xj.me.id), '음성 참가 상태가 그대로 남아 있음');
  assert(rj.users.every((u) => u.id !== xj.me.id), '내 id는 users 목록에 중복되지 않음');
  await wait(1800);
  assert(!obs.find('user-leave') && !obs.find('user-join'), '이어받은 뒤에는 나갔다 들어온 알림이 전혀 없음 (깜빡임 없음)');

  // 비밀 값이 틀리면 이어받기(resumed)로 처리되지 않고 새 입장이다. 같은 기기(cid)면 끊겨 있던 자리를 그대로 쓰고, 남의 기기면 새 자리다(아래 '도둑')
  x2.ws.terminate(); await wait(300); obs.clear();
  const bad = client('xx-cid-000000001', '엑스', { resume: { id: xj.me.id, secret: 'wrong-secret-0000' } }); await bad.open; await wait(300);
  assert(!bad.find('joined').resumed, '틀린 비밀 값은 이어받기로 처리되지 않음');
  assert.equal(bad.find('joined').me.id, xj.me.id, '같은 기기라면 끊겨 있던 자리를 그대로 씀 (유령이 둘로 보이지 않음)');
  assert(!obs.find('user-leave'), '그동안 나갔다 들어온 알림은 없음');
  bad.send({ t: 'bye' });
  await until(() => obs.find('user-leave')?.id === xj.me.id, '나가기 신호를 보내면 바로 나감', 1000);

  // 서버가 아직 끊긴 걸 모르는 소켓(와이파이↔데이터 전환: 폰은 끊김을 아는데 서버는 모름)도 새 연결이 넘겨받는다. 중복 참가자가 생기지 않는다
  assert(/^[0-9a-z]{6,}$/.test(xj.build || ''), '입장 응답에 화면 버전 번호가 들어 있음');
  const w = client('ww-cid-000000001', '더블유'); await w.open; await wait(200);
  const wj = w.find('joined'); obs.clear();
  const w2 = client('ww-cid-000000001', '더블유', { resume: { id: wj.me.id, secret: wj.resume } }); await w2.open; await wait(500);
  assert(w2.find('joined').resumed === true && w2.find('joined').me.id === wj.me.id, '옛 소켓이 아직 살아 있어도 비밀 값이 맞으면 이어받음');
  await until(() => w.closed, '넘겨준 옛 소켓은 서버가 정리함', 1500);
  await wait(1800);
  assert(!obs.find('user-leave') && !obs.find('user-join'), '넘겨받는 동안 나갔다 들어온 알림이 없고 참가자가 둘이 되지 않음');
  w2.send({ t: 'bye' }); await wait(300);

  // 다른 사람의 cid로는 이어받을 수 없음
  const y = client('yy-cid-000000001', '와이'); await y.open; await wait(200);
  const yj = y.find('joined'); y.ws.terminate(); await wait(200);
  const thief = client('thief-cid-0000001', '도둑', { resume: { id: yj.me.id, secret: yj.resume } }); await thief.open; await wait(300);
  assert(!thief.find('joined').resumed, '비밀 값을 알아도 cid가 다르면 이어받지 못함');

  // 강퇴는 유예 없이 바로 나감 (끊긴 것과 달리 자리를 남겨 두지 않는다)
  const hostAgain = mainHost; // main()의 호스트는 아직 방에 있다
  assert(!hostAgain.closed, '호스트가 방에 남아 있음');
  const k = client('kick-cid-0000001', '강퇴대상'); await k.open; await wait(200);
  const kid = k.find('joined').me.id; obs.clear();
  hostAgain.send({ t: 'ban', id: kid, mode: 'kick' });
  await until(() => obs.find('user-leave')?.id === kid, '강퇴하면 바로 나감', 700); // 유예(1.5초)보다 빨라야 함
  assert(k.closed || (await until(() => k.closed, '강퇴 대상의 연결이 끊김', 500)), '강퇴 대상은 연결이 끊김');

  // 일부러 나가기('bye')는 유예 없이 바로 나감
  const z = client('bye-cid-000000001', '바이'); await z.open; await wait(200);
  const zid = z.find('joined').me.id; obs.clear();
  z.send({ t: 'bye' });
  await until(() => obs.find('user-leave')?.id === zid, '나가기 신호를 보내면 바로 나감', 700);

  // 앱 ping
  obs.send({ t: 'ping' }); await until(() => obs.find('pong'), 'ping에 pong으로 답함', 1000);
}

// ---- 사진/동영상 업로드 ----
const fake = {
  jpg: (n = 300) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(n, 7)]),
  png: (n = 300) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]),
  gif: () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100, 1)]),
  webp: () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), Buffer.alloc(100, 1)]),
  mp4: (n = 300) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(n, 1)]),
  mov: () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypqt  '), Buffer.alloc(100, 1)]),
  webm: () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100, 1)]),
  heic: () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(100, 1)]),
  html: () => Buffer.from('<html><script>alert(1)</script></html>'.padEnd(200, ' ')),
  svg: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(200, ' ')),
};
async function uploadCheck() {
  const base = 'http://localhost:' + PORT;
  const post = (body, token, type = 'application/octet-stream', extra = {}) => fetch(base + '/upload', { method: 'POST', headers: { 'X-Token': token ?? '', 'Content-Type': type, ...extra }, body });
  const u = client('up-cid-000000001', '업로더', { acct: true }); await u.open; await wait(300);
  const token = u.find('joined').upload;
  assert(typeof token === 'string' && token.length >= 16, '입장하면 업로드 토큰을 받음');

  assert.equal((await post(fake.jpg(), '')).status, 401, '토큰이 없으면 거부');
  assert.equal((await post(fake.jpg(), 'wrong-token-0000')).status, 401, '틀린 토큰은 거부');
  for (const kind of ['html', 'svg', 'heic']) assert.equal((await post(fake[kind](), token, 'image/jpeg')).status, 415, kind + '는 이미지라고 우겨도 거부 (파일 내용으로 판별)');

  for (const [kind, ctype, ext] of [['jpg', 'image/jpeg', 'jpg'], ['png', 'image/png', 'png'], ['gif', 'image/gif', 'gif'], ['webp', 'image/webp', 'webp'], ['mp4', 'video/mp4', 'mp4'], ['mov', 'video/quicktime', 'mov'], ['webm', 'video/webm', 'webm']]) {
    const r = await post(fake[kind](), token); assert.equal(r.status, 200, kind + ' 업로드 성공');
    const j = await r.json();
    assert(new RegExp('^/f/[0-9a-f]{32}\\.' + ext + '$').test(j.url), kind + ': 무작위 이름과 판별된 확장자 (' + j.url + ')');
    assert.equal(j.kind, ctype.startsWith('video') ? 'video' : 'image');
    const head = await fetch(base + j.url);
    assert.equal(head.headers.get('content-type'), ctype, kind + ' 제공할 때 Content-Type');
  }
  const jpg = fake.jpg(), j = await (await post(jpg, token)).json();
  const g = await fetch(base + j.url);
  assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/jpeg');
  assert.equal(g.headers.get('x-content-type-options'), 'nosniff'); assert(/sandbox/.test(g.headers.get('content-security-policy')), 'CSP sandbox');
  assert(Buffer.from(await g.arrayBuffer()).equals(jpg), '올린 그대로 내려옴');
  const r1 = await fetch(base + j.url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(r1.status, 206); assert.equal(r1.headers.get('content-range'), 'bytes 0-9/' + jpg.length); assert.equal((await r1.arrayBuffer()).byteLength, 10, 'Range: 앞 10바이트');
  const r2 = await fetch(base + j.url, { headers: { Range: 'bytes=-5' } });
  assert.equal(r2.status, 206); assert.deepEqual(Buffer.from(await r2.arrayBuffer()), jpg.subarray(-5), 'Range: 끝 5바이트');
  assert.equal((await fetch(base + j.url, { headers: { Range: 'bytes=99999-' } })).status, 416, '범위를 벗어나면 416');
  for (const bad of ['/f/..%2f..%2fserver.js', '/f/' + '0'.repeat(32) + '.html', '/f/' + '0'.repeat(32) + '.jpg', '/f/../server.js']) assert.equal((await fetch(base + bad)).status, 404, bad + ' → 404');

  assert.equal((await post(fake.jpg(1_200_000), token)).status, 413, '1MB 제한(테스트 설정)을 넘으면 413');
  assert.equal((await post(fake.mp4(1_200_000), token)).status, 413, '동영상도 한도를 넘으면 413');

  // 시간당 용량 한도 (테스트 설정 2MB)
  const q = client('q-cid-0000000001', '용량'); await q.open; await wait(300);
  const qt = q.find('joined').upload;
  assert.equal((await post(fake.jpg(900_000), qt)).status, 200); assert.equal((await post(fake.jpg(900_000), qt)).status, 200);
  assert.equal((await post(fake.jpg(900_000), qt)).status, 429, '시간당 한도를 넘으면 429');

  // 채팅에 첨부: 우리가 저장한 파일만 허용
  const o = client('o-cid-00000000001', '구경꾼'); await o.open; await wait(300); o.clear();
  u.send({ t: 'chat', text: '', media: { url: j.url, w: 640, h: 480 } });
  const cm = await until(() => o.find('chat'), '첨부만 있는 채팅');
  assert(cm.media.url === j.url && cm.media.kind === 'image' && cm.media.w === 640 && cm.text === '', '글 없이 사진만 보내도 전달됨');
  o.clear(); await wait(450);
  for (const bad of ['http://evil.example/x.jpg', '/f/../../server.js', '/f/' + 'a'.repeat(32) + '.jpg', '/etc/passwd']) { u.send({ t: 'chat', text: '', media: { url: bad } }); await wait(350); }
  u.send({ t: 'chat', text: '', media: { url: 5 } }); await wait(900);
  assert(!o.find('chat'), '남의 주소, 없는 파일, 경로 침투 첨부는 무시');
  u.send({ t: 'chat', text: '설명', media: { url: j.url, w: 99999 } }); const cm2 = await until(() => o.find('chat'), '글+첨부');
  assert(cm2.text === '설명' && cm2.media.w === undefined, '말이 안 되는 크기 값은 버림');

  // 쪽지에 첨부 + 푸시 문구
  const target = client('t-cid-00000000001', '받는이', { acct: true }); await target.open; await wait(300);
  const tuid = target.find('joined').me.uid; target.clear();
  target.send({ t: 'push-sub', sub: { endpoint: 'https://push.example.test/up', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, prefs: { dm: true, spoof: 'off' } }); await until(() => target.find('push-ok'), '구독');
  target.send({ t: 'vis', v: false }); await wait(200); sink.hits.length = 0; await wait(450);
  const photo = fake.jpg(5000), encd = await encryptFile(photo);
  const upr = await post(encd.blob, token, 'application/octet-stream', { 'X-Enc': '1' }), uj = await upr.json();
  assert(upr.status === 200 && /^\/f\/[0-9a-f]{32}\.bin$/.test(uj.url) && uj.kind === 'enc', '기기에서 암호화한 파일은 종류를 모르는 덩어리(.bin)로 올라감');
  const got = await fetch(base + uj.url), gotBuf = Buffer.from(await got.arrayBuffer());
  assert(got.headers.get('content-type') === 'application/octet-stream' && /attachment/.test(got.headers.get('content-disposition')) && gotBuf.equals(encd.blob) && !gotBuf.subarray(0, 3).equals(photo.subarray(0, 3)), '서버에 있는 것은 암호문 그대로이고 사진 모양이 아님 (바로 열리지도 않음)');
  assert((await decryptFile(gotBuf, encd.key, encd.iv)).equals(photo), '쪽지 안에 든 키로 풀면 원래 사진이 나옴');
  assert.equal((await post(fake.jpg(), token, 'application/octet-stream', { 'X-Enc': '1' })).status, 200, '암호화한 척 올린 파일도 그냥 덩어리로 보관(서버는 안을 보지 않음)');
  o.clear(); u.send({ t: 'chat', text: '', media: { url: uj.url } }); await wait(500);
  assert(!o.find('chat'), '암호화된 덩어리는 쪽지 전용이라 방 채팅에는 붙일 수 없음');
  await u.dm(tuid, '', { url: uj.url, key: encd.key, iv: encd.iv, kind: 'image', w: 10, h: 10, type: 'image/jpeg' });
  const dmm = await until(() => target.find('dm'), '첨부 쪽지 도착');
  const pt = await target.reveal(dmm.msg);
  assert(pt.m.url === uj.url && pt.m.key === encd.key && pt.t === '' && !JSON.stringify(dmm.msg).includes(encd.key), '첨부 쪽지는 받는 기기에서만 풀리고, 첨부 정보와 파일 키는 서버가 볼 수 없음');
  await until(() => sink.hits.length, '푸시');
  assert.equal(sink.hits[0].payload.body, '새 쪽지가 왔어요', '푸시에는 "새 쪽지가 왔어요"만 나옴 (내용·종류는 서버도 모름)');
  target.ws.close(); await wait(200);
  const t2 = client('t-cid-00000000001', '받는이', { acct: true }); await t2.open; await wait(300);
  assert((await t2.preview(t2.find('joined').inbox[0])).m.url === uj.url, '목록 미리보기도 받는 기기가 풂');
  for (const c of [u, q, o, t2]) c.ws.close();
}
// 오래된 파일 자동 삭제와 서버 전체 용량 한도
async function purgeCheck() {
  const port = PORT + 700, dir = path.join(os.tmpdir(), 'up-purge-' + Date.now());
  const env = { ...process.env, PORT: String(port), STATE_FILE: STATE + '.purge', CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env'), UPLOAD_DIR: dir,
    UPLOAD_KEEP_MS: '1200', UPLOAD_SWEEP_MS: '300', UPLOAD_MAX_TOTAL_MB: '1', UPLOAD_MAX_IMAGE_MB: '1' };
  const sv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
  try {
    await wait(1000);
    const ws = new WebSocket('ws://localhost:' + port); const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d))); await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', name: '청소', cid: 'purge-cid-0000001' })); await wait(300);
    const tok = msgs.find((m) => m.t === 'joined').upload, base = 'http://localhost:' + port;
    const up = async (b) => (await fetch(base + '/upload', { method: 'POST', headers: { 'X-Token': tok }, body: b })).json();
    const a = await up(fake.jpg(600_000)), b = await up(fake.jpg(600_000)); // 합치면 1MB를 넘는다 → 오래된 a를 지워 자리를 만든다
    assert.equal((await fetch(base + a.url)).status, 404, '서버 전체 용량이 차면 가장 오래된 파일부터 지워짐');
    assert.equal((await fetch(base + b.url)).status, 200, '새 파일은 남음');
    await wait(2200);
    assert.equal((await fetch(base + b.url)).status, 404, '보관 기간이 지나면 자동으로 삭제됨');
    ws.close();
  } finally { sv.kill(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(STATE + '.purge', { force: true }); }
}

// config.env: 주석, 따옴표, 윈도우 줄바꿈(CRLF)을 읽고, 이미 있는 환경변수가 우선하는지, 정상 종료 시 접속자에게 알리는지
async function configCheck() {
  const port = PORT + 600, file = path.join(os.tmpdir(), `cfg-${Date.now()}.env`);
  fs.writeFileSync(file, ['# 주석', 'PORT=' + (port + 1), 'HOST=127.0.0.1', 'TURN_URL="cfg.example.com:3478"', 'AUTH_HOST=127.0.0.1', 'AUTH_ALLOW_HTTP=1', 'SIGNUP_CODE=cfg-code', 'ICE_SERVERS=[{"urls":"relay.example.com:3478","username":"u","credential":"c"},{"urls":["turns:relay.example.com:5349","stun:relay.example.com:3478"]}]', "TURN_SECRET='cfg-secret'", '', 'STATE_FILE=' + STATE + '.cfg'].join('\r\n'));
  const env = { ...process.env, CONFIG_FILE: file, PORT: String(port) }; // PORT는 환경변수가 이기고
  delete env.TURN_URL; delete env.TURN_SECRET; delete env.HOST; delete env.STATE_FILE; // 나머지는 파일에서 읽어야 함
  const s = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
  try {
    await wait(1000);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(await res.text(), 'ok', '환경변수 PORT가 config.env의 PORT보다 우선');
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    const su = await (await fetch(`http://127.0.0.1:${port}/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '설정', password: 'cfg-pass-12345', code: 'cfg-code' }) })).json();
    assert(su.ok, 'config.env의 SIGNUP_CODE·AUTH_HOST로 가입이 열림');
    ws.send(JSON.stringify({ t: 'join', name: '설정', cid: 'cfg-cid-0000001', token: su.token })); await wait(300);
    const ice = msgs.find((m) => m.t === 'joined').ice;
    assert.deepEqual(ice.find((x) => x.credential && x.username !== 'u')?.urls, ['turn:cfg.example.com:3478'], '따옴표가 벗겨지고 CRLF 파일도 읽히고, TURN_URL에 turn: 이 없으면 붙여 줌');
    assert.deepEqual(ice.find((x) => x.username === 'u').urls, ['turn:relay.example.com:3478'], 'ICE_SERVERS에 turn: 이 없으면 붙여 줌(없으면 브라우저가 WebRTC를 통째로 거부)');
    assert.deepEqual(ice.find((x) => !x.username && String(x.urls).includes('turns:')).urls, ['turns:relay.example.com:5349', 'stun:relay.example.com:3478'], '이미 접두어가 있는 주소는 그대로');
    // 푸시 구독 주소는 브라우저 제조사의 푸시 서비스만 허용 (서버가 남이 정한 주소로 요청을 보내지 않도록)
    for (const [endpoint, ok] of [['https://evil.example.com/x', false], ['http://fcm.googleapis.com/x', false], ['https://169.254.169.254/x', false], ['https://fcm.googleapis.com/fcm/send/abc', true], ['https://updates.push.services.mozilla.com/wpush/v2/abc', true], ['https://web.push.apple.com/abc', true]]) {
      msgs.length = 0;
      ws.send(JSON.stringify({ t: 'push-sub', sub: { endpoint, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, prefs: {} })); await wait(200);
      assert.equal(!!msgs.find((m) => m.t === 'push-ok'), ok, `푸시 주소 ${endpoint} → ${ok ? '허용' : '거부'}`);
    }
    // 정상 종료: 접속자에게 shutdown을 먼저 알린다 (윈도우에서는 신호를 못 보내므로 리눅스 계열에서만 확인)
    if (process.platform !== 'win32') {
      s.kill('SIGTERM'); await wait(400);
      assert(msgs.some((m) => m.t === 'shutdown'), 'SIGTERM을 받으면 접속자에게 shutdown을 알림');
    }
    ws.close();
  } finally { s.kill(); fs.rmSync(file, { force: true }); fs.rmSync(STATE + '.cfg', { force: true }); }
}

sinkServer.listen(PORT + 300, '127.0.0.1');
const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: STATE, CONFIG_FILE: require('path').join(require('os').tmpdir(), 'no-such-config.env'), RESUME_GRACE_MS: '1500', RESUME_GRACE_MOBILE_MS: '4500', AWAY_MS: '500', UPLOAD_DIR: path.join(os.tmpdir(), 'up-main-' + Date.now()), UPLOAD_MAX_IMAGE_MB: '1', UPLOAD_MAX_VIDEO_MB: '1', UPLOAD_USER_MB_PER_HOUR: '2', TURN_URL: 'turn:turn.example.com:3478', TURN_SECRET: 'test-secret', PUSH_DEBUG_URL: `http://127.0.0.1:${PORT + 300}/` }, stdio: 'ignore' });
// ONLY=hostCheck,roomOpenCheck 처럼 이름을 주면 그 구간만 돌린다 (고치는 중에 빨리 확인하려고)
const STEPS = { main, dmFullCheck, e2eeCheck, nameCheck, dmOnlyCheck, hostCheck, roomOpenCheck, accountCheck, migrationCheck, proxyCheck, graceCheck, resumeCheck, uploadCheck, purgeCheck, configCheck };
(async () => {
  await wait(1000);
  for (const [n, f] of Object.entries(STEPS)) if (!process.env.ONLY || process.env.ONLY.split(',').includes(n)) await f();
  console.log('OK');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { sinkServer.close(); srv.kill(); fs.rmSync(STATE, { force: true }); process.exit(); });
