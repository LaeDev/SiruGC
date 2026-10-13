// 호스트 규칙을 실제 브라우저로 확인한다: 맨 처음 들어온 사람이 호스트, 대기열 추가 허락/회수, 호스트 넘기기, 대기열 조작은 호스트만.
// 실행: node tools/host-check.js   (CHROME 환경변수로 chrome.exe 경로 지정 가능, SHOTS=폴더 로 화면 사진 저장)
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
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, STATE_FILE: state, CONFIG_FILE: path.join(os.tmpdir(), 'no-such-config.env') }, stdio: 'ignore' });
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
      await call('Network.enable'); await call('Network.setBlockedURLs', { urls: ['*://www.youtube.com/*', '*://i.ytimg.com/*'] }); // 유튜브에 닿지 않게 막는다: 영상이 퍼가기 금지이거나 늦게 뜨면 화면이 '끝남'을 알려 대기열이 저절로 당겨져서 결과가 흔들렸다
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
      p.type = async (sel, text) => { await p.tap(sel); await call('Input.insertText', { text }); await wait(100); };
      p.shot = async (name) => { if (!SHOTS) return; const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
      p.until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await wait(200); } return false; };
      await call('Page.navigate', { url: `http://127.0.0.1:${PORT}` }); await wait(1200);
      return p;
    }
    const noOverflow = `document.documentElement.scrollWidth <= innerWidth`;

    console.log('입장: 호스트와 일반 참가자');
    const R = await page(1280, 860, false); await R.type('#nameIn', '가나다'); await R.tap('#enter'); await wait(1500);
    const P = await page(390, 844, true); await P.type('#nameIn', '라마바'); await P.tap('#enter'); await wait(1500);
    check(await R.js('joined && isHost && canQueue'), '맨 처음 들어온 사람이 호스트이고 대기열에 올릴 수 있음');
    check(await P.js('joined && !isHost && !canQueue'), '두 번째 사람은 호스트도 아니고 대기열에 올릴 수도 없음');
    check(await P.js("users.find((u) => u.name === '가나다').host === true"), '목록에서 호스트가 표시됨');
    await R.js('window.confirm = () => true');

    console.log('대기열: 허락받기 전');
    await P.tap('#tab-queue');
    check(await P.js("!document.querySelector('#qPerm').hidden && [...document.querySelector('#qForm').elements].every((e) => e.disabled)"), '입력칸과 추가 버튼이 막혀 있고 "호스트의 허락이 필요해요" 안내가 보임');
    check(await P.js("(() => { const b = document.querySelector('#qPerm').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()"), '안내가 폰 화면(390px)에서 잘리지 않음');
    await P.shot('1-queue-locked-phone');

    console.log('대기열: 호스트가 허락');
    await R.tap('#tab-users');
    await R.tap('.urow[data-uid]'); await wait(300);
    check(await R.js("[...document.querySelectorAll('.acts .btn')].some((b) => b.textContent === '대기열 추가 허용') && [...document.querySelectorAll('.acts .btn')].some((b) => b.textContent === '호스트 넘기기')"), '사람을 누르면 "대기열 추가 허용"과 "호스트 넘기기"가 보임');
    await R.shot('2-host-menu-desktop');
    await R.js("[...document.querySelectorAll('.acts .btn')].find((b) => b.textContent === '대기열 추가 허용').click()"); await wait(500);
    check(await P.js('canQueue && document.querySelector("#qPerm").hidden && [...document.querySelector("#qForm").elements].every((e) => !e.disabled)'), '허락하면 그 사람 화면에서 바로 입력칸이 열림');
    check(await R.js("[...document.querySelectorAll('.urow .tag')].some((t) => t.textContent === '대기열 가능')"), '호스트 목록에 "대기열 가능" 표시가 붙음');
    await P.type('#qUrl', 'https://youtu.be/dQw4w9WgXcQ'); await P.tap('#qForm button[type=submit]');
    check(await R.until("document.querySelector('#now') && !document.querySelector('#now').hidden"), '허락받은 사람이 올린 영상이 재생됨');
    await P.type('#qUrl', 'https://youtu.be/jNQXAC9IVRw'); await P.tap('#qForm button[type=submit]');
    check(await R.until("document.querySelectorAll('#qList li').length === 1", 10000), '두 번째 영상은 대기열에 줄을 섬');

    console.log('대기열 조작은 호스트만');
    await R.tap('#tab-queue');
    check(await R.js("!document.querySelector('#nowSkip').hidden && document.querySelectorAll('#qList .qbtns .btn').length >= 3"), '호스트 화면에는 건너뛰기·순서·재생·빼기 버튼이 있음');
    check(await P.js("document.querySelector('#nowSkip').hidden && document.querySelectorAll('#qList .qbtns').length === 0"), '일반 참가자 화면에는 조작 버튼이 없음 (자기가 올린 것도)');
    await P.shot('3-queue-member-phone');

    console.log('호스트 넘기기');
    await R.tap('#tab-users'); await wait(200);
    if (!(await R.js("!!document.querySelector('.acts')"))) await R.tap('.urow[data-uid]'); // 메뉴는 열린 채로 남아 있다 (한 번 더 누르면 닫힘)
    await wait(300);
    await R.js("[...document.querySelectorAll('.acts .btn')].find((b) => b.textContent === '호스트 넘기기').click()"); await wait(700);
    check(await R.js('!isHost'), '넘긴 사람은 더 이상 호스트가 아님');
    check(await P.js('isHost && canQueue'), '받은 사람이 호스트가 됨');
    check(await P.js("document.body.textContent.includes('이제 내가 이 방의 호스트예요')") && await R.js("document.body.textContent.includes('호스트가 됐어요')"), '양쪽 채팅에 안내가 뜸');
    check(await R.js("[...document.querySelectorAll('.urow')].find((r) => r.textContent.includes('라마바')).textContent.includes('호스트')"), '목록에서 새 호스트가 표시됨');
    await P.tap('#tab-queue');
    check(await P.js("!document.querySelector('#nowSkip').hidden"), '새 호스트 화면에는 이제 조작 버튼이 보임');
    check(await R.js("document.querySelector('#nowSkip').hidden"), '넘긴 사람 화면에서는 조작 버튼이 사라짐');
    await P.tap('#tab-users'); await wait(200); await P.shot('4-new-host-phone');

    browser.close();
  } finally { chrome.kill(); try { require("child_process").execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" }); } catch {} try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}  srv.kill(); fs.rmSync(state, { force: true }); }
  console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
