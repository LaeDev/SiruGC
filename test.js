// 실행: `npm test` — 임시 상태 파일로 서버를 직접 띄워서 밴 / 대기열 / 재생 시계 / 공유 / 프사 로직을 확인한다.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3100 + Math.floor(Math.random() * 500);
const STATE = path.join(os.tmpdir(), `chat-test-${Date.now()}.json`);
const AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const V1 = 'dQw4w9WgXcQ', V2 = 'jNQXAC9IVRw', V3 = 'aqz-KE-bpKQ';

// 가짜 푸시 서비스: 실제 푸시 대신 서버가 이 주소로 알림 내용을 보낸다 (PUSH_DEBUG_URL)
const sink = { hits: [], status: 201 };
const sinkServer = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => { sink.hits.push(JSON.parse(body)); res.writeHead(sink.status).end(); });
});

function client(cid, name, extra = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [], closed: false };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
  ws.on('close', () => (c.closed = true));
  c.open = new Promise((r) => ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', name, cid, ...extra })); r(); }));
  c.send = (m) => ws.send(JSON.stringify(m));
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
  const host = client('host-cid-0001', '호스트', { avatar: AVATAR, color: '#FF6B8B' }); await host.open; await wait();
  const hj = host.find('joined');
  assert(hj.me.host && hj.hostKey, '첫 입장자는 호스트');
  assert.equal(hj.me.avatar, AVATAR, '정상 프사는 저장됨');
  assert.equal(hj.me.color, '#ff6b8b', '내 색은 소문자 #rrggbb로 저장됨');

  const a = client('alice-cid-0001', '앨리스', { avatar: 'javascript:alert(1)', color: 'red;background:url(x)' }); await a.open; await wait();
  const aj = a.find('joined');
  assert(!aj.me.host, '두번째는 일반 참가자');
  assert.equal(aj.me.avatar, null, '잘못된 프사는 버려짐');
  assert.equal(aj.me.color, null, '잘못된 색은 버려짐 (CSS 주입 방지)');
  assert.equal(aj.users[0].color, '#ff6b8b', '다른 참가자의 색이 전달됨');
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
  a.clear(); host.send({ t: 'yt-seek', time: 100 }); await wait();
  assert(a.find('yt').time >= 100 && a.find('yt').time < 102, '위치 이동이 다른 사람에게 전달됨');

  // ---- 권한: 올린 사람 또는 호스트만 빼기/건너뛰기 ----
  const b = client('bob-cid-000001', '밥'); await b.open; await wait();
  const qid = q1.queue[0].qid;
  host.clear(); b.send({ t: 'queue-remove', qid }); b.send({ t: 'yt-next' }); await wait(300);
  assert(!host.find('queue'), '남이 올린 건 못 뺌 (대기열 변경 방송 없음)');
  assert(!host.find('yt'), '남이 올린 영상은 건너뛰기 불가 (영상 변경 방송 없음)');

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
  b.send({ t: 'queue-add', videoId: V3 });
  await until(() => host.last('yt')?.videoId === V3 && host.last('yt')?.playing, '끝난 뒤 추가하면 바로 재생');
  b.send({ t: 'yt-next' }); await wait(200); // 올린 본인이 건너뛰면 끝남
  await until(() => host.last('yt')?.ended, '본인이 건너뛰기');
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
  a.send({ t: 'dm', to: hostUid, text: '  안녕, 쪽지야  ' });
  const dm1 = await until(() => host.find('dm'), '쪽지 도착');
  assert.equal(dm1.msg.text, '안녕, 쪽지야', '앞뒤 공백은 잘림'); assert.equal(dm1.msg.from, aliceUid); assert.equal(dm1.peer.name, '앨리스');
  assert(a.find('dm'), '보낸 사람 화면에도 같은 쪽지가 옴(여러 기기 동기화)');
  a.clear(); a.send({ t: 'dm', to: aliceUid, text: '나에게' }); a.send({ t: 'dm', to: 'ffffffffffff', text: '모르는 사람' }); a.send({ t: 'dm', to: hostUid, text: '   ' }); await wait(500);
  assert(!a.find('dm'), '자기 자신, 모르는 사람, 빈 글은 무시');
  a.send({ t: 'dm', to: hostUid, text: 'x'.repeat(700) }); a.send({ t: 'dm', to: hostUid, text: '너무 빨라' }); await wait(500);
  assert.equal(host.msgs.filter((m) => m.t === 'dm').length, 2, '0.4초 안의 연속 쪽지는 도배로 막힘');
  assert.equal(host.last('dm').msg.text.length, 500, '500자까지만');
  host.send({ t: 'dm-history', with: aliceUid });
  assert.equal((await until(() => host.find('dm-thread'), '기록')).msgs.length, 2, '대화 기록을 불러옴');

  // 오프라인인 사람에게도 전달 + 안 읽음 표시 + 읽음 처리
  const z = client('zed-cid-0000001', '제드'); await z.open; await wait();
  const zUid = z.find('joined').me.uid; z.ws.close(); await wait(300);
  a.send({ t: 'dm', to: zUid, text: '자고 있니?' }); await wait(500);
  const z2 = client('zed-cid-0000001', '제드'); await z2.open; await wait();
  const inbox = z2.find('joined').inbox;
  assert(inbox.length === 1 && inbox[0].uid === aliceUid && inbox[0].unread === 1 && inbox[0].last.text === '자고 있니?' && inbox[0].online, '오프라인 쪽지가 안 읽음 1로 도착');
  z2.send({ t: 'dm-read', with: aliceUid }); await wait(300); z2.ws.close(); await wait(200);
  const z3 = client('zed-cid-0000001', '제드'); await z3.open; await wait();
  assert.equal(z3.find('joined').inbox[0].unread, 0, '읽음 처리가 저장됨');

  // ---- 푸시 알림: 화면을 안 볼 때만, 위장 설정대로 ----
  const sub = (n) => ({ endpoint: 'https://push.example.test/' + n, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } });
  const dmTo = async (text) => { sink.hits.length = 0; a.send({ t: 'dm', to: zUid, text }); await wait(500); return sink.hits; };
  z3.send({ t: 'push-sub', sub: sub(1), prefs: { dm: true, spoof: 'off' } }); await until(() => z3.find('push-ok'), '구독 등록');
  z3.send({ t: 'vis', v: true }); await wait(100);
  assert.equal((await dmTo('보고 있을 때')).length, 0, '화면을 보고 있으면 푸시를 보내지 않음');
  z3.send({ t: 'vis', v: false }); await wait(100);
  let hit = (await dmTo('안 볼 때'))[0];
  assert(hit && hit.payload.title === '앨리스' && hit.payload.body === '안 볼 때' && hit.payload.uid === aliceUid, '화면을 안 보면 보낸 사람과 내용이 보임');
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
  const h2 = client('host-cid-0001', '호스트', { hostKey: hj.hostKey }); await h2.open; await wait();
  assert(h2.find('joined').me.host && h2.find('joined').bans.length === 2, '호스트는 밴 중에도 입장 + 목록 확인');

  // 해제 후 입장 가능
  for (const ban of h2.find('joined').bans) h2.send({ t: 'unban', id: ban.id });
  await wait();
  const d = client('dave-cid-000001', '데이브'); await d.open; await wait();
  assert(d.find('joined'), '해제 후 입장 가능');
}

// config.env: 주석, 따옴표, 윈도우 줄바꿈(CRLF)을 읽고, 이미 있는 환경변수가 우선하는지, 정상 종료 시 접속자에게 알리는지
async function configCheck() {
  const port = PORT + 600, file = path.join(os.tmpdir(), `cfg-${Date.now()}.env`);
  fs.writeFileSync(file, ['# 주석', 'PORT=' + (port + 1), 'HOST=127.0.0.1', 'TURN_URL="cfg.example.com:3478"', 'ICE_SERVERS=[{"urls":"relay.example.com:3478","username":"u","credential":"c"},{"urls":["turns:relay.example.com:5349","stun:relay.example.com:3478"]}]', "TURN_SECRET='cfg-secret'", '', 'STATE_FILE=' + STATE + '.cfg'].join('\r\n'));
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
    ws.send(JSON.stringify({ t: 'join', name: '설정', cid: 'cfg-cid-0000001' })); await wait(300);
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
const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, STATE_FILE: STATE, CONFIG_FILE: require('path').join(require('os').tmpdir(), 'no-such-config.env'), TURN_URL: 'turn:turn.example.com:3478', TURN_SECRET: 'test-secret', PUSH_DEBUG_URL: `http://127.0.0.1:${PORT + 300}/` }, stdio: 'ignore' });
wait(1000).then(main).then(configCheck).then(() => console.log('OK'), (e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { sinkServer.close(); srv.kill(); fs.rmSync(STATE, { force: true }); process.exit(); });
