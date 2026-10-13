// 패닉 화면(강의 영상, 강의 플레이어 컨트롤, 10초 누르기, PIN/비밀번호 해제, 새로고침 유지, 폰 가로 회전)을 실제 브라우저로 확인한다.
// 유튜브는 가짜 플레이어로 바꿔서 결과가 늘 같다. 10초 누르기를 여러 번 하므로 1~2분 걸린다.
// 실행: node tools/panic-check.js   (SHOTS=폴더 로 화면 사진 저장)
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

const YT_STUB = "window.YT = { Player: class {\n  constructor(id, opts) {\n    this.opts = opts; this.vars = opts.playerVars; this.t = this.vars.start || 0; this.state = -1; this.muted = !!this.vars.mute; this.vol = 100; this.q = '';\n    if (!window.__lec) window.__lec = this;\n    setTimeout(() => { opts.events.onReady({}); this.state = 1; opts.events.onStateChange({ data: 1 }); }, 100);\n  }\n  playVideo() { this.state = 1; } pauseVideo() { this.state = 2; } mute() { this.muted = true; } unMute() { this.muted = false; } isMuted() { return this.muted; }\n  setVolume(v) { this.vol = v; } getVolume() { return this.vol; } getCurrentTime() { return this.t; } getDuration() { return 2700; }\n  seekTo(s) { this.t = s; } getPlayerState() { return this.state; } getVideoData() { return { title: '다항식의 연산 (1)' }; } setPlaybackQuality(q) { this.q = q; }\n} };\n";
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
      await call('Page.addScriptToEvaluateOnNewDocument', { source: YT_STUB }); // 진짜 유튜브 대신 가짜 플레이어 (결과가 늘 같도록)
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

    const press = async (p, ms, x, y, onMid) => { // 막을 한 번 누른 채로 ms 동안 버틴다
      const r = await p.rect('#lecShield'); x ??= r.x; y ??= r.y;
      await p.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      if (onMid) { await wait(onMid.at); await onMid.fn(); await wait(ms - onMid.at); } else await wait(ms);
      await p.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    const key = async (p, k, code, vk) => { for (const type of ['rawKeyDown', 'keyUp']) await p.call('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };

    console.log('방에 들어오면 강의를 소리 없이 미리 재생');
    const G = await page(1280, 860, false); await G.type('#nameIn', '패닉손님'); await G.tap('#enter'); await wait(2200);
    check(await G.js("!!window.__lec && __lec.vars.mute === 1 && __lec.vars.controls === 0 && __lec.vars.start === 0 && __lec.vars.end === 1800 && __lec.vars.autoplay === 1"), '입장하면 기본 강의(앞 30분)가 소리 없이 컨트롤 없이 재생을 시작함');
    check(await G.js("__lec.muted && __lec.state === 1 && __lec.q === 'small' && getComputedStyle(document.querySelector('#lecture')).opacity === '0' && document.querySelector('#saver').hidden"), '미리 재생은 낮은 화질로 보이지 않게 돌아가고, 아직 화면 보호기는 안 뜸');

    console.log('패닉: 강의 화면과 강의 플레이어 컨트롤');
    await G.tap('#panicBtn'); await wait(700);
    check(await G.js("saverOn && !document.querySelector('#saver').hidden && document.querySelector('#saver').classList.contains('lec') && document.querySelector('#lecture').classList.contains('on') && soundOff && document.querySelector('#app').inert"), '패닉을 누르면 채팅 위로 강의가 뜨고 소리가 꺼지고 뒤 화면이 잠김');
    check(await G.js("getComputedStyle(document.querySelector('#saverCanvas')).display === 'none' && document.querySelector('#lecTitle').textContent.includes('다항식')"), '별 화면 대신 강의가 보이고 제목이 나옴');
    const m = await G.rect('#lecShield');
    await G.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x + 30, y: m.y + 30 }); await wait(400);
    check(await G.js("document.querySelector('#saver').classList.contains('ui') && getComputedStyle(document.querySelector('#lecBar')).opacity === '1'"), '마우스를 움직이면 강의 플레이어 컨트롤이 나옴');
    check(await G.js("getComputedStyle(document.querySelector('#lecShield')).pointerEvents !== 'none' && document.elementFromPoint(640, 300) === document.querySelector('#lecShield')"), '영상 위는 투명한 막이 덮고 있어서 유튜브 자신의 컨트롤이 나올 수 없음');
    await G.shot('1-lecture-desktop');
    await G.tap('#lecPlay'); await wait(300);
    check(await G.js("__lec.state === 2 && document.querySelector('#lecPlay').getAttribute('aria-label') === '재생'"), '정지 버튼: 영상이 멈추고 버튼이 "재생"으로 바뀜');
    await G.tap('#lecPlay'); await wait(300);
    check(await G.js("__lec.state === 1"), '재생 버튼: 다시 재생됨');
    await G.js("(() => { const v = document.querySelector('#lecVol'); v.value = 40; v.dispatchEvent(new Event('input')); })()"); await wait(200);
    check(await G.js("__lec.vol === 40 && !__lec.muted"), '볼륨을 올리면 소리가 켜지고 크기가 그대로 전달됨');
    await G.tap('#lecMute'); await wait(200);
    check(await G.js("__lec.muted"), '소리 버튼으로 다시 끔');
    await press(G, 120); await wait(300);
    check(await G.js("__lec.state === 2"), '화면을 톡 누르면 재생/정지가 바뀜');
    await press(G, 120); await wait(300);

    console.log('잠금: 키·Esc로는 안 풀리고, 10초 누르기가 필요');
    await key(G, 'a', 'KeyA', 65); await key(G, 'Escape', 'Escape', 27); await key(G, 'Enter', 'Enter', 13); await wait(300);
    check(await G.js("saverOn && document.querySelector('#lecAuth').hidden"), '아무 키나 Esc를 눌러도 풀리지 않고 해제 화면도 안 뜸');
    let hintSeen = null;
    await press(G, 8800, undefined, undefined, { at: 7700, fn: async () => { hintSeen = await G.js("(() => { const h = document.querySelector('#lecHold'); return { on: h.classList.contains('on'), n: document.querySelector('#lecHoldN').textContent, op: getComputedStyle(h).opacity }; })()"); await G.shot('2-hold-hint-desktop'); } });
    check(await (async () => hintSeen.on && hintSeen.n === '3')(), '7.7초쯤 되면 남은 초(3)가 화면에 뜸');
    check(await G.js("document.querySelector('#lecAuth').hidden && saverOn"), '10초 전에 손을 떼면 아무 일도 없고(처음부터), 해제 화면은 안 뜸');
    check(await G.js("!document.querySelector('#lecHold').classList.contains('on')"), '손을 떼면 남은 초 표시가 사라짐');
    await press(G, 10600); await wait(400);
    check(await G.js("!document.querySelector('#lecAuth').hidden && document.querySelector('#lecAuthNote').textContent.includes('처음 정해') && !document.querySelector('#lecPw2').hidden"), '10초를 끝까지 누르면 해제 화면이 뜨고, PIN이 없으니 처음 정하라고 안내함');
    await G.shot('3-pin-first-desktop');

    console.log('게스트 PIN');
    await G.type('#lecPw', 'abcd'); await G.type('#lecPw2', 'abcd'); await G.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(300);
    check(await G.js("document.querySelector('#lecAuthMsg').textContent.includes('숫자 4자리') && saverOn"), '숫자가 아니면 안내하고 풀리지 않음');
    await G.js("document.querySelector('#lecPw').value = '1234'; document.querySelector('#lecPw2').value = '1111'"); await G.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(300);
    check(await G.js("document.querySelector('#lecAuthMsg').textContent.includes('달라요') && saverOn"), '두 번 입력한 PIN이 다르면 안내하고 풀리지 않음');
    await G.js("document.querySelector('#lecPw2').value = '1234'"); await G.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(500);
    check(await G.js("!saverOn && document.querySelector('#saver').hidden && !document.querySelector('#app').inert && !!get('pinHash') && Object.keys(localStorage).every((k) => localStorage.getItem(k) !== '1234')"), 'PIN을 정하면 풀리고, 저장된 것은 PIN 자체가 아니라 해시');
    check(await G.js("soundOff && __lec.muted && __lec.state === 1"), '풀어도 소리는 꺼진 채이고 강의는 소리 없이 계속 재생됨');

    await G.tap('#panicBtn'); await wait(500);
    await press(G, 10600); await wait(400);
    check(await G.js("!document.querySelector('#lecAuth').hidden && document.querySelector('#lecPw2').hidden && document.querySelector('#lecAuthNote').textContent.includes('PIN(숫자 4자리)을 입력')"), '다음부터는 PIN만 묻는다');
    await G.js("document.querySelector('#lecPw').value = '0000'"); await G.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(400);
    check(await G.js("saverOn && document.querySelector('#lecAuthMsg').textContent.includes('맞지 않아요')"), '틀린 PIN은 풀리지 않고 안내함');
    await G.js("document.querySelector('#lecPw').value = '1234'"); await G.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(500);
    check(await G.js("!saverOn"), '맞는 PIN으로 풀림');

    console.log('새로고침해도 잠금 유지, 강의를 못 불러오면 별 화면');
    await G.tap('#panicBtn'); await wait(500);
    await G.js("location.reload()"); await wait(2500);
    check(await G.js("saverOn && !document.querySelector('#saver').hidden && get('panicLocked') === '1'"), '새로고침해도 화면 보호기가 바로 다시 뜸');
    await G.js("(() => { if (window.__lec) __lec.opts.events.onError({ data: 101 }); })()"); await wait(1200);
    check(await G.js("!document.querySelector('#saver').classList.contains('lec') && getComputedStyle(document.querySelector('#saverCanvas')).display !== 'none'"), '강의가 퍼가기 금지 등으로 안 뜨면 별 화면으로 바뀜');
    await press(G, 10600); await wait(400);
    await G.js("document.querySelector('#lecPw').value = '1234'"); await G.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(500);
    check(await G.js("!saverOn && !get('panicLocked')"), '별 화면에서도 같은 방법으로 풀리고, 잠금 기록이 지워짐');

    console.log('로그인한 사람: 계정 비밀번호');
    const A = await page(1280, 860, false); await A.login('패닉계정'); await A.tap('#enter'); await wait(2200);
    await A.tap('#panicBtn'); await wait(500);
    await press(A, 10600); await wait(400);
    check(await A.js("!document.querySelector('#lecAuth').hidden && document.querySelector('#lecPw2').hidden && document.querySelector('#lecAuthNote').textContent.includes('계정 비밀번호') && document.querySelector('#lecPw').maxLength === 64"), '로그인한 사람에게는 계정 비밀번호를 물음');
    await A.js("document.querySelector('#lecPw').value = 'wrong-password-1'"); await A.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(900);
    check(await A.js("saverOn && document.querySelector('#lecAuthMsg').textContent.includes('맞지 않아요')"), '틀린 비밀번호는 풀리지 않음 (서버가 확인)');
    await A.js("document.querySelector('#lecPw').value = 'pw-패닉계정-12345'"); await A.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(1200);
    check(await A.js("!saverOn"), '맞는 비밀번호로 풀림');
    await A.tap('#panicBtn'); await wait(500); await press(A, 10600); await wait(300);
    await A.js("document.querySelector('#lecCancel').click()"); await wait(200);
    check(await A.js("saverOn && document.querySelector('#lecAuth').hidden"), '"돌아가기"를 누르면 해제 화면만 닫히고 잠금은 그대로');
    await A.js("unlockSaver()");

    console.log('폰: 가로로 돌려서 보여 줌');
    const P = await page(390, 844, true); await P.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await P.login('패닉폰'); await P.js('location.reload()'); await wait(1500);
    await P.login('패닉폰'); await P.tap('#enter'); await wait(2200);
    await P.tap('#panicBtn'); await wait(800);
    check(await P.js("coarse() && saverOn && document.querySelector('#saver').classList.contains('rot') && document.querySelector('#lecture').classList.contains('rot')"), '세로로 든 폰에서는 화면 보호기와 강의를 90도 돌려 가로로 보여 줌');
    check(await P.js("(() => { const b = document.querySelector('#saver').getBoundingClientRect(); return b.width <= innerWidth + 1 && b.height <= innerHeight + 1 && b.width > 300; })()"), '돌린 화면이 폰 화면 안에 꼭 맞음');
    await P.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 400 }); await wait(400);
    await P.shot('4-lecture-phone-rotated');
    check(await P.js("['#lecPlay', '#lecMute'].every((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })"), '돌려도 컨트롤이 화면 안에 있고 터치 크기 이상');
    await press(P, 10600); await wait(500);
    await P.shot('5-auth-phone-rotated');
    check(await P.js("(() => { const f = document.querySelector('#lecAuth').getBoundingClientRect(); return !document.querySelector('#lecAuth').hidden && f.left >= 0 && f.right <= innerWidth && f.top >= 0 && f.bottom <= innerHeight; })()"), '폰에서 해제 화면이 화면 안에 들어옴');
    await P.js("document.querySelector('#lecPw').value = 'pw-패닉폰-12345'"); await P.js("document.querySelector('#lecAuth').requestSubmit()"); await wait(1300);
    check(await P.js("!saverOn && !document.querySelector('#saver').classList.contains('rot')"), '풀면 원래대로 돌아옴');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
