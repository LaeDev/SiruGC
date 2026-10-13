// 채팅 화면 크기 조정을 실제 브라우저에서 확인한다.
//  PC: 영상과 채팅 사이 선을 마우스로 끌기·키보드·두 번 누르기, 한계값, 저장 후 다시 열어도 유지
//  폰 세로: 손잡이를 손가락으로 끌어 영상 높이 바꾸기, 채팅 입력창이 화면 안에 남는지
//  채팅 글자 크기: 설정 슬라이더가 실제 글자 크기에 적용되고 저장되는지
// 실행: node tools/layout-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5600 + Math.floor(Math.random() * 90), CDP_PORT = 9600 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `layout-${Date.now()}.json`);
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let failed = 0;
  const check = (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; };
  try {
    await wait(2500);
    const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
    await new Promise((r) => browser.on('open', r));
    let id = 0; const pending = new Map();
    browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); });
    const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
    async function page(name, size) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.mobile ? 2 : 1, mobile: !!size.mobile });
      if (size.mobile) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log(`[${name}] JS 오류:`, r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      const open = async () => { await call('Page.navigate', { url: `http://localhost:${PORT}/?step=profile` }); await wait(1200); await js(`(() => { document.querySelector('#nameIn').value = '${name}'; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(900); };
      await open();
      return { js, call, open };
    }
    const until = async (p, expr, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(150); } return false; };

    console.log('PC (1280x860): 채팅 너비');
    const D = await page('피씨', { w: 1280, h: 860 });
    const sideW = () => D.js(`Math.round(document.querySelector('.side').getBoundingClientRect().width)`);
    const stageW = () => D.js(`Math.round(document.querySelector('.stage').getBoundingClientRect().width)`);
    const c = await D.js(`(() => { const r = document.querySelector('#resizer'); const b = r.getBoundingClientRect(); return { role: r.getAttribute('role'), o: r.getAttribute('aria-orientation'), label: r.getAttribute('aria-label'), tab: r.tabIndex, x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; })()`);
    check(c.role === 'separator' && c.o === 'vertical' && c.label.includes('채팅 너비') && c.tab === 0, `선에 역할·방향·이름이 있고 키보드로 닿음 ("${c.label}")`);
    check(await sideW() === 400, `처음 채팅 너비는 기본 400px`);
    const mouse = (type, x, y) => D.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const drag = async (fromX, y, toX) => { await mouse('mousePressed', fromX, y); for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', fromX + ((toX - fromX) * i) / 8, y); await wait(20); } await mouse('mouseReleased', toX, y); await wait(150); };
    const x0 = Math.round(c.x), y0 = Math.round(c.y);
    const stage0 = await stageW();
    await drag(x0, y0, x0 - 120);
    const w1 = await sideW();
    check(Math.abs(w1 - 520) <= 6, `왼쪽으로 120px 끌면 채팅이 넓어짐 (400 → ${w1}px)`);
    check(Math.abs((await stageW()) - (stage0 - 120)) <= 6, '영상 쪽은 그만큼 좁아짐');
    check(await D.js(`document.documentElement.scrollWidth - innerWidth <= 0 && document.querySelector('#chatIn').getBoundingClientRect().right <= innerWidth`), '넓혀도 가로로 넘치지 않고 입력창이 보임');
    check(await D.js(`localStorage.sideW === '${w1}'`), '너비가 이 기기에 저장됨');
    const c2 = await D.js(`(() => { const b = document.querySelector('#resizer').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await drag(c2.x, c2.y, c2.x - 900);
    const wMax = await sideW();
    check(wMax <= 720 && wMax >= 700, `끝까지 끌어도 상한(화면의 60%, 최대 720px)을 넘지 않음 (${wMax}px)`);
    check(await D.js(`document.querySelector('.stage').getBoundingClientRect().width >= 400`), '영상 쪽도 최소한의 폭이 남음');
    const c3 = await D.js(`(() => { const b = document.querySelector('#resizer').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    await drag(c3.x, c3.y, c3.x + 900);
    check(await sideW() === 280, `반대로 끝까지 끌면 최소 280px에서 멈춤`);

    console.log('PC: 키보드와 두 번 누르기');
    await D.js(`document.querySelector('#resizer').focus()`);
    const key = async (k, shift) => { for (const type of ['keyDown', 'keyUp']) await D.call('Input.dispatchKeyEvent', { type, key: k, code: k, modifiers: shift ? 8 : 0, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 }[k] }); await wait(100); };
    await key('ArrowLeft'); check(await sideW() === 300, '← 로 20px 넓어짐');
    await key('ArrowRight'); check(await sideW() === 280, '→ 로 20px 좁아짐');
    await key('ArrowLeft', true); check(await sideW() === 360, 'Shift+← 는 80px씩');
    await key('End'); check((await sideW()) >= 700, 'End는 가장 넓게');
    await key('Home'); check(await sideW() === 280, 'Home은 가장 좁게');
    check(await D.js(`document.querySelector('#resizer').getAttribute('aria-valuenow') === '280'`), '현재 값이 보조기기에 전달됨(aria-valuenow)');
    await D.js(`document.querySelector('#resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await wait(100);
    check(await sideW() === 400 && await D.js(`!localStorage.sideW`), '두 번 누르면 기본(400px)으로 돌아가고 저장값도 지워짐');
    await key('ArrowLeft'); await key('ArrowLeft'); // 440
    await D.open();
    check(await sideW() === 440, '다시 접속해도 크기가 유지됨');

    console.log('채팅 글자 크기');
    await D.js(`(() => { document.querySelector('#chatIn').value = '글자 크기 확인용 메시지'; document.querySelector('#chatForm').requestSubmit(); })()`);
    await until(D, `document.querySelector('.bubble p')`);
    const fs0 = await D.js(`parseFloat(getComputedStyle(document.querySelector('.bubble p')).fontSize)`);
    await D.js(`document.querySelector('#settingsBtn').click()`); await wait(300);
    await D.js(`(() => { const r = document.querySelector('#chatSize'); r.value = 3; r.dispatchEvent(new Event('input')); })()`);
    const fs3 = await D.js(`parseFloat(getComputedStyle(document.querySelector('.bubble p')).fontSize)`);
    check(fs0 === 16 && fs3 === 21, `"아주 크게"를 고르면 채팅 글자가 커짐 (${fs0}px → ${fs3}px)`);
    check(await D.js(`document.querySelector('#chatSizeOut').textContent === '아주 크게' && document.querySelector('#chatSize').getAttribute('aria-valuetext') === '아주 크게'`), '현재 크기가 글자로도 표시됨 (슬라이더 값만이 아님)');
    check(await D.js(`parseFloat(getComputedStyle(document.querySelector('#chatIn')).fontSize) >= 16`), '입력창 글자는 16px 아래로 내려가지 않음 (iOS 자동 확대 방지)');
    await D.js(`(() => { const r = document.querySelector('#chatSize'); r.value = 0; r.dispatchEvent(new Event('input')); })()`);
    check(await D.js(`parseFloat(getComputedStyle(document.querySelector('.bubble p')).fontSize) === 14`), '"작게"는 14px');
    await D.js(`document.querySelector('#layoutReset').click()`);
    check(await D.js(`parseFloat(getComputedStyle(document.querySelector('.bubble p')).fontSize) === 16 && !localStorage.sideW`) && await sideW() === 400, '"크기 모두 되돌리기"가 글자와 너비를 기본으로');
    await D.js(`(() => { const r = document.querySelector('#chatSize'); r.value = 2; r.dispatchEvent(new Event('input')); })()`);
    await D.open();
    check(await D.js(`getComputedStyle(document.documentElement).getPropertyValue('--chat-fs').trim() === '18px' && +document.querySelector('#chatSize').value === 2`), '글자 크기도 다시 접속하면 유지됨');

    console.log('폰 세로 (390x844): 영상 높이');
    const M = await page('폰', { w: 390, h: 844, mobile: true });
    const m = await M.js(`(() => { const r = document.querySelector('#resizer'); const b = r.getBoundingClientRect(); return { o: r.getAttribute('aria-orientation'), label: r.getAttribute('aria-label'), x: b.left + b.width / 2, y: b.top + b.height / 2, h: b.height, w: b.width }; })()`);
    check(m.o === 'horizontal' && m.label.includes('영상 높이'), `폰에서는 가로 손잡이로 바뀜 ("${m.label}")`);
    const hit = await M.js(`(() => { const r = document.querySelector('#resizer').getBoundingClientRect(); let n = 0; for (let dy = -30; dy <= 30; dy += 2) if (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + dy)?.id === 'resizer') n += 2; return n; })()`);
    check(m.w >= 300 && hit >= 40, `손잡이를 누를 수 있는 영역이 높이 ${hit}px (눈에 보이는 줄은 ${Math.round(m.h)}px). 누르는 영역 최소 24px (WCAG 2.2), 터치 권장 44px`);
    check(await M.js(`(() => { const r = document.querySelector('#resizer').getBoundingClientRect(); const mid = document.elementFromPoint(r.left + r.width / 2, r.top + 12), edge = document.elementFromPoint(20, r.top + 12); return mid?.id === 'resizer' && edge?.id !== 'resizer'; })()`), '가운데 알약만 잡히고, 양옆은 탭 터치를 가리지 않음');
    check(await M.js(`document.querySelector('#resizer').getBoundingClientRect().top >= document.querySelector('.stage').getBoundingClientRect().bottom - 1`), '손잡이가 영상 영역 위에 겹치지 않음 (영상 컨트롤을 가리지 않음)');
    const stageH = () => M.js(`Math.round(document.querySelector('.stage').getBoundingClientRect().height)`);
    const h0 = await stageH();
    const touch = (type, x, y) => M.call('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', m.x, m.y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', m.x, m.y + (160 * i) / 8); await wait(25); }
    await touch('touchEnd'); await wait(200);
    const h1 = await stageH();
    check(h1 - h0 >= 120, `아래로 끌면 영상 영역이 커짐 (${h0} → ${h1}px)`);
    check(await M.js(`document.documentElement.scrollWidth - innerWidth <= 0`), '가로로 넘치지 않음');
    check(await M.js(`(() => { const r = document.querySelector('#chatIn').getBoundingClientRect(); return r.bottom <= innerHeight && r.top > 0; })()`), '영상을 키워도 채팅 입력창이 화면 안에 남음');
    const m2 = await M.js(`(() => { const b = document.querySelector('#resizer').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await touch('touchStart', m2.x, m2.y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', m2.x, m2.y + (900 * i) / 8); await wait(25); }
    await touch('touchEnd'); await wait(200);
    check(await M.js(`(() => { const r = document.querySelector('#chatIn').getBoundingClientRect(); return r.bottom <= innerHeight && r.top > 0; })()`) && await M.js(`Math.round(document.querySelector('.stage').getBoundingClientRect().height) <= innerHeight * 0.6 + 4`), '끝까지 끌어도 영상은 화면의 60%까지만, 입력창은 계속 보임');
    const m3 = await M.js(`(() => { const b = document.querySelector('#resizer').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await touch('touchStart', m3.x, m3.y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', m3.x, m3.y - (900 * i) / 8); await wait(25); }
    await touch('touchEnd'); await wait(200);
    check(await M.js(`Math.round(document.querySelector('.stage').getBoundingClientRect().height) >= 100`), '반대로 끝까지 올려도 영상 영역이 사라지지 않음');
    await M.js(`document.querySelector('#resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`); await wait(150);
    check(await M.js(`!localStorage.videoH && !document.documentElement.classList.contains('video-h')`), '두 번 누르면 원래 높이로 돌아감');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
