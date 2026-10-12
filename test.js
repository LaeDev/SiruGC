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
let hostKeyForTests; // main()에서 정해진 호스트 키 (다른 점검에서 호스트로 다시 접속할 때 씀)
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
  const host = client('host-cid-0001', '호스트', { avatar: AVATAR, color: '#FF6B8B', device: 'tablet' }); await host.open; await wait();
  const hj = host.find('joined');
  hostKeyForTests = hj.hostKey;
  assert(hj.me.host && hj.hostKey, '첫 입장자는 호스트');
  assert.equal(hj.me.avatar, AVATAR, '정상 프사는 저장됨');
  assert.equal(hj.me.color, '#ff6b8b', '내 색은 소문자 #rrggbb로 저장됨');

  const a = client('alice-cid-0001', '앨리스', { avatar: 'javascript:alert(1)', color: 'red;background:url(x)', device: '<b>toaster</b>' }); await a.open; await wait();
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
  a.send({ t: 'queue-move', qid: ids[1], to: 0 }); await wait(400);
  assert(!host.find('queue'), '남이 올린 항목은 일반 참가자가 옮길 수 없음');
  a.send({ t: 'queue-move', qid: mine, to: 0 }); await until(() => host.last('queue')?.queue[0].qid === mine, '자기가 올린 항목은 옮길 수 있음');
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
  const h2 = client('host-cid-0001', '호스트', { hostKey: hj.hostKey }); await h2.open; await wait();
  assert(h2.find('joined').me.host && h2.find('joined').bans.length === 2, '호스트는 밴 중에도 입장 + 목록 확인');

  // 해제 후 입장 가능
  for (const ban of h2.find('joined').bans) h2.send({ t: 'unban', id: ban.id });
  await wait();
  const d = client('dave-cid-000001', '데이브'); await d.open; await wait();
  assert(d.find('joined'), '해제 후 입장 가능');
}

// 쪽지 완성: 읽음 표시, 삭제, 대화 정리, 차단, 전체 회원 목록
async function dmFullCheck() {
  const mk = async (cid, name) => { const c = client(cid, name); await c.open; await wait(300); c.uid = c.find('joined').me.uid; return c; };
  const x1 = await mk('dmf-1-cid-000001', '쪽지일'), x2 = await mk('dmf-2-cid-000001', '쪽지이'), x3 = await mk('dmf-3-cid-000001', '쪽지삼');
  x3.ws.close(); await wait(300); // 삼은 오프라인

  x1.send({ t: 'dm-members' });
  const mem = (await until(() => x1.find('members'), '회원 목록')).list;
  assert(!mem.some((u) => u.uid === x1.uid), '회원 목록에 나는 없음');
  const off = mem.find((u) => u.uid === x3.uid);
  assert(off && off.online === false && mem.find((u) => u.uid === x2.uid).online === true, '오프라인인 사람도 목록에 있고 접속 중 여부가 표시됨');
  assert(mem.findIndex((u) => u.uid === x2.uid) < mem.findIndex((u) => u.uid === x3.uid), '접속 중인 사람이 먼저');

  // 읽음 표시
  x1.send({ t: 'dm', to: x2.uid, text: '읽음 확인' }); const sent = (await until(() => x2.find('dm'), '쪽지 도착')).msg;
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
  x1.send({ t: 'dm', to: x2.uid, text: '정리 전 1' }); await wait(500); x1.send({ t: 'dm', to: x2.uid, text: '정리 전 2' }); await wait(500);
  x2.clear(); x2.send({ t: 'dm-clear', with: x1.uid }); await until(() => x2.find('dm-cleared'), '정리 알림');
  x2.send({ t: 'dm-history', with: x1.uid }); assert.equal((await until(() => x2.find('dm-thread'), '기록')).msgs.length, 0, '정리한 쪽에서는 이전 쪽지가 안 보임');
  x1.clear(); x1.send({ t: 'dm-history', with: x2.uid }); assert((await until(() => x1.find('dm-thread'), '기록')).msgs.length >= 2, '상대 화면의 기록은 그대로');
  x1.send({ t: 'dm', to: x2.uid, text: '정리 후' }); await wait(500);
  x2.clear(); x2.send({ t: 'dm-history', with: x1.uid }); assert.deepEqual((await until(() => x2.find('dm-thread'), '기록')).msgs.map((m) => m.text), ['정리 후'], '정리한 뒤 온 쪽지만 보임');
  const x2b = client('dmf-2-cid-000001', '쪽지이'); await x2b.open; await wait(300);
  assert.equal(x2b.find('joined').inbox.find((c) => c.uid === x1.uid).last.text, '정리 후', '다시 접속해도 정리가 유지되고 목록 미리보기는 새 쪽지');
  x2b.ws.close();

  // 차단
  x2.send({ t: 'dm-read', with: x1.uid }); await wait(400); // 차단 전에 받아 둔 쪽지는 먼저 읽어 둔다 (그 읽음 알림이 아래 확인과 섞이지 않게)
  x2.send({ t: 'push-sub', sub: { endpoint: 'https://push.example.test/blk', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, prefs: { dm: true, spoof: 'off' } }); await until(() => x2.find('push-ok'), '구독');
  x2.send({ t: 'vis', v: false }); x2.clear(); x2.send({ t: 'dm-block', uid: x1.uid, on: true });
  assert.deepEqual((await until(() => x2.find('blocks'), '차단 목록')).list, [x1.uid], '차단하면 목록이 돌아옴');
  x2.clear(); x1.clear(); sink.hits.length = 0; await wait(450);
  x1.send({ t: 'dm', to: x2.uid, text: '차단된 상태의 쪽지' }); await until(() => x1.find('dm'), '보낸 사람 화면에는 정상으로 보임');
  await wait(600);
  assert(!x2.find('dm'), '차단한 사람에게는 쪽지가 도착하지 않음');
  assert.equal(sink.hits.length, 0, '알림(푸시)도 가지 않음');
  x2.send({ t: 'dm-history', with: x1.uid }); assert(!(await until(() => x2.find('dm-thread'), '기록')).msgs.some((m) => m.text === '차단된 상태의 쪽지'), '차단한 쪽 기록에는 안 남음');
  x1.send({ t: 'dm-history', with: x2.uid }); assert((await until(() => x1.find('dm-thread'), '기록')).msgs.some((m) => m.text === '차단된 상태의 쪽지'), '차단당한 쪽 기록에는 남아 있음(차단 사실을 숨김)');
  x2.send({ t: 'dm-read', with: x1.uid }); x1.clear(); await wait(300); assert(!x1.find('dm-seen'), '전달되지 않은 쪽지는 읽음으로 바뀌지 않음');
  x2.clear(); x2.send({ t: 'dm', to: x1.uid, text: '내가 차단한 사람에게' }); assert((await until(() => x2.find('dm-error'), '오류')).msg.includes('차단'), '내가 차단한 사람에게는 보낼 수 없고 이유를 알려 줌');
  x2.send({ t: 'dm-block', uid: x1.uid, on: false }); await until(() => x2.last('blocks')?.list.length === 0, '차단 해제'); x1.clear(); x2.clear(); await wait(450);
  x1.send({ t: 'dm', to: x2.uid, text: '해제 뒤' }); await until(() => x2.find('dm'), '차단을 풀면 다시 도착함');
  const x2c = client('dmf-2-cid-000001', '쪽지이'); await x2c.open; await wait(300);
  assert.deepEqual(x2c.find('joined').blocks, [], '입장할 때 차단 목록을 받음');
  x2.send({ t: 'dm-block', uid: 'ffffffffffff', on: true }); x2.send({ t: 'dm-block', uid: x2.uid, on: true }); await wait(300);
  assert(!x2.msgs.some((m) => m.t === 'blocks' && m.list.includes('ffffffffffff')) && !x2.msgs.some((m) => m.t === 'blocks' && m.list.includes(x2.uid)), '모르는 사람이나 나 자신은 차단할 수 없음');
  for (const c of [x1, x2, x2c]) c.send({ t: 'bye' }); // 유예 없이 바로 정리해서 뒤의 점검에 퇴장 알림이 섞이지 않게
  await wait(400);
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

  // 비밀 값이 틀리면 이어받지 못하고 새로 입장한다 (남의 세션을 가로채지 못함)
  x2.ws.terminate(); await wait(300); obs.clear();
  const bad = client('xx-cid-000000001', '엑스', { resume: { id: xj.me.id, secret: 'wrong-secret-0000' } }); await bad.open; await wait(300);
  assert(!bad.find('joined').resumed && bad.find('joined').me.id !== xj.me.id, '틀린 비밀 값은 새 세션으로 입장');
  assert.equal(obs.find('user-leave')?.id, undefined, '옛 세션은 아직 유예 중');
  await until(() => obs.find('user-leave')?.id === xj.me.id, '유예 시간이 지나면 옛 세션이 정리됨', 4000);

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
  const hostAgain = client('host-cid-0001', '호스트', { hostKey: hostKeyForTests }); await hostAgain.open; await wait(200);
  assert(hostAgain.find('joined').me.host, '호스트 키로 다시 호스트로 접속');
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
  const post = (body, token, type = 'application/octet-stream') => fetch(base + '/upload', { method: 'POST', headers: { 'X-Token': token ?? '', 'Content-Type': type }, body });
  const u = client('up-cid-000000001', '업로더'); await u.open; await wait(300);
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
  const target = client('t-cid-00000000001', '받는이'); await target.open; await wait(300);
  const tuid = target.find('joined').me.uid; target.clear();
  target.send({ t: 'push-sub', sub: { endpoint: 'https://push.example.test/up', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } }, prefs: { dm: true, spoof: 'off' } }); await until(() => target.find('push-ok'), '구독');
  target.send({ t: 'vis', v: false }); await wait(200); sink.hits.length = 0; await wait(450);
  u.send({ t: 'dm', to: tuid, text: '', media: { url: j.url, w: 10, h: 10 } });
  const dmm = await until(() => target.find('dm'), '첨부 쪽지 도착');
  assert(dmm.msg.media.url === j.url && dmm.msg.text === '', '글 없이 사진만 보낸 쪽지가 전달됨');
  await until(() => sink.hits.length, '푸시');
  assert.equal(sink.hits[0].payload.body, '(사진)', '푸시에는 "(사진)"이라고만 나옴');
  target.ws.close(); await wait(200);
  const t2 = client('t-cid-00000000001', '받는이'); await t2.open; await wait(300);
  assert.equal(t2.find('joined').inbox[0].last.text, '(사진)', '목록 미리보기도 "(사진)"');
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
const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, STATE_FILE: STATE, CONFIG_FILE: require('path').join(require('os').tmpdir(), 'no-such-config.env'), RESUME_GRACE_MS: '1500', UPLOAD_DIR: path.join(os.tmpdir(), 'up-main-' + Date.now()), UPLOAD_MAX_IMAGE_MB: '1', UPLOAD_MAX_VIDEO_MB: '1', UPLOAD_USER_MB_PER_HOUR: '2', TURN_URL: 'turn:turn.example.com:3478', TURN_SECRET: 'test-secret', PUSH_DEBUG_URL: `http://127.0.0.1:${PORT + 300}/` }, stdio: 'ignore' });
wait(1000).then(main).then(dmFullCheck).then(resumeCheck).then(uploadCheck).then(purgeCheck).then(configCheck).then(() => console.log('OK'), (e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { sinkServer.close(); srv.kill(); fs.rmSync(STATE, { force: true }); process.exit(); });
