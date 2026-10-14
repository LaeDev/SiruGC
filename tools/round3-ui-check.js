// 요청 묶음 A의 화면 쪽을 실제 브라우저로 확인한다: 이모티콘 그림, 채팅 복원, 프로필 바로 바뀜, 화면 공유 안내 문구.
// 실행: node tools/round3-ui-check.js
const { launch, wait, reporter } = require('./_cdp');

(async () => {
  const h = await launch({ env: { RESUME_GRACE_MS: '4000', RESUME_GRACE_MOBILE_MS: '4000' } });
  const { check, done } = reporter();
  let code = 1;
  try {
    console.log('입장과 이모티콘');
    const A = await h.page(1100, 800);
    check(await A.js(`document.querySelectorAll('#emojis button img.emoji').length === EMOJIS.length`), `입장 화면의 이모티콘 ${44}개가 모두 그림(Twemoji)으로 그려짐`);
    check(await A.until(`[...document.querySelectorAll('#emojis button img.emoji')].every((i) => i.complete && i.naturalWidth > 0)`), '이모티콘 그림이 실제로 불러와짐 (네모로 안 보임)');
    check(await A.until(`avatarCache.key === profile.emoji + '|' + profile.color`), '내 아바타가 Twemoji 그림으로 만들어짐 (기기 글꼴이 아님)');
    await A.type('#nameIn', '에이'); await A.tap('#enter');
    check(await A.until('joined'), '입장함');
    const B = await h.page(390, 844, { mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
    await B.type('#nameIn', '비'); await B.tap('#enter');
    check(await B.until('joined'), '폰 창도 입장함');

    console.log('채팅 속 이모티콘');
    await A.type('#chatIn', '안녕 😀 한국 🇰🇷 가족 👨‍👩‍👧 하트 ❤️ 숫자 1️⃣ 그냥 1 © 끝'); await A.js(`document.querySelector('#chatForm').requestSubmit()`);
    check(await B.until(`document.querySelectorAll('#chat .bubble p img.emoji').length === 5`), '이모티콘 5개(웃는 얼굴·국기·가족·하트·숫자)가 그림으로 바뀜. 그냥 숫자와 ©는 글자 그대로');
    check(await B.until(`[...document.querySelectorAll('#chat .bubble p img.emoji')].every((i) => i.complete && i.naturalWidth > 0)`), '그림이 모두 불러와짐');
    check(await B.js(`document.querySelector('#chat .bubble p').textContent.includes('그냥 1 © 끝') && [...document.querySelectorAll('#chat .bubble p img.emoji')].map((i) => i.alt).join('') === '😀🇰🇷👨‍👩‍👧❤️1️⃣'`), '복사해도 원래 이모티콘이 나옴(그림의 대체 글자)');
    await A.shot?.('E:/tmpchk/r3-ui-emoji.png');

    console.log('프로필 바로 바뀜');
    check(await B.js(`users.find((u) => u.name === '에이').avatar.startsWith('data:image')`), '처음에는 에이의 아바타가 있음');
    const before = await B.js(`users.find((u) => u.name === '에이').avatar`);
    await A.js(`(() => { profile.mode = 'emoji'; profile.emoji = '🦊'; profile.color = '#6ee7a8'; return loadEmojiImg('🦊').then((im) => { const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 }), g = c.getContext('2d'); g.fillStyle = '#6ee7a8'; g.fillRect(0, 0, 128, 128); g.drawImage(im, 16, 20, 96, 96); send({ t: 'profile', avatar: c.toDataURL('image/jpeg', 0.88), color: '#6ee7a8' }); }); })()`);
    check(await B.until(`users.find((u) => u.name === '에이').avatar !== ${JSON.stringify(before)} && users.find((u) => u.name === '에이').color === '#6ee7a8'`), '다른 사람 화면의 참가자 정보가 새 사진·색으로 바뀜');
    check(await B.until(`(() => { const n = document.querySelector('#chat .m .av'); return n && n.style.backgroundImage.includes('data:image') && n.style.getPropertyValue('--c') === '#6ee7a8'; })()`), '이미 그려진 채팅 말풍선의 아바타도 바뀜');

    console.log('화면을 새로 열어도 채팅이 남음 (폰이 탭을 버렸다 다시 열 때)');
    await B.js(`document.querySelector('#tab-chat').click()`);
    const n0 = await B.js(`document.querySelectorAll('#chat .m').length`);
    await B.js(`location.reload()`); await wait(1500);
    await B.tap('#enter'); // 이름은 기기에 남아 있음
    check(await B.until('joined'), '새로 열린 화면이 다시 입장함');
    check(await B.until(`document.querySelectorAll('#chat .m').length === ${n0}`), `이전 채팅 ${n0}개가 다시 보임`);
    check(await B.js(`document.querySelector('#chat .bubble p').textContent.includes('안녕')`), '내용도 그대로');

    console.log('자리를 비운 사이 온 채팅 (연결이 끊겼다 돌아옴)');
    await B.js(`window.__attempt = attempt; attempt = () => {}; dropSocket('test-off')`);
    await wait(300);
    await A.type('#chatIn', '비가 없을 때 온 말'); await A.js(`document.querySelector('#chatForm').requestSubmit()`);
    await wait(700);
    await B.js(`attempt = window.__attempt; scheduleAttempt(0)`);
    check(await B.until(`joined && !reconnecting && ws.readyState === 1`, 8000), '다시 연결됨');
    check(await B.until(`[...document.querySelectorAll('#chat .bubble p')].some((p) => p.textContent === '비가 없을 때 온 말')`), '끊겨 있던 동안의 채팅이 도착함');
    check(await B.js(`document.body.textContent.includes('자리를 비운 동안 올라온 채팅 1개를 불러왔어요')`), '안내 문구가 뜸');
    check(await B.js(`[...document.querySelectorAll('#chat .bubble p')].filter((p) => p.textContent === '비가 없을 때 온 말').length === 1`), '같은 말이 두 번 보이지 않음');

    console.log('화면 공유 안내 문구');
    await B.js(`(() => { window.__sysLines = []; })()`);
    await B.js(`(() => { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true }); renderStage(); })()`); // 폰 브라우저처럼
    check(await B.js(`document.querySelector('#shareBtn').disabled && document.querySelector('#shareBtn').title.includes('화면을 공유할 수 없어요')`), '폰 브라우저처럼 getDisplayMedia 가 없으면 버튼이 막히고 이유가 보임');
    await A.js(`(() => { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true }); renderStage(); })()`);
    check(await A.js(`document.querySelector('#shareBtn').disabled`), '지원하지 않으면 버튼이 막힘');
    await A.js(`startShare()`);
    check(await A.js(`[...document.querySelectorAll('.sys')].some((x) => x.textContent.includes('지원하지 않아요')) && ![...document.querySelectorAll('.sys')].some((x) => x.textContent.includes('https 주소에서 접속했는지'))`), '안내가 정확해짐 (더 이상 "https로 접속했는지"를 묻지 않음)');
    await A.js(`(() => { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })), configurable: true }); renderStage(); })()`);
    const nSys = await A.js(`document.querySelectorAll('.sys').length`);
    await A.js(`startShare()`); await wait(300);
    check(await A.js(`document.querySelectorAll('.sys').length === ${nSys}`), '공유 창에서 취소하면 아무 문구도 띄우지 않음');
    code = 0;
  } finally { await h.close(); }
  process.exit(done() || code);
})().catch((e) => { console.error(e); process.exit(1); });
