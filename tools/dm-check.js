// 쪽지·알림 위장·소리 끄기·패닉을 실제 브라우저 두 창으로 확인한다.
//   쪽지: 보내기, 안 읽음 표시, 답장, 다시 접속해도 기록이 남는지
//   위장: 탭 제목·아이콘이 바뀌고 되돌아오는지, 미리보기
//   소리: 스피커 버튼이 영상·공유·음성을 모두 끄는지
//   패닉: 버튼 / Esc 두 번 → 소리·마이크 끄기 + 화면 보호기 + 뒤 화면 잠금, 아무 키·클릭으로 해제, 소리는 꺼진 채 유지
// 실행: node tools/dm-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 4900 + Math.floor(Math.random() * 90), CDP_PORT = 9100 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `dm-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    // 브라우저를 두 개 쓴다: 같은 localStorage(같은 cid)를 쓰면 같은 사람이 되기 때문에 창마다 따로 저장소를 가진 컨텍스트를 만든다
    async function page(name) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const open = async () => { await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1200); await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1000); };
      const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
      await open();
      return { ctx: browserContextId, js, call, key, open, shot: async (f) => fs.writeFileSync(f, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')) };
    }
    const until = async (p, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } return false; };
    const A = await page('에이'), B = await page('비이');

    console.log('쪽지');
    await A.js(`document.querySelector('#tab-users').click()`); await wait(300);
    const bid = await A.js(`users.find((u) => u.name === '비이').id`);
    await A.js(`document.querySelector('[data-uid="${bid}"]').click()`); await wait(300);
    check(await A.js(`[...document.querySelectorAll('.acts button')].some((b) => b.textContent === '쪽지 보내기')`), '참가자를 누르면 "쪽지 보내기"가 보임 (일반 참가자에게도)');
    await A.js(`[...document.querySelectorAll('.acts button')].find((b) => b.textContent === '쪽지 보내기').click()`); await wait(500);
    check(await A.js(`activeTab === 'dm' && !document.querySelector('#dmThread').hidden && document.querySelector('#dmWho').textContent.includes('비이')`), '쪽지 탭의 대화 화면이 열림 (상대 이름 표시)');
    await A.js(`(() => { document.querySelector('#dmIn').value = '안녕, 첫 쪽지야'; document.querySelector('#dmForm').requestSubmit(); })()`);
    check(await until(A, `document.querySelectorAll('#dmMsgs .bubble').length === 1`), '보낸 쪽지가 내 대화창에 보임');
    check(await until(B, `!document.querySelector('#dot-dm').hidden && document.querySelector('#dot-dm').textContent === '1'`), '받는 사람 쪽지 탭에 안 읽음 1이 뜸');
    await B.js(`document.querySelector('#tab-dm').click()`); await wait(400);
    check(await B.js(`document.querySelector('#dmList .conv small').textContent.includes('안녕, 첫 쪽지야') && !!document.querySelector('#dmList .dot')`), '쪽지 목록에 마지막 쪽지와 안 읽음 표시');
    await B.js(`document.querySelector('#dmList .conv').click()`); await wait(600);
    check(await B.js(`document.querySelectorAll('#dmMsgs .bubble').length === 1 && document.querySelector('#dot-dm').hidden`), '대화를 열면 내용이 보이고 안 읽음이 사라짐');
    await B.js(`(() => { document.querySelector('#dmIn').value = '답장이야'; document.querySelector('#dmForm').requestSubmit(); })()`);
    check(await until(A, `document.querySelectorAll('#dmMsgs .bubble').length === 2 && document.querySelector('#dot-dm').hidden`), '답장이 도착하고, 대화를 보고 있으니 안 읽음은 안 생김');
    await B.shot(path.join(os.tmpdir(), 'dm-thread.png'));
    await B.open(); // 새로 접속
    await B.js(`document.querySelector('#tab-dm').click()`); await wait(400);
    check(await B.js(`document.querySelectorAll('#dmList .conv').length === 1 && document.querySelector('#dmList .conv small').textContent.includes('답장이야')`), '다시 접속해도 쪽지 기록이 남아 있음');

    console.log('알림 위장');
    await A.js(`document.querySelector('#settingsBtn').click()`); await wait(300);
    check(await A.js(`document.querySelector('#spoofSel').options.length === 5`), '위장 선택지 5개 (끔/내용 숨기기/학습 도우미/문서 편집기/계산기)');
    await A.js(`(() => { const s = document.querySelector('#spoofSel'); s.value = 'docs'; s.dispatchEvent(new Event('change')); })()`); await wait(300);
    check(await A.js(`document.title === '제목 없는 문서' && document.querySelector('link[rel=icon]').getAttribute('href') === '/icons/spoof-docs.png'`), '탭 제목과 아이콘이 문서 편집기로 위장됨');
    check(await A.js(`document.querySelector('#spoofPrev').innerText.includes('문서 편집기') && !document.querySelector('#spoofPrev').innerText.includes('에이')`), '미리보기에 가짜 이름만 보임');
    await A.js(`(() => { const c = document.querySelector('#tabSpoof'); c.checked = false; c.dispatchEvent(new Event('change')); })()`); await wait(200);
    check(await A.js(`document.title === '방 채팅'`), '"탭도 바꾸기"를 끄면 탭 제목이 원래대로');
    await A.js(`(() => { const c = document.querySelector('#tabSpoof'); c.checked = true; c.dispatchEvent(new Event('change')); const s = document.querySelector('#spoofSel'); s.value = 'calc'; s.dispatchEvent(new Event('change')); })()`); await wait(200);
    check(await A.js(`document.title === '계산기'`), '위장을 바꾸면 탭 제목도 바로 바뀜');
    check(await A.js(`JSON.parse(localStorage.notifPrefs).spoof === 'calc'`), '설정이 이 기기에 저장됨');
    await A.js(`document.querySelector('#settings').close()`);

    console.log('모든 소리 끄기');
    await A.js(`document.querySelector('#voiceBtn').click()`); await wait(1200);
    await B.js(`document.querySelector('#voiceBtn').click()`); await wait(2500);
    check(await A.js(`vpcs.size === 1 && [...vpcs.values()].every((v) => v.gain && v.gain.gain.value === 1)`), '켜 둔 상태: 상대 목소리가 재생됨(음소거 아님)');
    await A.js(`document.querySelector('#soundBtn').click()`); await wait(300);
    check(await A.js(`soundOff && [...vpcs.values()].every((v) => v.gain.gain.value === 0) && document.querySelector('#screen').muted && document.querySelector('#soundBtn').getAttribute('aria-pressed') === 'true'`), '스피커 버튼: 음성·공유 화면 소리가 모두 꺼지고 버튼이 눌린 상태로 바뀜');
    check(await A.js(`!micMuted && mic.getAudioTracks()[0].enabled`), '내 마이크는 건드리지 않음');
    check(await A.js(`document.querySelector('#soundBtn').classList.contains('stop')`), '꺼진 상태는 빨강으로 표시');
    await A.js(`document.querySelector('#soundBtn').click()`); await wait(200);
    check(await A.js(`!soundOff && [...vpcs.values()].every((v) => v.gain.gain.value === 1)`), '다시 누르면 소리가 돌아옴');

    console.log('패닉');
    await A.js(`document.querySelector('#panicBtn').click()`); await wait(400);
    check(await A.js(`!document.querySelector('#saver').hidden && saverOn`), '패닉 버튼: 화면 보호기가 뜸');
    check(await A.js(`soundOff && micMuted && !mic.getAudioTracks()[0].enabled && [...vpcs.values()].every((v) => v.gain.gain.value === 0)`), '소리와 내 마이크가 모두 꺼짐');
    check(await A.js(`document.title === '계산기'`), '탭 제목은 위장 설정 그대로(계산기)');
    check(await A.js(`document.querySelector('#app').inert === true`), '뒤의 화면은 잠겨서 키보드로 조작할 수 없음');
    check(await A.js(`document.querySelector('#saverCanvas').width > 0 && document.querySelector('#saverClock').textContent.length > 0`), '별 화면과 시계가 그려짐');
    await A.js(`stopSaver()`); await wait(100);
    check(await A.js(`saverOn`), '켜자마자 0.5초는 해제되지 않음(누르던 손이 닫지 않게)');
    await wait(600); await A.key('a', 'KeyA', 65); await wait(300);
    check(await A.js(`!saverOn && document.querySelector('#saver').hidden && document.querySelector('#app').inert === false`), '아무 키나 누르면 해제되고 뒤 화면이 다시 조작 가능');
    check(await A.js(`soundOff && micMuted`), '해제해도 소리와 마이크는 꺼진 채로 남음');
    await A.js(`setSoundOff(false); setMicMuted(false); (() => { const s = document.querySelector('#spoofSel'); s.value = 'off'; s.dispatchEvent(new Event('change')); })()`); await wait(200);
    await A.js(`document.querySelector('#panicBtn').blur(); document.body.focus()`);
    await A.key('Escape', 'Escape', 27); await wait(150); await A.key('Escape', 'Escape', 27); await wait(300);
    check(await A.js(`saverOn`), 'Esc를 빠르게 두 번 누르면 패닉');
    check(await A.js(`document.title === '새 탭'`), '위장을 안 쓰면 탭 제목이 평범한 "새 탭"으로 바뀜');
    await wait(600); await A.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 }); await A.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 200, button: 'left', clickCount: 1 }); await wait(300);
    check(await A.js(`!saverOn && document.title === '방 채팅'`), '화면을 눌러도 해제되고 탭 제목이 원래대로');
    await A.js(`document.querySelector('#panicBtn').click()`); await wait(300);
    await A.js(`document.querySelector('#saver').dispatchEvent(new Event('pointerdown'))`); await wait(100);
    check(await A.js(`saverOn`), '(재확인) 켜자마자 눌러도 0.5초 동안은 유지');
    await wait(600); await A.key('Escape', 'Escape', 27); await wait(300);
    check(await A.js(`!saverOn`), 'Esc 한 번으로도 해제');

    console.log('푸시 알림 켜기');
    // 헤드리스 Chrome은 알림 권한을 허용할 수 없어서(grantPermissions가 성공해도 denied) 실제 구독은 여기서 검증하지 못한다.
    // 거부된 상태에서 안내 문구가 나오고 체크가 풀리는 경로만 확인한다. 실제 구독/전달은 실제 브라우저에서 따로 확인해야 한다.
    await A.js(`document.querySelector('#settingsBtn').click()`); await wait(300);
    if ((await A.js(`Notification.permission`)) === 'denied') {
      await A.js(`document.querySelector('#pushOn').click()`); await wait(1500);
      check(await A.js(`document.querySelector('#pushNote').textContent.includes('차단돼 있어요') && !document.querySelector('#pushOn').checked`), '알림이 차단된 브라우저: 켜는 방법을 안내하고 체크는 다시 풀림');
      console.log('  건너뜀: 실제 푸시 구독과 알림 표시(헤드리스 Chrome은 알림 권한을 허용할 수 없음) → 실제 브라우저에서 확인 필요');
    }
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
