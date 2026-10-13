// 화면 다듬기(버튼 hover 글씨, 끊김 띠 위치, 폰 가로 탭, Esc와 패닉, 이모티콘 방향키, 쪽지 더 보기 메뉴와 차단 표시)를 실제 브라우저로 확인한다.
// 실행: node tools/polish-check.js   (SHOTS=폴더 로 화면 사진 저장)
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
      await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?step=profile` }); await wait(1200);
      return p;
    }
    const noOverflow = `document.documentElement.scrollWidth <= innerWidth`;

    console.log('입장 화면 (PC)');
    const D = await page(1280, 860, false);
    check(await D.js("getComputedStyle(document.body).wordBreak === 'keep-all'"), '한국어는 단어 중간에서 줄바꿈하지 않음 (word-break: keep-all)');
    check(await D.js("document.querySelector('.skip').getAttribute('href') === '#nameIn'"), '입장 화면의 건너뛰기 링크는 닉네임 입력칸으로 감');
    const pos = await D.rect('#enter');
    await D.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y }); await wait(400);
    check(await D.js("(() => { const probe = (v) => { const i = document.createElement('i'); i.style.background = v; document.body.append(i); const c = getComputedStyle(i).backgroundColor; i.remove(); return c; }; const e = document.querySelector('#enter'); return e.matches(':hover') && getComputedStyle(e).backgroundColor === probe('var(--accent)'); })()"), '"입장하기"에 마우스를 올려도 바탕색이 그대로이고 글씨가 읽힘');
    await D.shot('1-hover-enter-desktop');
    await D.js("document.querySelector('#makeWrap').open = true");
    await D.js("document.querySelector('#emojis button[aria-pressed=true]').focus()");
    check(await D.js("document.querySelectorAll('#emojis button[tabindex=\"0\"]').length === 1"), '이모티콘 칸은 고른 것 하나만 Tab 순서에 들어감 (44번 누르지 않아도 됨)');
    const before = await D.js('profile.emoji');
    for (const type of ['rawKeyDown', 'keyUp']) await D.call('Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await wait(200);
    check(await D.js(`profile.emoji !== ${JSON.stringify(before)} && document.activeElement.dataset.e === profile.emoji`), '방향키(→)로 다음 이모티콘으로 옮기고 고름');

    console.log('폰: 방 화면과 끊김 띠');
    const P = await page(390, 844, true); await P.login('폰사용자'); await P.tap('#enter'); await wait(1800);
    check(await P.js("document.querySelector('.skip').getAttribute('href') === '#chatIn' && !!document.querySelector('.logo .t[role=heading][aria-level=\"1\"]')"), '방 화면: 건너뛰기 링크는 채팅 입력, 제목은 h1 역할을 가짐');
    await P.js("showNet('연결이 끊겼어요. 다시 연결하는 중…')"); await wait(200);
    check(await P.js("document.querySelector('#net').getBoundingClientRect().top >= document.querySelector('.top').getBoundingClientRect().bottom"), '끊김 띠가 헤더(로고·설정 버튼)를 덮지 않고 그 아래에 뜸');
    await P.shot('2-net-banner-phone'); await P.js("hideNet()");
    check(await P.js("(() => { const r = document.querySelector('#resizer').getBoundingClientRect(), t = document.querySelector('.stabs').getBoundingClientRect(); return r.bottom <= t.top + 1; })()"), '크기 조절 손잡이가 탭 줄 위에 겹치지 않고 자기 줄을 가짐');
    await P.call('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true }); await wait(400);
    check(await P.js("[...document.querySelectorAll('.stabs button')].every((b) => b.getBoundingClientRect().height <= 52)"), '폰 가로에서도 "참가자" 같은 탭 이름이 두 줄로 갈라지지 않음');
    await P.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await wait(300);

    console.log('Esc로 창을 닫을 때 패닉으로 세지 않음');
    await P.tap('#settingsBtn'); await wait(300);
    const esc = async () => { for (const type of ['rawKeyDown', 'keyUp']) await P.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
    await esc(); await wait(150); await esc(); await wait(500);
    check(await P.js("!document.querySelector('#settings').open && !saverOn"), '설정 창을 Esc로 닫은 뒤 바로 Esc를 눌러도 화면 보호기가 켜지지 않음');
    await esc(); await wait(150); await esc(); await wait(500);
    check(await P.js("saverOn"), '창이 없을 때의 Esc 두 번은 예전처럼 패닉이 됨');
    await P.js("unlockSaver()"); await wait(700);

    console.log('쪽지 화면: 더 보기 메뉴와 차단');
    const Q = await page(390, 844, true); await Q.login('쪽지상대'); await Q.tap('#enter'); await wait(1800);
    const puid = await P.js('meUid'), quid = await Q.js('meUid');
    await Q.js(`dmSend(${JSON.stringify(puid)}, '메뉴 확인용 쪽지')`); await wait(700);
    await P.tap('#tab-dm'); await P.tap('#dmList .conv'); await wait(500);
    check(await P.js("!document.querySelector('#dmThread').hidden && ['#dmBack', '#dmMore'].every((s) => { const b = document.querySelector(s).getBoundingClientRect(); return b.width >= 44 && b.height >= 44; })"), '대화창 머리에는 뒤로 가기와 "더 보기" 버튼만 있음 (터치 크기 이상)');
    check(await P.js("document.querySelector('#dmMenu').hidden"), '정리·차단은 처음에는 보이지 않음');
    await P.tap('#dmMore'); await wait(200);
    check(await P.js("!document.querySelector('#dmMenu').hidden && document.querySelector('#dmMore').getAttribute('aria-expanded') === 'true' && ['#dmBlock', '#dmClear'].every((s) => document.querySelector(s).getBoundingClientRect().height >= 44)"), '"더 보기"를 누르면 차단·대화 정리 메뉴가 열림 (각각 터치 크기 이상)');
    check(await P.js("(() => { const m = document.querySelector('#dmMenu').getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth; })()"), '메뉴가 폰 화면 안에 들어옴');
    await P.shot('3-dm-menu-phone');
    await P.js('window.confirm = () => true'); await P.tap('#dmBlock'); await wait(500);
    check(await P.js("document.querySelector('#dmMenu').hidden && document.querySelector('#dmIn').disabled && document.querySelector('#dmForm button[type=submit]').disabled"), '차단하면 메뉴가 닫히고 입력창과 보내기 버튼이 모두 막힘');
    check(await P.js("getComputedStyle(document.querySelector('#dmIn')).opacity < 1"), '막힌 입력창이 눈에 띄게 흐려 보임');
    await P.shot('4-dm-blocked-phone');
    await P.tap('#dmMore'); await P.tap('#dmBlock'); await wait(400);
    check(await P.js("!document.querySelector('#dmIn').disabled"), '다시 "차단 해제"하면 입력창이 열림');
    await P.js("document.querySelector('#dmMore').click()"); await wait(100);
    await P.js("document.body.click()"); await wait(100);
    check(await P.js("document.querySelector('#dmMenu').hidden"), '메뉴 바깥을 누르면 닫힘');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
