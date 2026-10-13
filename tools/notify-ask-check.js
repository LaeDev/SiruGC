// 쪽지 알림 권한을 미리 받아 두는 안내 카드를 실제 브라우저로 확인한다.
//  - 로그인한 사람이 들어와 안내(온보딩)가 끝난 뒤 한 번 "쪽지 알림을 받을까요?" 카드가 뜬다. 게스트·직접 열기에서는 안 뜬다
//  - "알림 켜기"를 누르면 그 클릭 안에서(사용자 동작 직후) 브라우저의 알림 허용 창(Notification.requestPermission)을 부른다
//  - "나중에"는 3일 뒤에 다시, 브라우저에서 차단했거나 이미 켠 사람에게는 다시 묻지 않는다
// 헤드리스 Chrome 은 진짜 허용 창을 띄울 수 없어서 Notification 을 가짜로 바꿔 호출 여부와 시점만 본다.
// 실행: node tools/notify-ask-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
const { AUTH_ENV, signup, loginJs } = require('./_auth');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6800 + Math.floor(Math.random() * 90), CDP_PORT = 10000 + Math.floor(Math.random() * 90);
const SHOTS = process.env.SHOTS || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));
// 가짜 Notification: 허용 창을 부른 횟수와 "그때 사용자 동작이 살아 있었는지"를 기록하고, window.__answer 로 답한다
const STUB = `(() => {
  window.__ask = { calls: 0, active: [] }; window.__perm = 'default'; window.__answer = 'denied';
  Object.defineProperty(Notification, 'permission', { get: () => window.__perm, configurable: true });
  Notification.requestPermission = () => { window.__ask.calls++; window.__ask.active.push(navigator.userActivation.isActive); window.__perm = window.__answer; return Promise.resolve(window.__answer); };
})()`;

(async () => {
  const state = path.join(os.tmpdir(), `nask-${Date.now()}.json`);
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
    async function page(query = '', w = 1280, h = 860, mobile = false) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const p = { js, call };
      p.tap = async (sel) => {
        await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
        const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; })()`);
        if (!r || !r.w) throw new Error('보이지 않음: ' + sel);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await wait(250);
      };
      p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
      p.shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      p.open = async () => { await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/${query}` }); await wait(1500); await js(STUB); }; // (페이지가 다 뜬 뒤에 가짜로 바꾼다: 문서가 만들어질 때 심으면 헤드리스 Chrome 이 진짜 값으로 되돌려 놓는다)
      p.shown = () => js(`!!document.querySelector('#notifAsk') && !document.querySelector('#notifAsk').hidden`);
      p.member = async (name) => { await p.open(); await js(loginJs(await signup(PORT, name))); await wait(500); await p.tap('#gRoom'); await p.tap('#enter'); await p.until('joined'); };
      return p;
    }
    const sk = (p) => p.js(`localStorage.setItem('tour:room', '1'); localStorage.setItem('tour:dm', '1')`); // 온보딩은 건너뛴 기기

    console.log('온보딩이 끝난 뒤에 뜸');
    const A = await page(); await A.open(); await sk(A);
    await A.js(loginJs(await signup(PORT, '알림회원'))); await wait(400); await A.tap('#gRoom'); await A.tap('#enter'); await A.until('joined');
    const okAsk = await A.until(`!!document.querySelector('#notifAsk') && !document.querySelector('#notifAsk').hidden`, 8000);
    if (!okAsk) console.log('  (진단)', await A.js(`JSON.stringify({ joined, meUid, perm: Notification.permission, push: pushSupported(), pushOn: get('pushOn'), snooze: get('notifAsk'), direct: tourDirect(), tourOn: !!tourOn, needed: notifAskNeeded(), stub: typeof window.__ask })`));
    check(okAsk, '로그인한 사람이 들어오면 "쪽지 알림을 받을까요?" 카드가 뜸');
    check(await A.js(`document.querySelector('#naTitle').textContent.includes('알림') && !!document.querySelector('#naOn') && !!document.querySelector('#naLater')`), '"알림 켜기"와 "나중에" 버튼이 있음');
    check(await A.js(`window.__ask.calls === 0`), '카드가 뜬 것만으로는 브라우저의 허용 창을 띄우지 않음 (사용자가 누르기 전에는 안 부름)');
    await A.shot('1-ask');

    console.log('"알림 켜기": 클릭 안에서 허용 창');
    await A.tap('#naOn');
    check(await A.js(`window.__ask.calls === 1 && window.__ask.active[0] === true`), '누른 직후(사용자 동작이 살아 있는 상태)에 브라우저 허용 창을 부름 (1번)');
    check(await A.js(`Notification.permission === 'denied' && document.querySelector('#naMsg').textContent.includes('차단')`), '차단하면 이유와 푸는 방법을 알려 줌');
    check(await A.js(`document.querySelector('#naOn').textContent === '다시 해 보기'`), '버튼이 "다시 해 보기"로 바뀜');

    console.log('차단한 사람에게는 다시 안 묻고, "나중에"는 3일 뒤');
    const B = await page(); await B.open(); await sk(B);
    await B.js(`window.__answer = 'default'`);
    await B.js(loginJs(await signup(PORT, '알림나중'))); await wait(400); await B.tap('#gRoom'); await B.tap('#enter'); await B.until('joined');
    check(await B.until(`!!document.querySelector('#notifAsk') && !document.querySelector('#notifAsk').hidden`, 8000), '(새 사람) 카드가 뜸');
    await B.tap('#naLater');
    check(await B.js(`document.querySelector('#notifAsk').hidden && Number(get('notifAsk')) > Date.now() + 2.9 * 86400e3 && window.__ask.calls === 0`), '"나중에"는 카드를 닫고 3일 뒤로 미루며 허용 창은 안 부름');
    await B.js(`location.reload()`); await wait(1800); await B.js(STUB);
    await B.tap('#gRoom'); await B.until('joined'); /* 프로필은 이미 정해서 바로 들어간다 */ await wait(4500);
    check(!(await B.shown()), '다시 들어와도 3일 안에는 안 뜸');
    await B.js(`set('notifAsk', String(Date.now() - 1000))`);
    await B.js(`notifAskSoon()`); await wait(3500);
    check(await B.shown(), '미룬 시간이 지나면 다시 뜸');

    console.log('뜨면 안 되는 경우');
    const G = await page(); await G.open(); await sk(G); await G.tap('#gGuest'); await G.type('#nameIn', '알림손님'); await G.tap('#enter'); await G.until('joined'); await wait(4500);
    check(!(await G.shown()), '게스트에게는 안 뜸 (쪽지·알림은 로그인한 사람만)');
    const X = await page('?step=profile'); await X.open(); await X.js(loginJs(await signup(PORT, '알림직접'))); await wait(400);
    await X.js(`document.querySelector('#joinForm').requestSubmit()`); await X.until('joined'); await wait(4500);
    check(!(await X.shown()), '직접 열기(?step=profile, 자동 점검용)에서는 안 뜸');
    const T = await page(); await T.open();
    await T.js(`window.__perm = 'granted'`); await T.js(loginJs(await signup(PORT, '알림이미'))); await wait(400); await T.tap('#gRoom'); await T.tap('#enter'); await T.until('joined'); await wait(4500);
    check(!(await T.shown()), '이미 허용한 기기에서는 안 뜸');
    const R = await page(); await R.open(); await R.js(`window.__perm = 'denied'`); await R.js(loginJs(await signup(PORT, '알림차단'))); await wait(400); await R.tap('#gRoom'); await R.tap('#enter'); await R.until('joined'); await wait(4500);
    check(!(await R.shown()), '브라우저에서 이미 차단한 기기에서는 안 뜸 (설정 → 알림에서 안내)');

    console.log('폰 (390px)');
    const P = await page('', 390, 844, true); await P.open(); await sk(P);
    await P.js(loginJs(await signup(PORT, '알림폰'))); await wait(400); await P.tap('#gRoom'); await P.tap('#enter'); await P.until('joined');
    check(await P.until(`!!document.querySelector('#notifAsk') && !document.querySelector('#notifAsk').hidden`, 8000), '폰에서도 카드가 뜸');
    check(await P.js(`(() => { const c = document.querySelector('#notifAsk').getBoundingClientRect(); return c.left >= 0 && c.right <= innerWidth && c.bottom <= innerHeight && [...document.querySelectorAll('#notifAsk button')].every((b) => b.getBoundingClientRect().height >= 36); })()`), '카드가 화면 안에 들어오고 버튼이 눌리는 크기');
    await P.shot('2-ask-phone');
    browser.close();
  } catch (e) { console.log('  실패 예외:', e.stack || e); failed++; }
  finally {
    srv.kill(); try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} await wait(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); fs.rmSync(state, { force: true }); } catch {}
  }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
