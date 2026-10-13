// 닉네임 중복 입장 불가와, 같은 IP의 다른 기기 연결(sync)을 실제 브라우저로 확인한다.
//  서로 다른 IP는 http://127.0.0.1 과 http://[::1] 로, 같은 IP의 다른 기기는 127.0.0.1 의 별개 브라우저 프로필로 흉내 낸다.
// 실행: node tools/name-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5800 + Math.floor(Math.random() * 90), CDP_PORT = 9800 + Math.floor(Math.random() * 90);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((ok, no) => http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok(JSON.parse(d))); }).on('error', no));

(async () => {
  const state = path.join(os.tmpdir(), `name-${Date.now()}.json`);
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
    async function page(host, w = 390, h = 844) {
      const { result: { browserContextId } } = await raw('Target.createBrowserContext');
      const { result: { targetId } } = await raw('Target.createTarget', { url: 'about:blank', browserContextId });
      const { result: { sessionId } } = await raw('Target.attachToTarget', { targetId, flatten: true });
      const call = (m, p) => raw(m, p, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
      const js = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 오류:', r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
      await call('Page.navigate', { url: `http://${host}:${PORT}` }); await wait(1200);
      return { js, join: async (name) => { await js(`(() => { document.querySelector('#nameIn').value = ${JSON.stringify(name)}; document.querySelector('#joinForm').requestSubmit(); })()`); await wait(1200); } };
    }
    const until = async (p, expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.js(expr)) return true; await wait(200); } return false; };

    const A = await page('127.0.0.1'); await A.join('시루');
    check(await A.js(`joined && !document.querySelector('#app').hidden`), '처음 쓰는 닉네임으로 입장함');

    console.log('다른 IP에서 같은 닉네임');
    const B = await page('[::1]'); await B.join('시루 ');
    check(await until(B, `!document.querySelector('#join').hidden && document.querySelector('#joinMsg').textContent.includes('다른 사람이 쓰고')`), '입장 화면에 머물면서 "이미 쓰는 닉네임" 안내가 뜸');
    check(await B.js(`!document.querySelector('#enter').disabled && document.querySelector('#enter').textContent === '입장하기' && document.activeElement.id === 'nameIn'`), '버튼이 다시 눌리고 닉네임 칸에 커서가 돌아옴');
    check(await B.js(`(() => { const m = document.querySelector('#joinMsg').getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()`), '폰 화면(390px)에서 안내가 잘리거나 넘치지 않음');
    check(!(await A.js(`document.body.textContent.includes('시루 님이 들어왔어요')`)), '기존 사람에게는 입장 알림이 가지 않음');
    await B.join('다른이름');
    check(await B.js(`joined && !document.querySelector('#app').hidden`), '다른 닉네임으로 바꾸면 들어올 수 있음');

    console.log('같은 IP의 같은 닉네임');
    const C = await page('127.0.0.1'); await C.join('시루');
    check(await until(C, `!document.querySelector('#join').hidden && document.querySelector('#joinMsg').textContent.includes('다른 사람이 쓰고')`), '같은 IP에서도 같은 닉네임은 들어올 수 없음 (남의 쪽지·프로필이 넘어가지 않음)');
    check(await C.js(`!joined && document.querySelector('#joinMsg').textContent.indexOf('같은 와이파이') < 0`), '들어오지 못했고, 예전의 "같은 와이파이면 들어올 수 있다"는 안내는 사라짐');
    console.log('쓸 수 없는 글자');
    const E = await page('127.0.0.1'); await E.join('😎멋쟁이');
    check(await E.js(`!joined && document.querySelector('#joinMsg').textContent.includes('한글, 영문, 숫자')`), '이모티콘 닉네임은 연결하기 전에 바로 안내됨');
    check(await E.js(`document.querySelector('#joinMsg').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth`), '안내가 폰 화면(390px)에서 잘리지 않음');
    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
