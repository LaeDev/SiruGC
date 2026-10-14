// 눈으로 확인하려고 화면 사진을 저장한다 (판정 없음): 폰의 영상 소리 겹침, 음성 칩 소리 창, 설정 프로필·숨기기(로고 위장)·약관 페이지
// 실행: node tools/round3-shots.js [저장 폴더]   (기본: 임시 폴더). GPU 렌더링이 아니라 소프트웨어 렌더링 사진이다.
const path = require('path');
const fs = require('fs');
const { launch, wait } = require('./_cdp');
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'round3-shots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const h = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const A = await h.page(1100, 800); await A.type('#nameIn', '호스트'); await A.tap('#enter'); await A.until('joined');
    const P = await h.page(390, 844, { mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
    await P.type('#nameIn', '폰사용자'); await P.tap('#enter'); await P.until('joined');
    // 1) 폰: 영상이 있을 때 소리 조절이 영상 왼쪽 위에 겹친다
    await A.js(`send({ t: 'queue-add', videoId: 'dQw4w9WgXcQ' })`); await wait(1500);
    await P.shot(path.join(OUT, '1-phone-yt-volume.png'));
    // 2) 음성 칩을 눌러 소리 크기 창
    await A.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`); await wait(600);
    await P.js(`(voicePrefs.ns = false, document.querySelector('#voiceBtn').click())`); await wait(1500);
    await P.tap('#voiceBar .vp:not(:first-child)'); await wait(300);
    await P.shot(path.join(OUT, '2-phone-voice-popover.png'));
    await A.tap('#voiceBar .vp:not(:first-child)'); await wait(300);
    await A.shot(path.join(OUT, '2b-desktop-voice-popover.png'));
    await A.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    // 3) 설정: 프로필(폰·PC), 숨기기의 로고 위장, 약관·정보
    await P.tap('#settingsBtn'); await P.js(`setPage('profile')`); await wait(400);
    await P.shot(path.join(OUT, '3-phone-settings-profile.png'));
    await A.tap('#settingsBtn'); await A.js(`setPage('profile')`); await wait(400);
    await A.shot(path.join(OUT, '3b-desktop-settings-profile.png'));
    await A.js(`setPage('hide'); document.querySelector('#logoSel').value = 'calc'; document.querySelector('#logoSel').dispatchEvent(new Event('change')); document.querySelector('#logoTitleRow').scrollIntoView()`); await wait(400);
    await A.shot(path.join(OUT, '4-desktop-settings-logo.png'));
    await A.js(`panic()`); await wait(500);
    await A.shot(path.join(OUT, '5-desktop-panic-logo.png'));
    await A.js(`unlockSaver()`); await wait(300);
    await A.js(`setPage('app'); document.querySelector('#leaveRow').scrollIntoView()`); await wait(300);
    await A.shot(path.join(OUT, '6-desktop-settings-app.png'));
    console.log('저장:', OUT);
  } finally { await h.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
