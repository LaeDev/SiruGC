// 서버를 갑자기 끄면 접속자 화면이 어떻게 되는지 확인한다: 실행 중이던 음성/화면 공유가 멈추고 안내 페이지가 바로 뜨는가,
// 서버가 다시 켜지면 알려 주는가. 실행: node tools/down-check.js  (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 4100 + Math.floor(Math.random() * 90), CDP_PORT = 9800 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `down-${Date.now()}.json`);
  const startServer = () => spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: require('path').join(require('os').tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
  let srv = startServer();
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
    async function page() {
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank' });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false });
      await call('Page.addScriptToEvaluateOnNewDocument', { source: `navigator.mediaDevices.getDisplayMedia = async () => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); setInterval(() => { g.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); g.fillRect(0, 0, 320, 180); }, 50); return c.captureStream(15); };` });
      const js = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
      await call('Page.navigate', { url: `http://localhost:${PORT}` }); await wait(1200);
      await js(`(() => { document.querySelector('#nameIn').value = '손님'; document.querySelector('#joinForm').requestSubmit(); })()`);
      await wait(1000);
      return { js, call };
    }
    const until = async (p, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.js(expr)) return Date.now() - t0; await wait(50); } return -1; };

    console.log('음성 + 화면 공유 중에 서버를 갑자기 종료');
    const A = await page();
    await A.js(`document.querySelector('#voiceBtn').click()`); await wait(800);
    await A.js(`document.querySelector('#shareBtn').click()`); await wait(800);
    check(await A.js(`!!mic && !!localStream`), '종료 전: 마이크와 화면 공유가 켜져 있음');

    srv.kill();
    const t = await until(A, `document.querySelector('.end h1')?.textContent === '서버가 꺼졌습니다'`, 5000);
    check(t >= 0 && t < 2000, `안내 페이지가 바로 뜸 (${t}ms)`);
    check(await A.js(`document.body.innerText.includes('다음에 다시 돌아와주세요!')`), '"다음에 다시 돌아와주세요!" 문구');
    check(await A.js(`mic === null && localStream === null && vpcs.size === 0 && pcs.size === 0`), '마이크·화면 공유·연결이 모두 정리됨');
    check(await A.js(`document.title === '서버가 꺼졌습니다'`), '탭 제목도 바뀜');

    console.log('서버가 다시 켜지면');
    srv = startServer();
    const back = await until(A, `document.querySelector('.sub')?.textContent.includes('다시 켜졌어요')`, 12000);
    check(back >= 0, `다시 켜진 것을 알려 줌 (${back}ms)`);
    await A.js(`document.querySelector('.end .btn').click()`); await wait(1500);
    check(await A.js(`!!document.querySelector('#joinForm')`), '"다시 연결해 보기"로 입장 화면으로 돌아옴');

    console.log('서버가 정상 종료 알림(shutdown)을 보낸 경우');
    const B = await page();
    await B.js(`handle({ t: 'shutdown' })`);
    check(await until(B, `document.querySelector('.end h1')?.textContent === '서버가 꺼졌습니다'`, 2000) >= 0, '알림만 받아도 같은 페이지가 뜸');
    browser.close();
  } finally { chrome.kill(); srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
