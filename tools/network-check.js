// 폰에서 네트워크가 바뀌거나(와이파이↔데이터) 잠깐 끊겼을 때 다시 연결되는지 실제 브라우저로 확인한다.
//  1) 소리 없이 죽은 연결(IP가 바뀌면 이렇게 된다)에서 네트워크 변경 신호가 오면 몇 초 안에 같은 자리로 다시 연결
//  2) 신호가 없는 기기(iPhone)도 심장박동으로 알아채서 다시 연결
//  3) 서버에 한참 못 닿아도(터널·전환) 폰은 "서버가 꺼졌습니다"로 포기하지 않고 계속 시도해서, 닿으면 저절로 다시 입장
//  4) PC는 예전처럼 서버가 꺼졌다고 안내
// 실행: node tools/network-check.js
const { launch, wait, reporter } = require('./_cdp');
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

(async () => {
  const h = await launch({ env: { RESUME_GRACE_MOBILE_MS: '60000', RESUME_GRACE_MS: '60000' } });
  const { check, done } = reporter();
  try {
    const obs = await h.page(1100, 800); await obs.type('#nameIn', '지켜보는이'); await obs.tap('#enter'); await obs.until('joined');
    const P = await h.page(390, 844, { mobile: true, ua: ANDROID }); await P.type('#nameIn', '폰'); await P.tap('#enter'); await P.until('joined');
    const myId = await P.js('me');
    const noLeave = () => obs.js(`![...document.querySelectorAll('.sys')].some((x) => x.textContent.includes('폰 님이 나갔어요')) && users.filter((u) => u.name === '폰').length === 1`);

    console.log('소리 없이 죽은 연결 + 네트워크 변경 신호');
    // 와이파이→데이터로 바뀌면 옛 연결은 끊김 표시도 없이 죽는다: 서버가 보내는 것을 더 이상 받지 못하게 만들어 흉내 낸다
    await P.js(`window.__oldWs = ws; ws.onmessage = () => {}; true`);
    await P.js(`navigator.connection && navigator.connection.dispatchEvent(new Event('change'))`);
    check(await P.until(`ws !== window.__oldWs && joined && !reconnecting && ws.readyState === 1`, 9000), '네트워크 변경 신호 뒤 몇 초 안에 새 연결로 다시 붙음');
    check(await P.js(`me === ${JSON.stringify(myId)}`), '같은 자리(같은 번호)를 이어받음');
    check(await noLeave(), '다른 사람 화면에서는 나갔다 들어온 알림 없이 참가자도 하나뿐');

    console.log('신호가 없는 기기(iPhone)는 심장박동으로');
    await P.js(`window.__oldWs = ws; ws.onmessage = () => {}; true`); // 아무 신호도 보내지 않는다
    check(await P.until(`ws !== window.__oldWs && joined && !reconnecting && ws.readyState === 1`, 40000), '신호 없이도 몇 십 초 안에 죽은 연결을 알아채고 다시 붙음');
    check(await P.js(`me === ${JSON.stringify(myId)}`) && await noLeave(), '같은 자리, 알림 없음');

    console.log('인터넷이 한참 끊겼다 돌아옴 (온라인 이벤트)');
    await P.js(`window.__oldWs = ws; ws.onmessage = () => {}; dispatchEvent(new Event('online')); true`);
    check(await P.until(`ws !== window.__oldWs && joined && !reconnecting && ws.readyState === 1`, 9000), '"인터넷 연결됨" 신호에도 같은 방식으로 다시 붙음');

    console.log('서버에 한참 못 닿는 동안 폰은 포기하지 않음');
    await h.stopServer();
    await wait(16000); // PC 라면 12초 넘으면 "서버가 꺼졌습니다" 페이지로 바뀌는 시간
    check(await P.js(`!serverDown && !ended && !!document.querySelector('#app') && !document.querySelector('#app').hidden`), '16초가 지나도 폰은 방 화면에 그대로 있고 "서버가 꺼졌습니다"로 바뀌지 않음');
    check(await P.js(`!document.querySelector('#net').hidden && document.querySelector('#net').textContent.includes('다시 연결')`), '"연결이 끊겼어요. 다시 연결하는 중" 안내가 보임');
    await h.startServer();
    check(await P.until(`joined && !reconnecting && ws.readyState === 1`, 20000), '서버가 다시 켜지면 저절로 다시 입장함 (새로고침 없이)');
    check(await P.js(`document.querySelector('#net').hidden`), '안내 띠가 사라짐');
    await P.shot('E:/tmpchk/network-phone.png');

    console.log('PC는 예전대로');
    await h.stopServer();
    check(await obs.until(`serverDown && document.title === '서버가 꺼졌습니다'`, 30000), 'PC는 12초 넘게 서버가 안 보이면 "서버가 꺼졌습니다" 안내');
  } finally { await h.close(); }
  process.exit(done());
})().catch((e) => { console.error(e); process.exit(1); });
