// 입장 화면의 '쪽지함' 버튼와 설치 안내(iPhone/Android)를 실제 브라우저로 확인한다.
//  - 쪽지만 쓰는 사람은 방에 보이지 않고, 방 화면의 영상·채팅·참가자·대기열 없이 쪽지 패널만 쓴다
//  - '방에 들어가기'를 누르면 같은 닉네임으로 방에 들어간다
//  - 설정 창의 설치 안내: 쓰는 기기에 맞는 순서가 펼쳐지고, 폰 화면(390px)에서 넘치지 않는다
// 실행: node tools/dm-only-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
const { AUTH_ENV, signup, loginJs } = require('./_auth');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5900 + Math.floor(Math.random() * 90), CDP_PORT = 9900 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
};

(async () => {
  const state = path.join(os.tmpdir(), `dmonly-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...AUTH_ENV, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') console.log('  페이지 예외:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    async function page(w, h, mobile, ua) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      if (ua) await call('Emulation.setUserAgentOverride', { userAgent: ua });
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const p = { js, call };
      p.rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; })()`);
      p.tap = async (sel) => { // 실제로 그 자리를 누른다 (요소를 코드로 clic() 하지 않는다)
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
        const r = await p.rect(sel); if (!r) throw new Error('없음: ' + sel);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await wait(150);
      };
      p.login = async (name) => { await js(loginJs(await signup(PORT, name))); }; // 이 화면을 그 닉네임으로 로그인한 상태로 만든다
      p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
      p.shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      await call('Page.navigate', { url: `http://127.0.0.1:${PORT}` }); await wait(1200);
      return p;
    }
    const noOverflow = `document.documentElement.scrollWidth <= innerWidth`;

    console.log('입장 화면: "입장하기"와 "쪽지함" 버튼 (폰 390px)');
    const P = await page(390, 844, true);
    check(await P.js(`!!document.querySelector('#inboxBtn') && !!document.querySelector('#enter') && !document.querySelector('input[name=joinMode]')`), '입장 화면에 "입장하기"와 "쪽지함" 버튼이 따로 있음');
    check(await P.js(`document.querySelector('#inboxBtn').textContent.trim() === '쪽지함' && document.querySelector('#enter').textContent === '입장하기'`), '버튼 글자가 "쪽지함" / "입장하기"');
    check(await P.js(noOverflow), '폰 화면에서 가로로 넘치지 않음');
    check(await P.js(`['#inboxBtn', '#enter'].every((s) => { const b = document.querySelector(s).getBoundingClientRect(); return b.height >= 44 && b.left >= 0 && b.right <= innerWidth; })`), '두 버튼 모두 터치 크기(44px) 이상이고 화면 안에 있음');
    check(await P.js(`document.querySelector('#enter').getBoundingClientRect().bottom <= document.querySelector('#inboxBtn').getBoundingClientRect().top`), '폰에서는 "입장하기"가 위, "쪽지함"이 아래로 쌓임');
    await P.tap('#inboxBtn');
    check(await P.js(`document.querySelector('#authDlg').open && !joined && document.querySelector('#authNote').textContent.includes('쪽지함은 로그인')`), '로그인하지 않고 "쪽지함"을 누르면 로그인 창이 열리고 이유를 알려 줌');
    await P.js(`document.querySelector('#authClose').click()`); await wait(200);
    await P.login('쪽지러');
    check(await P.js(`document.querySelector('#nameIn').readOnly && document.querySelector('#nameIn').value === '쪽지러' && document.querySelector('#acctBox').textContent.includes('로그인했어요')`), '로그인하면 닉네임이 내 계정 이름으로 고정되고 로그인 상태가 보임');
    await P.js(`document.querySelector('#inboxBtn').scrollIntoView({ block: 'center' })`); await P.shot('1-join-phone');
    await P.tap('#inboxBtn'); await wait(1500);

    console.log('쪽지함 화면');
    check(await P.js(`joined && dmOnly && document.body.classList.contains('dm-only') && !document.querySelector('#app').hidden`), '"쪽지함"을 누르면 쪽지함 화면이 열림');
    check(await P.js(`['#stage', '.stabs', '.top-media', '#resizer'].every((s) => getComputedStyle(document.querySelector(s)).display === 'none')`), '영상·탭 줄·음성/공유 버튼·크기 손잡이가 숨겨짐');
    check(await P.js(`!document.querySelector('#p-dm').hidden && document.querySelector('#p-chat').hidden`), '쪽지 패널만 보임');
    check(await P.js(`document.querySelector('.logo .t').textContent === '쪽지함' && !document.querySelector('#toRoom').hidden`), '제목이 "쪽지함"이고 "방에 들어가기" 버튼이 보임');
    check(await P.js(noOverflow), '폰 화면에서 가로로 넘치지 않음');
    check(await P.js(`(() => { const a = document.querySelector('.logo').getBoundingClientRect(), b = document.querySelector('.top-util').getBoundingClientRect(); return a.right <= b.left && b.right <= innerWidth; })()`), '머리줄에서 제목과 버튼이 겹치거나 잘리지 않음');
    check(await P.js(`(() => { const t = document.querySelector('#toRoom').getBoundingClientRect(), n = document.querySelector('#dmNew').getBoundingClientRect(); return t.height >= 44 && t.left >= 0 && t.right <= n.left && n.right <= innerWidth && t.height < 60; })()`), '"방에 들어가기" 버튼이 한 줄로 보이고 "새 쪽지"와 겹치지 않으며 터치 크기 이상');
    check(await P.js(`[...document.querySelectorAll('.top-util .btn')].every((b) => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44)`), '머리줄 버튼이 터치 크기 이상');
    check(await P.js(`(() => { const d = document.querySelector('#dmEmpty'); return !d.hidden && d.textContent.includes('새 쪽지') && !d.textContent.includes('참가자 탭'); })()`), '빈 목록 안내가 "새 쪽지"를 알려 줌 (참가자 탭 없음)');
    await P.shot('2-dmonly-phone');

    console.log('방 사람 쪽 (PC 1280px)');
    const R = await page(1280, 860, false); await R.login('방사람'); await R.tap('#enter'); await wait(1500);
    check(await R.js(`joined && !dmOnly && isHost`), '쪽지만 쓰는 사람이 먼저 와 있어도, 방에 처음 들어온 사람이 호스트가 됨');
    check(await R.js(`!users.some((u) => u.name === '쪽지러') && !document.body.textContent.includes('쪽지러 님이 들어왔어요')`), '방 사람에게 쪽지만 쓰는 사람은 보이지 않음');

    console.log('쪽지 주고받기');
    await P.tap('#dmNew'); await P.until(`document.querySelectorAll('#pkList .conv').length > 0`);
    check(await P.js(`[...document.querySelectorAll('#pkList .conv b')].some((b) => b.textContent === '방사람') && document.querySelector('#pkList').textContent.includes('접속 중')`), '새 쪽지 상대 목록에 방 사람이 "접속 중"으로 보임');
    await P.shot('3-picker-phone');
    await P.tap('#pkList .conv'); await wait(400);
    check(await P.js(`!document.querySelector('#dmThread').hidden && document.querySelector('#dmWho').textContent.includes('접속 중')`), '대화창 머리에 상대의 접속 상태가 보임 (방 참가자 목록 없이도)');
    await P.type('#dmIn', '방에 안 들어가고 보내요'); await P.tap('#dmForm button[type=submit]');
    check(await R.until(`document.querySelector('#dot-dm') && !document.querySelector('#dot-dm').hidden`), '방 사람 화면의 쪽지 탭에 안 읽은 표시가 뜸');
    await R.tap('#tab-dm'); await R.tap('#dmList .conv'); await wait(500);
    check(await R.js(`document.querySelector('#dmMsgs').textContent.includes('방에 안 들어가고 보내요')`), '방 사람이 쪽지 내용을 읽음');
    await R.type('#dmIn', '방에서 답장해요'); await R.tap('#dmForm button[type=submit]'); await wait(700);
    check(await P.js(`document.querySelector('#dmMsgs').textContent.includes('방에서 답장해요')`), '답장이 쪽지만 쓰는 화면에 도착함');
    check(await P.js(noOverflow), '대화창에서도 폰 화면 가로 넘침 없음');
    await P.shot('4-thread-phone');

    console.log('쪽지만 → 방으로 들어가기');
    await P.tap('#dmBack'); check(await P.js(`!document.querySelector('#toRoom').hidden && document.querySelector('#toRoom').getBoundingClientRect().width > 0`), '대화창에서 뒤로 가면 목록 화면에 "방에 들어가기" 버튼이 보임');
    await P.tap('#toRoom'); await P.until(`typeof joined !== 'undefined' && joined && document.querySelector('#toRoom').hidden`, 10000); await wait(800);
    check(await P.js(`joined && !dmOnly && !document.body.classList.contains('dm-only') && getComputedStyle(document.querySelector('#stage')).display !== 'none'`), '"방에 들어가기"를 누르면 같은 닉네임으로 방 화면이 열림 (다시 입력할 필요 없음)');
    check(await P.js(`users.some((u) => u.name === '방사람') && document.querySelector('.logo .t').textContent === '시루 그룹챗'`), '방 참가자와 제목이 방 화면대로 돌아옴');
    check(await R.until(`document.body.textContent.includes('쪽지러 님이 들어왔어요')`), '그때서야 방 사람에게 입장 알림이 감');
    await P.shot('5-in-room-phone');

    console.log('쪽지함 화면 (PC 1280px)');
    const D = await page(1280, 860, false); await D.login('쪽지데스크'); await D.js("document.querySelector('#enter').scrollIntoView({ block: 'end' })"); await D.shot('0-join-desktop'); await D.tap('#inboxBtn'); await wait(1500);
    check(await D.js(`dmOnly && (() => { const s = document.querySelector('.side').getBoundingClientRect(); return s.width <= 761 && Math.abs((s.left + s.right) / 2 - innerWidth / 2) < 2; })()`), 'PC에서는 쪽지 패널이 가운데에 좁게 놓임');
    await D.shot('6-dmonly-desktop');

    console.log('앱 설치 안내');
    for (const [name, ua, open, closed] of [['iPhone', UA.iphone, 'gIos', ['gAnd', 'gSam']], ['Android Chrome', UA.android, 'gAnd', ['gIos', 'gSam']], ['삼성 인터넷', UA.samsung, 'gSam', ['gIos', 'gAnd']]]) {
      const G = await page(390, 844, true, ua);
      await G.tap('#joinSettings'); await wait(400);
      check(await G.js(`document.querySelector('#settings').open && document.querySelector('#${open}').open && ${JSON.stringify(closed)}.every((i) => !document.querySelector('#' + i).open)`), `${name}: 설정 창을 열면 내 기기의 설치 순서만 펼쳐져 있음`);
      await G.js(`document.querySelector('#${open}').scrollIntoView({ block: 'start' })`); await wait(200);
      check(await G.js(`(() => { const d = document.querySelector('#settings').getBoundingClientRect(); return [...document.querySelectorAll('#installGuide details, #installGuide li')].every((e) => { const b = e.getBoundingClientRect(); return b.right <= d.right + 1 && b.left >= d.left - 1; }) && document.querySelector('.dlg-b').scrollWidth <= document.querySelector('.dlg-b').clientWidth; })()`), `${name}: 안내 글이 설정 창 밖으로 넘치지 않음`);
      if (name === 'iPhone') {
        check(await G.js(`document.querySelector('#installNote').textContent.includes('공유') || document.querySelector('#installNote').textContent.includes('홈 화면')`), 'iPhone: 설치 요약에 홈 화면에 추가하는 방법이 나옴');
        await G.shot('7-guide-iphone');
        await G.tap('#gAnd > summary');
        check(await G.js(`document.querySelector('#gAnd').open`), '다른 기기의 순서도 눌러서 펼칠 수 있음 (실제로 토글됨)');
        await G.tap('#gAnd > summary');
        check(await G.js(`!document.querySelector('#gAnd').open`), '다시 누르면 접힘');
      } else await G.shot('7-guide-' + (name.startsWith('삼성') ? 'samsung' : 'android'));
    }
    const PC = await page(1280, 860, false);
    await PC.tap('#joinSettings'); await wait(300);
    check(await PC.js(`['gIos', 'gAnd', 'gSam'].every((i) => !document.querySelector('#' + i).open)`), 'PC: 어느 순서도 미리 펼쳐지지 않음 (눌러서 볼 수 있음)');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
