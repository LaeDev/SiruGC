// 점검 도구들이 같이 쓰는 도우미: 서버와 headless Chrome을 띄우고, 사람처럼 누르고 입력하는 창(page)을 만들어 준다.
// 쓰는 법: const h = await launch({ env: {...} }); const p = await h.page(1100, 800); await p.type('#nameIn', '이름'); ... await h.close();
// 서버는 임시 상태 파일로, 실제 서버·state.json 은 건드리지 않는다. TEMP 를 E:\tmpchk 처럼 용량 넉넉한 곳으로 두고 돌릴 것.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { AUTH_ENV, signup, loginJs } = require('./_auth');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

async function launch({ env = {}, args = [], auth = false } = {}) {
  const PORT = 5000 + Math.floor(Math.random() * 900), CDP_PORT = 9000 + Math.floor(Math.random() * 900);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const startSrv = () => spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, ...(auth ? AUTH_ENV : {}), PORT, STATE_FILE: path.join(tmp, 'state.json'), CONFIG_FILE: path.join(tmp, 'none.env'), ...env } });
  let srv = startSrv();
  const prof = path.join(tmp, 'chrome');
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required', ...args, 'about:blank'], { stdio: 'ignore' });
  await wait(2500);
  const browser = new WebSocket((await getJson(`http://localhost:${CDP_PORT}/json/version`)).webSocketDebuggerUrl);
  await new Promise((r) => browser.on('open', r));
  let id = 0; const pending = new Map();
  browser.on('message', (d) => { const m = JSON.parse(d); pending.get(m.id)?.(m); if (m.method === 'Runtime.exceptionThrown') console.log('  페이지 예외:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const raw = (method, params = {}, sessionId) => new Promise((ok) => { const i = ++id; pending.set(i, ok); browser.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const h = { PORT, url: `http://127.0.0.1:${PORT}` };
  // 서버를 껐다 켠다 (같은 포트·같은 상태 파일). 꺼지는 동안 열려 있는 화면이 어떻게 하는지 볼 때 쓴다
  h.stopServer = async () => { srv.kill(); await wait(600); };
  h.startServer = async () => { srv = startSrv(); await wait(1500); };
  // 창 하나 (창마다 따로 저장소를 가진 새 브라우저 맥락). ua: 사용자 에이전트, mobile: 폰처럼
  h.page = async (w = 1100, hgt = 800, { mobile = false, ua, path: pth = '/?step=profile', block = ['*://www.youtube.com/*', '*://i.ytimg.com/*', '*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'], ctx } = {}) => {
    const browserContextId = ctx || (await raw('Target.createBrowserContext')).result.browserContextId;
    const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
    const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => raw(m, p, sessionId);
    await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
    if (block.length) await call('Network.setBlockedURLs', { urls: block });
    if (ua) await call('Emulation.setUserAgentOverride', { userAgent: ua });
    await call('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile });
    if (mobile) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('  JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
    const p = { js, call, ctx: browserContextId };
    p.rect = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; })()`);
    p.tap = async (sel) => { // 실제로 그 자리를 마우스로 누른다
      await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await wait(100);
      const r = await p.rect(sel); if (!r) throw new Error('없음: ' + sel);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await wait(150);
    };
    p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
    p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
    p.shot = async (file) => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
    p.open = async (pth2 = pth) => { await call('Page.navigate', { url: h.url + pth2 }); await wait(1200); };
    // 가입해 둔 계정으로 로그인한 상태(쪽지 보안 키 포함)를 만들어 입장한다 (auth: true 로 띄운 서버에서만)
    p.login = async (name) => { await p.open(); await js(loginJs(await signup(PORT, name))); await js(`(() => { document.querySelector('#nameIn').value = ${JSON.stringify(name)}; document.querySelector('#joinForm').requestSubmit(); })()`); return p.until('joined', 8000); };
    p.join = async (name) => { await p.open(); await p.type('#nameIn', name); await p.tap('#enter'); return p.until('joined', 8000); };
    await p.open();
    return p;
  };
  h.close = async () => {
    try { browser.close(); } catch {}
    chrome.kill(); try { execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    srv.kill(); await wait(500);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  };
  return h;
}
const reporter = () => { let failed = 0; return { check: (ok, msg) => { console.log((ok ? '  통과 ' : '  실패 ') + msg); if (!ok) failed++; }, done: () => { console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); return failed ? 1 : 0; } }; };
module.exports = { launch, wait, reporter };
