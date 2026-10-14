// 2026-10 요청 묶음 A·B·C 중 서버가 하는 일을 실제 서버로 확인한다 (브라우저 없이 웹소켓으로):
//  호스트 알림 도배 방지, 자동 정리는 조용히, 같은 기기 중복 정리, 놓친 채팅 복구, 프로필 바꾸기.
// 실행: node tools/round3-check.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 6100 + Math.floor(Math.random() * 300);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-'));
const STATE = path.join(tmp, 'state.json');
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', AVATAR2 = 'data:image/png;base64,iVBORw0KGgo=';

function client(cid, name, extra = {}) {
  const c = { msgs: [], closed: false };
  c.ws = new WebSocket(`ws://localhost:${PORT}`);
  c.open = new Promise((r) => c.ws.on('open', () => { c.ws.send(JSON.stringify({ t: 'join', name, cid, ...extra })); r(); }));
  c.ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
  c.ws.on('close', () => (c.closed = true));
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.all = (t) => c.msgs.filter((m) => m.t === t);
  c.find = (t) => c.msgs.find((m) => m.t === t);
  c.last = (t) => c.all(t).at(-1);
  c.clear = () => (c.msgs.length = 0);
  return c;
}

(async () => {
  // 채팅 보관 기간: 마지막 대화로부터 24시간이 지나면 전부 지우고, 대화가 이어지는 동안은 오래된 것도 남는다 (서버 없이 모듈만 확인)
  {
    const createChatLog = require('../chatlog'), H = 3600e3, now = Date.now();
    const mk = (name, ages) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify({ seq: ages.length, log: ages.map((h, i) => ({ seq: i + 1, text: 'x' + i, ts: now - h * H, c: 'abc' })), seen: {} })); const c = createChatLog(f); c.flush(); return JSON.parse(fs.readFileSync(f, 'utf8')).log.length; };
    console.log('채팅 보관 기간');
    assert.equal(mk('c-old.json', [30, 25]), 0);
    console.log('  통과 마지막 대화가 24시간보다 오래됐으면 전부 지움');
    assert.equal(mk('c-live.json', [30, 1]), 2);
    console.log('  통과 대화가 이어지는 동안(마지막이 1시간 전)은 30시간 전 글도 남음');
    assert.equal(mk('c-max.json', Array.from({ length: 1200 }, (_, i) => 1 + i / 1000)), 1000);
    console.log('  통과 1000개를 넘으면 최근 1000개만 남음');
  }
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, PORT, STATE_FILE: STATE, CONFIG_FILE: path.join(tmp, 'none.env'), RESUME_GRACE_MS: '1500', RESUME_GRACE_MOBILE_MS: '1500', HOST_AWAY_MS: '2500', AWAY_MS: '500' },
  });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(1500);

    console.log('호스트 알림: 같은 사람이 자기 자리를 되찾을 때는 조용히');
    const h = client('host-cid-00001', '호스트', { avatar: AVATAR, color: '#112233', device: 'pc' }); await h.open; await wait();
    const a = client('alice-cid-0001', '앨리스'); await a.open; await wait();
    check(h.find('joined').me.host && !a.find('joined').me.host, '맨 처음 사람이 호스트');
    a.clear();
    h.ws.close(); await wait(600); // 연결이 끊겼다 (탭을 닫거나 새로고침)
    const h2 = client('host-cid-00001', '호스트', { avatar: AVATAR }); await h2.open; await wait();
    check(h2.find('joined').me.host, '돌아온 호스트가 그대로 호스트');
    check(a.all('host').length === 0, '돌아와도 다른 사람 화면에 "호스트가 됐어요"가 뜨지 않음');
    check(a.all('user-leave').length === 0, '그 사이 "나갔어요"도 없음 (자리를 이어받음)');

    console.log('호스트 탭 닫기(bye)는 바로 넘기지 않고 기다림');
    a.clear(); h2.send({ t: 'bye' }); await wait(800);
    check(a.all('host').length === 0 && a.all('user-leave').length === 0, '호스트가 탭을 닫아도 곧바로 호스트가 넘어가지 않음');
    const h3 = client('host-cid-00001', '호스트', { avatar: AVATAR }); await h3.open; await wait();
    check(h3.find('joined').me.host && a.all('host').length === 0, '곧 돌아오면 조용히 호스트 유지');

    console.log('시간이 지나 자동으로 정리되면 "나갔어요" 없이 조용히');
    const b = client('bob-cid-000001', '밥'); await b.open; await wait();
    a.clear(); b.ws.close(); await wait(3500); // 유예(1.5초)가 지나 자동으로 정리됨
    const lv = a.all('user-leave');
    check(lv.length === 1 && lv[0].quiet === true, '자동 정리된 사람의 user-leave 에는 quiet 표시가 있음');
    check(a.all('user-away').some((m) => m.away), '그 전에 자리 비움 표시는 갔음');

    console.log('같은 기기가 두 번 보이지 않기 (새로고침 전 페이지, 다른 탭)');
    const t1 = client('tab-cid-0000001', '탭'); await t1.open; await wait();
    const idBefore = t1.find('joined').me.id;
    a.clear();
    const t2 = client('tab-cid-0000001', '탭'); await t2.open; await wait();
    check(t1.find('replaced') && t1.closed, '옛 탭에는 "다른 곳에서 접속했어요"를 알리고 끊음');
    check(t2.find('joined').me.id === idBefore, '새 탭이 같은 자리(번호)를 이어받음');
    check(a.all('user-leave').length === 0 && a.all('user-join').every((m) => m.back || m.user.id === idBefore), '다른 사람 화면에는 새 사람이 늘어나지 않음');
    const usersNow = t2.find('joined').users.filter((u) => u.name === '탭').length;
    check(usersNow === 0, '내 입장 응답의 목록에 나와 같은 이름이 또 들어 있지 않음');

    console.log('직접 나가기(방 나가기)는 호스트도 바로 넘김');
    const hid = h3.find('joined').me.id; a.clear();
    h3.send({ t: 'bye', manual: true }); await wait(500);
    const lv2 = a.all('user-leave').find((m) => m.id === hid);
    check(!!lv2 && !lv2.quiet, '호스트가 방 나가기를 누르면 바로 나가고 "나갔어요"도 보임 (탭을 닫는 것과 다름)');
    check(a.all('host').length === 1, '바로 다음 사람에게 호스트가 넘어감');

    console.log('놓친 채팅 복구 (돌아온 같은 기기에만)');
    a.send({ t: 'chat', text: '카라가 오기 전 말' }); await wait(500);
    const c = client('cara-cid-000001', '카라'); await c.open; await wait();
    const cj = client('cara-cid-000001', '카라'); // 같은 기기가 다시 들어옴 (새 창)
    c.ws.close(); await wait(100); await cj.open; await wait();
    check(cj.find('joined').backlog?.length === 0, '입장하기 전의 채팅은 받지 않음 (처음 들어온 시점부터)');
    const seq0 = a.last('chat')?.seq;
    check(Number.isInteger(seq0) && seq0 >= 1, '채팅에 번호(seq)가 붙어 옴');
    cj.ws.close(); await wait(200);
    a.send({ t: 'chat', text: '카라가 없을 때 1' }); await wait(450); a.send({ t: 'chat', text: '카라가 없을 때 2', }); await wait(300);
    const cj2 = client('cara-cid-000001', '카라', { lastSeq: seq0 }); await cj2.open; await wait();
    const bl = cj2.find('joined').backlog || [];
    check(bl.length === 2 && bl[0].text === '카라가 없을 때 1' && bl[1].text === '카라가 없을 때 2', `자리를 비운 사이의 채팅 2개를 순서대로 받음 (받은 ${bl.length}개)`);
    check(!bl.some((m) => m.text === '카라가 오기 전 말'), '이미 본 것은 다시 받지 않음');
    const stranger = client('new-cid-00000001', '처음'); await stranger.open; await wait();
    check(stranger.find('joined').backlog.length === 0, '처음 오는 사람에게는 옛 채팅이 없음');
    check(!JSON.stringify(cj2.find('joined')).includes('cara-cid'), '기기 비밀 식별자는 내려가지 않음');
    const mineBl = client('alice-cid-0001', '앨리스2', { lastSeq: seq0 - 1 });
    a.ws.close(); await wait(100); await mineBl.open; await wait();
    check(mineBl.find('joined').backlog.some((m) => m.mine), '내가 보낸 채팅에는 mine 표시가 붙음');

    console.log('디스크에 저장 (서버를 다시 켜도 남음)');
    srv.kill(); await wait(800);
    const chatFile = fs.readdirSync(tmp).find((f) => f.includes('chat'));
    const saved = chatFile ? JSON.parse(fs.readFileSync(path.join(tmp, chatFile), 'utf8')) : null;
    check(saved && saved.log.length >= 3 && saved.log.every((e) => e.ts && e.text !== undefined), `채팅 기록 파일이 있음 (${saved?.log.length}개)`);
    check(saved && !JSON.stringify(saved).includes('cara-cid-000001') && saved.log.every((e) => !e.cid), '기기 식별자 원문은 파일에 없음 (해시만)');
  } finally { srv.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
