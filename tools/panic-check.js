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

const YT_STUB = "window.YT = { Player: class {\n  constructor(id, opts) {\n    this.opts = opts; this.vars = opts.playerVars; this.t = 0; this.rate = 1; this.state = -1; this.muted = !!this.vars.mute; this.vol = 100; this.q = '';\n    if (!window.__lec) window.__lec = this;\n    setTimeout(() => { opts.events.onReady({}); this.state = 1; opts.events.onStateChange({ data: 1 }); }, 100);\n  }\n  playVideo() { const was = this.state; this.state = 1; if (was !== 1) this.opts.events.onStateChange({ data: 1 }); } pauseVideo() { if (this.state !== 2) { this.state = 2; this.opts.events.onStateChange({ data: 2 }); } } mute() { this.muted = true; } unMute() { this.muted = false; } isMuted() { return this.muted; }\n  setVolume(v) { this.vol = v; } getVolume() { return this.vol; } getCurrentTime() { return this.t; } getDuration() { return 2700; }\n  seekTo(s) { this.t = s; } setPlaybackRate(r) { this.rate = r; } getPlaybackRate() { return this.rate; } getPlayerState() { return this.state; } getVideoData() { return { title: '다항식의 연산 (1)' }; } setPlaybackQuality(q) { this.q = q; }\n} };\n";
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
      await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?step=profile` }); await wait(1200);
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
    check(await G.js("!!window.__lec && __lec.opts.videoId === '2dI6uMcH5l8' && __lec.vars.mute === 1 && __lec.vars.controls === 0 && __lec.vars.fs === 0 && __lec.vars.disablekb === 1 && __lec.vars.autoplay === 1 && !('start' in __lec.vars) && !('end' in __lec.vars)"), '입장하면 지정한 강의 영상이 소리 없이 컨트롤 없이 미리 재생되기 시작함');
    check(await G.js("__lec.t === 1350"), '영상의 한가운데(2700초 중 1350초)부터 재생됨');
    check(await G.js("__lec.muted && __lec.state === 1 && __lec.q === 'small' && getComputedStyle(document.querySelector('#lecture')).opacity === '0' && document.querySelector('#saver').hidden"), '미리 재생은 낮은 화질로 보이지 않게 돌아가고, 아직 화면 보호기는 안 뜸');

    console.log('패닉: 강의 화면과 강의 플레이어 컨트롤');
    await G.tap('#panicBtn'); await wait(700);
    check(await G.js("saverOn && !document.querySelector('#saver').hidden && document.querySelector('#saver').classList.contains('lec') && document.querySelector('#lecture').classList.contains('on') && soundOff && document.querySelector('#app').inert"), '패닉을 누르면 채팅 위로 강의가 뜨고 소리가 꺼지고 뒤 화면이 잠김');
    check(await G.js("getComputedStyle(document.querySelector('#saverCanvas')).display === 'none' && !document.querySelector('#lecTitle') && !document.querySelector('#saver').textContent.toLowerCase().includes('youtube')"), '별 화면 대신 강의가 보이고, 유튜브의 제목·이름이 화면 요소에 없음');
    await wait(200);
    await G.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 }); await wait(300);
    check(await G.js("(() => { const b = document.querySelector('#lecBar').getBoundingClientRect(), v = document.querySelector('#lecture').getBoundingClientRect(); return getComputedStyle(document.querySelector('#lecBar')).opacity === '1' && b.bottom === innerHeight && b.height >= 100 && v.bottom <= b.top + 1 && ['#lecPlay', '#lecStop', '#lecBack', '#lecFwd', '#lecMute', '#lecSeek', '#lecRates'].every((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.top >= b.top && r.bottom <= b.bottom; }); })()"), '아래의 어두운 컨트롤 판이 늘 보이고 영상 칸은 그 위쪽만 씀 (재생·정지·10초·속도·볼륨·재생 위치)');
    check(await G.js("(() => { const f = document.createElement('iframe'); const L = document.querySelector('#lecture'); L.append(f); const c = L.getBoundingClientRect(), r = f.getBoundingClientRect(), pe = getComputedStyle(f).pointerEvents; L.style.setProperty('--z', 1.5); const big = f.getBoundingClientRect(); L.style.setProperty('--z', 1); f.remove(); return r.width <= c.width + 1 && r.height <= c.height + 1 && Math.abs(r.width / r.height - 16 / 9) < 0.02 && big.width > c.width && pe === 'none'; })()"), '영상은 칸 안에 통째로 들어가고(16:9), 화면크기를 키우면 칸 밖으로 넘쳐 잘리며, 유튜브 화면 자체는 직접 조작이 안 됨');
    check(await G.js("getComputedStyle(document.querySelector('#lecShield')).pointerEvents !== 'none' && document.elementFromPoint(640, 300) === document.querySelector('#lecShield')"), '영상 위는 투명한 막이 덮고 있어서 유튜브 자신의 컨트롤이 나올 수 없음');
    await G.shot('1-lecture-desktop');
    await G.tap('#lecPlay'); await wait(300);
    check(await G.js("__lec.state === 2 && document.querySelector('#lecPlay').getAttribute('aria-label') === '재생'"), '정지 버튼: 영상이 멈추고 버튼이 "재생"으로 바뀜');
    await G.tap('#lecPlay'); await wait(300);
    check(await G.js("__lec.state === 1"), '재생 버튼: 다시 재생됨');
    check(await G.js("document.querySelector('#lecCover').classList.contains('on') && document.querySelector('#lecCover').classList.contains('busy')"), '멈췄다 다시 재생한 직후에는 유튜브가 자기 화면(제목·공유·추천)을 그리는 동안 검은 막이 영상을 덮음');
    await wait(6000);
    check(await G.js("!document.querySelector('#lecCover').classList.contains('on')"), '그 시간이 지나면 영상이 보임');
    await G.tap('#lecBack'); check(await G.js("Math.abs(__lec.t - 1340) < 3 && document.querySelector('#lecCover').classList.contains('on')"), '10초 뒤로 (건너뛴 직후에도 유튜브 화면을 가리기 위해 검은 막)');
    await G.tap('#lecFwd'); await G.tap('#lecFwd'); check(await G.js("Math.abs(__lec.t - 1360) < 3"), '10초 앞으로');
    await G.js("document.querySelectorAll('#lecRates button')[4].click()"); await wait(200);
    check(await G.js("__lec.rate === 1.5 && document.querySelectorAll('#lecRates button')[4].getAttribute('aria-pressed') === 'true'"), '재생 속도 점을 누르면 그 속도로 바뀌고 표시됨');
    await G.tap('#lecSeek'); check(await G.js("__lec.t > 100 && __lec.t < 2600"), '재생 위치 막대를 누르면 그 자리로 이동');
    await G.js("__lec.rate = 1; lecUi()");
    await G.tap('#lecStop'); await wait(300);
    check(await G.js("__lec.state === 2 && __lec.t === 1350 && document.querySelector('#lecCover').classList.contains('on')"), '정지 버튼: 멈추고 처음 자리(한가운데)로 돌아가며, 멈춘 동안은 검은 화면이 영상을 덮음 (유튜브의 일시정지 추천이 안 보이게)');
    await G.tap('#lecPlay'); await wait(300);
    await G.js("(() => { const s = document.querySelector('#lecStep'); s.value = '30'; s.dispatchEvent(new Event('change')); })()");
    await G.tap('#lecFwd'); check(await G.js("Math.abs(__lec.t - 1380) < 3 && get('lecStep') === '30' && document.querySelector('#lecFwd').getAttribute('aria-label') === '30초 앞으로'"), '화면이동을 30초로 바꾸면 앞으로 버튼이 30초씩 가고 설정이 저장됨');
    await G.js("__lec.t = 1350; (() => { const s = document.querySelector('#lecStep'); s.value = '10'; s.dispatchEvent(new Event('change')); })()");
    await G.tap('#lecLoop'); await G.js('__lec.t = 1362'); await G.tap('#lecLoop'); await wait(100);
    check(await G.js("document.querySelector('#lecLoop').textContent.includes('22:30') && document.querySelector('#lecLoop').textContent.includes('22:42')"), '구간반복: 시작점과 끝점을 정하면 표시됨');
    await G.js('__lec.t = 1363'); await wait(500);
    check(await G.js("Math.abs(__lec.t - 1350) < 2"), '끝점을 넘으면 시작점으로 되돌아가 반복함');
    await G.tap('#lecLoop'); check(await G.js("document.querySelector('#lecLoop').textContent === '구간반복' && document.querySelector('#lecLoop').getAttribute('aria-pressed') === 'false'"), '한 번 더 누르면 구간반복이 풀림');
    await G.js('__lec.t = 1400; lecUi()'); await G.tap('#lecMark'); await G.js('__lec.t = 1500; lecUi()');
    check(await G.js("[...document.querySelectorAll('#lecMarks button')].map((b) => b.textContent).join() === '23:20'"), '북마크추가: 지금 자리가 목록에 생김');
    await G.tap('#lecMarks button'); check(await G.js("Math.abs(__lec.t - 1400) < 2"), '북마크를 누르면 그 자리로 이동함');
    await G.js('lecUi()'); check(await G.js("document.querySelector('#lecMark').textContent === '북마크해제'"), '북마크 자리에서는 버튼이 해제로 바뀜');
    await G.tap('#lecMark'); check(await G.js("document.querySelectorAll('#lecMarks button').length === 0"), '북마크해제로 지움');
    await G.tap('#lecSizes button:nth-child(2)'); check(await G.js("document.querySelector('#lecture').style.getPropertyValue('--z') === '1.3' && get('lecSize') === 'S2' && document.querySelector('#lecSizes button:nth-child(2)').getAttribute('aria-pressed') === 'true'"), '화면크기 S2: 영상이 커지고 저장됨');
    await G.tap('#lecSizes button:nth-child(5)'); check(await G.js("document.querySelector('#lecture').style.getPropertyValue('--z') === '1' && !!document.querySelector('#lecFull')"), '화면크기 일반: 원래 크기로, 전체 화면 버튼도 있음');
    await G.js('__lec.t = 1350');
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
    console.log('iPhone 홈 화면 앱: 가로로 든 채 (노치·홈 바 안전 영역)');
    const L = await page(844, 390, true, UA.iphone); await L.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await L.call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 47, bottom: 21, right: 47 } });
    await L.login('패닉가로'); await L.js('location.reload()'); await wait(1500); await L.login('패닉가로'); await L.tap('#enter'); await wait(2200);
    await L.tap('#panicBtn'); await wait(900);
    check(await L.js("saverOn && !document.querySelector('#saver').classList.contains('rot') && document.documentElement.classList.contains('saver-on') && getComputedStyle(document.querySelector('#app')).visibility === 'hidden'"), '가로로 든 폰: 돌리지 않고 그대로 보이며, 뒤의 방은 아예 안 그려짐');
    check(await L.js("(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(), v = r('#lecture'), b = r('#lecBar'); return v.left >= 46 && innerWidth - v.right >= 46 && Math.abs(v.bottom - b.top) <= 1 && b.bottom <= innerHeight + 1 && ['#lecPlay', '#lecMute', '#lecRate'].every((x) => { const e = r(x); return e.left >= 46 && e.right <= innerWidth - 46 && e.bottom <= innerHeight - 20; }); })()"), '영상과 컨트롤이 좌우 노치 여백(47px)과 아래 홈 바 여백(21px) 안에 들어오고, 영상과 컨트롤 판 사이에 틈이 없음');
    await L.shot('6-landscape-iphone');
    await press(L, 10600); await wait(500);
    check(await L.js("!document.querySelector('#lecAuth').hidden && getComputedStyle(document.querySelector('#app')).visibility === 'hidden' && getComputedStyle(document.querySelector('#lecBar')).display !== 'none' && document.querySelector('#lecture').classList.contains('on')"), '비밀번호를 묻는 동안에도 강의 화면과 컨트롤 판이 그대로 보이고 뒤의 방은 가려져 있음');
    check(await L.js("(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight - 3); return !e || !e.closest('#app, #join'); })()"), '화면 맨 아래 띠를 눌러 봐도 뒤의 방이 아님');
    check(await L.js("(() => { const f = document.querySelector('#lecAuth').getBoundingClientRect(); return f.top >= 0 && f.bottom <= innerHeight && f.left >= 0 && f.right <= innerWidth; })()"), '비밀번호 칸이 화면 안에 들어옴 (낮은 가로 화면)');
    await L.shot('7-landscape-asking');
    await L.js("document.querySelector('#lecCancel').click()"); await L.js("unlockSaver()");

    console.log('iPhone 홈 화면 앱: 세로로 든 채 (돌려서 보여 줌, 안전 영역)');
    const V = await page(390, 844, true, UA.iphone); await V.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await V.call('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, left: 0, bottom: 34, right: 0 } });
    await V.login('패닉세로'); await V.js('location.reload()'); await wait(1500); await V.login('패닉세로'); await V.tap('#enter'); await wait(2200);
    await V.tap('#panicBtn'); await wait(900);
    check(await V.js("(() => { const b = document.querySelector('#saver').getBoundingClientRect(); return document.querySelector('#saver').classList.contains('rot') && Math.abs(b.width - innerWidth) <= 1 && Math.abs(b.height - innerHeight) <= 1; })()"), '세로로 든 폰: 화면을 돌려 보이는 영역에 딱 맞음');
    check(await V.js("(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(), v = r('#lecture'); return v.top >= 46 && v.bottom <= innerHeight - 33 && ['#lecPlay', '#lecMute', '#lecRate'].every((x) => { const e = r(x); return e.top >= 46 && e.bottom <= innerHeight - 33 && e.left >= 0 && e.right <= innerWidth; }); })()"), '돌린 화면의 영상과 컨트롤이 위 노치(47px)와 아래 홈 바(34px) 여백 안에 들어옴');
    await V.shot('8-portrait-iphone-rotated');
    await V.js("unlockSaver()");
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
